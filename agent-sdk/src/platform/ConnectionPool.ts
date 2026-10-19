/**
 * ConnectionPool — the agents this launcher process hosts.
 *
 * Holds N `AgentOptions` configs and connects every one of them at boot
 *. Each host long-polls its own inbox for the life of the process —
 * there is no agent socket. There is no subset, no cap and no lifecycle policy:
 * a write releasing that poll is the only signal anything needs.
 *
 * What this replaced: a launcher that registered 1000+ configs and connected
 * ~50, deciding which by long-polling `GET /inbox/operator` for a fleet-wide
 * sweep, sleeping quiet hosts on an idle timer, evicting past `maxActive` by
 * LRU, and exempting operator-named agents with a `pinned` flag. Whether an
 * agent was alive came down to a Terraform string, and nothing noticed when the
 * answer was "none of them".
 */
import { ConnectionManager } from '@ziggs-ai/api-client';
import { createAgent, type Agent, type AgentOptions } from '../Agent.js';
import { INBOX_STOP_TIMEOUT_MS } from './inboxLoop.js';
import { runtimeLog } from '../shared/runtimeLog.js';

// Inlined from api-client (not re-exported there). Sync if the upstream
// types change.
interface ConnectionManagerMeta {
  domain?: string;
  expertise?: string[];
  tags?: string[];
  [key: string]: unknown;
}

interface QueryFilter {
  domain?: string;
  expertise?: string[];
  tags?: string[];
}

export interface SendToOptions {
  timeoutMs?: number;
}

export class ConnectionPool {
  private readonly manager = new ConnectionManager();
  private readonly configs = new Map<string, AgentOptions>();
  // Live hosts, so shutdown can drain them. The manager hands its handles to
  // open/close callbacks and does not expose them, and re-reading one through
  // `startAgent` after a stop would reconnect the agent we are shutting down.
  private readonly hosts = new Map<string, Agent>();
  // How long a stopping host may spend acknowledging its pass in flight before
  // its lease is released anyway. `shutdown()` sets it to the caller's budget.
  private stopTimeoutMs = INBOX_STOP_TIMEOUT_MS;
  // Listeners enqueued by requestFrom — drained on outbound send-message effects.
  private readonly responseListeners = new Map<string, Array<(text: string) => void>>();

  /**
   * Register N agent configs. Nothing connects until `connectAll()`. A config
   * that cannot start is reported and left down; the others still host. Only
   * a launch where nobody came up is refused.
   */
  register(configs: AgentOptions[], metaArr: ConnectionManagerMeta[] = []): void {
    const metaByAgentId = new Map<string, ConnectionManagerMeta>();
    for (const m of metaArr) {
      const id = m['agentId'] as string | undefined;
      if (id) metaByAgentId.set(id, m);
    }
    for (const config of configs) {
      const agentId = config.agentId ?? config.workflow?.id;
      if (!agentId) {
        runtimeLog.warn('ConnectionPool', 'skipping config with no resolvable agentId');
        continue;
      }
      this.configs.set(agentId, config);
      this.manager.register(
        agentId,
        async () => {
          const cfg = this.configs.get(agentId)!;
          const originalTap = cfg.effectTap;
          const pool = this;
          const host = createAgent({
            ...cfg,
            effectTap(effect, response) {
              if (effect.kind === 'send-message') {
                const listeners = pool.responseListeners.get(agentId);
                if (listeners?.length) listeners.shift()!(effect.text ?? '');
              }
              originalTap?.(effect, response);
            },
          });
          await host.connectAsync();
          this.hosts.set(agentId, host);
          runtimeLog.debug('ConnectionPool', `connected "${agentId}"`);
          return host;
        },
        async (host) => {
          // Resolves once the host's lease is released, so a replacement
          // started next cannot share the inbox with a host still acking.
          await (host as Agent).disconnect(this.stopTimeoutMs);
          this.hosts.delete(agentId);
          runtimeLog.debug('ConnectionPool', `disconnected "${agentId}"`);
        },
        metaByAgentId.get(agentId),
      );
    }
  }

  /**
   * Connect every registered agent. One host that cannot come up is reported
   * and does not take the rest down — a fleet where 28 of 29 are live is not
   * a launch worth aborting. Zero started is: the process has nothing to
   * host and must restart.
   */
  async connectAll(): Promise<void> {
    await this.manager.connectAll();
    const connected = this.listActive().length;
    if (this.size === 0) return;
    if (connected === 0) {
      throw new Error(`0/${this.size} agents started; process must restart`);
    }
    if (connected !== this.size) {
      runtimeLog.warn(
        'ConnectionPool',
        `Only ${connected}/${this.size} agents started — hosting the ones that came up. One host must not take the rest down.`,
      );
    }
  }

  /** The host for one agent, connecting it if it somehow is not up yet. */
  async startAgent(agentId: string): Promise<Agent> {
    return await this.manager.startAgent(agentId) as Agent;
  }

  async stopAgent(agentId: string): Promise<void> {
    return this.manager.stopAgent(agentId);
  }

  async disconnectAll(): Promise<void> {
    return this.manager.stopAll();
  }

  /**
   * Shut the fleet down without abandoning work: stop taking new deliveries
   * everywhere, THEN wait for in-flight turns to finish.
   *
   * The order is the whole point. Draining one agent while the others still
   * long-poll leaves a window — as long as the drain — in which a host that is
   * on its way out keeps accepting new work. On a rolling deploy the replacement
   * is already live and polling the same inboxes, so that window is where one
   * delivery gets handled twice: two hosts, one request, two answers.
   *
   * `disconnect()` stops the inbox loop and timers, lets the pass in flight
   * acknowledge what it finished, and releases the host lease — all inside
   * the bound; in-flight ticks live in each host's event queue, which is what
   * `drain()` waits on. One budget covers both, so a fleet on a 120s stop
   * clock is not asked to wait twice.
   *
   * A host that cannot finish inside `timeoutMs` is left behind rather than
   * holding up the rest — the caller is on a shutdown clock of its own. Its
   * lease is released regardless, so the replacement can host at once.
   */
  async shutdown(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const hosts = [...this.hosts.values()];
    this.stopTimeoutMs = timeoutMs;
    await this.manager.stopAll();
    await Promise.all(
      hosts.map(async (host) => {
        try {
          const result = await host.drain(Math.max(0, deadline - Date.now()));
          if (result?.timedOut) {
            runtimeLog.warn(
              'ConnectionPool',
              `drain timed out after ${timeoutMs}ms: ${result.queuedEvents} event(s) queued, ${result.busyLanes.length} busy lane(s)`,
            );
          }
        } catch (err: unknown) {
          runtimeLog.warn(
            'ConnectionPool',
            `drain did not finish: ${(err as Error).message}`,
          );
        }
      }),
    );
  }

  /**
   * Deliver a message to the named agent and wait for its first outbound
   * `send-message` effect — i.e. the agent's reply. Returns the reply text.
   *
   * The effectTap injected in `register` drains a per-agent listener queue;
   * this method enqueues one resolver and awaits it. Times out if the agent
   * does not reply within `timeoutMs` (default 60 s for LLM agents).
   */
  async requestFrom(agentId: string, text: string, metadata: Record<string, unknown> = {}, { timeoutMs = 60_000 }: SendToOptions = {}): Promise<string> {
    const host = await this.startAgent(agentId);
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const ls = this.responseListeners.get(agentId);
        if (ls) { const i = ls.indexOf(listener); if (i !== -1) ls.splice(i, 1); }
        reject(new Error(`requestFrom timeout for "${agentId}" after ${timeoutMs}ms`));
      }, timeoutMs);
      const listener = (responseText: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(responseText);
      };
      const ls = this.responseListeners.get(agentId) ?? [];
      ls.push(listener);
      this.responseListeners.set(agentId, ls);
      host.handleMessage(text, metadata).catch((err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const ls2 = this.responseListeners.get(agentId);
        if (ls2) { const i = ls2.indexOf(listener); if (i !== -1) ls2.splice(i, 1); }
        reject(err);
      });
    });
  }

  /**
   * Deliver one wire frame to the named agent. Returns once the host has
   * finished processing.
   *
   * Note: does not return the agent's response. For request/response
   * semantics use `requestFrom`.
   */
  async sendTo(agentId: string, text: string, metadata: Record<string, unknown> = {}, { timeoutMs = 30_000 }: SendToOptions = {}): Promise<null> {
    const host = await this.startAgent(agentId);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`sendTo timeout for "${agentId}" after ${timeoutMs}ms`)), timeoutMs),
    );
    await Promise.race([host.handleMessage(text, metadata), timeoutPromise]);
    return null;
  }

  query(filter: QueryFilter): string[] { return this.manager.query(filter); }
  list(): string[] { return this.manager.list(); }
  listActive(): string[] { return this.manager.listActive(); }
  /**
   * Inbox liveness for every live agent in this process. The runner's health
   * route answers from this rather than from "the HTTP server replied", which
   * a wedged process does happily while none of its agents read anything.
   */
  liveness(): ReturnType<Agent['inboxLiveness']>[] {
    return [...this.hosts.values()].map((host) => host.inboxLiveness());
  }
  get size(): number { return this.manager.size; }
  getMeta(id: string): ConnectionManagerMeta | undefined { return this.manager.getMeta(id); }
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Agent } from '../Agent.js';
import type { ConnectionPool } from '../platform/ConnectionPool.js';
import { runtimeLog } from '../shared/runtimeLog.js';

/** What one agent reports about its own inbox reading. */
export type AgentLiveness = ReturnType<Agent['inboxLiveness']>;

/**
 * How long an agent's inbox loop may go without turning before this process is
 * called unhealthy. An idle loop completes a pass every `DEFAULT_WAIT_SECONDS`
 * (110s), so this is three missed cycles plus slack: long enough that a slow
 * server or a long turn never flaps, short enough that a wedged process is
 * replaced within minutes.
 */
const STALE_MS = Number(process.env.FLEET_INBOX_STALE_MS) || 360_000;

function age(now: number, at: number | null): number | null {
  return at === null ? null : now - at;
}

/**
 * The health verdict. A process is alive when its agents are still reading,
 * so the answer is derived from the inbox loop rather than from the fact that
 * this HTTP server replied — a wedged process replies happily while none of
 * its agents read anything.
 *
 * The restart decision reads `lastAttemptAt`, not `lastPassAt`. When the
 * backend is down every pass fails while the loops are perfectly healthy, and
 * restarting the fleet would fix nothing and lose in-flight turns. Read
 * staleness is still reported per agent, for the store and for monitoring.
 */
export function inboxHealth(rows: AgentLiveness[], now = Date.now(), staleMs = STALE_MS): {
  ok: boolean;
  reason?: string;
  staleMs: number;
  watching: number;
  oldestAttemptAgeMs: number | null;
  oldestPassAgeMs: number | null;
  agents: (AgentLiveness & { passAgeMs: number | null; attemptAgeMs: number | null })[];
} {
  const agents = rows.map((r) => ({
    ...r,
    passAgeMs: age(now, r.lastPassAt),
    attemptAgeMs: age(now, r.lastAttemptAt),
  }));
  // Only agents that are supposed to be polling can be stale. A connected
  // agent with the inbox loop off (lab and eval paths) has nothing to report,
  // and an agent that was deliberately stopped is not this process failing.
  const watched = agents.filter((r) => r.pollingInbox && r.connected);
  const turning = watched.filter((r) => r.attemptAgeMs !== null && r.attemptAgeMs <= staleMs);
  const ages = watched.map((r) => r.attemptAgeMs).filter((n): n is number => n !== null);
  const passAges = watched.map((r) => r.passAgeMs).filter((n): n is number => n !== null);
  const ok = watched.length === 0 || turning.length > 0;
  return {
    ok,
    ...(ok ? {} : { reason: `no inbox pass attempted by any of ${watched.length} agent(s) within ${staleMs}ms` }),
    staleMs,
    watching: watched.length,
    oldestAttemptAgeMs: ages.length ? Math.max(...ages) : null,
    oldestPassAgeMs: passAges.length ? Math.max(...passAges) : null,
    agents,
  };
}

export type HealthRequest = {
  req: IncomingMessage;
  res: ServerResponse;
  pool?: ConnectionPool;
};

/**
 * A route the embedding process adds. Return true once the response is sent.
 * The health page itself only answers `/` and `/health`.
 */
export type HealthRequestHandler = (call: HealthRequest) => Promise<boolean>;

export function createHealthServer({
  port = Number(process.env.PORT) || 8080,
  label = 'agents',
  pool,
  liveness,
  onRequest,
}: {
  port?: number;
  label?: string;
  pool?: ConnectionPool;
  /**
   * Every agent this process is responsible for. Omit only when there is
   * nothing to watch: without it `/health` can say no more than "this server
   * replied", which is the answer this route exists to stop giving.
   */
  liveness?: () => AgentLiveness[];
  onRequest?: HealthRequestHandler;
} = {}): Server {
  const server = createServer(async (req, res) => {
    if (await onRequest?.({ req, res, pool })) return;
    const url = req.url ?? '/';
    if (url === '/health' || url === '/') {
      const report = inboxHealth(liveness?.() ?? []);
      if (!report.ok) {
        runtimeLog.warn(label, `health: ${report.reason}`);
      }
      res.writeHead(report.ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => runtimeLog.info(label, `health server on port ${port}`));
  return server;
}

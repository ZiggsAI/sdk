import { createAgent, type Agent, type AgentOptions } from '../Agent.js';
import { ConnectionPool } from '../platform/ConnectionPool.js';
import { boundKeyFleetWarning } from '../shared/operatorKeyClaims.js';
import { runtimeLog } from '../shared/runtimeLog.js';
import { createHealthServer, type AgentLiveness, type HealthRequestHandler } from './createHealthServer.js';
import type { Server } from 'node:http';

const DRAIN_TIMEOUT_MS = Number(process.env.FLEET_DRAIN_TIMEOUT_MS) || 90_000;

/** Process concerns only. Every Agent owns its inbox and external polls. */
export interface RunnerOptions {
  operatorKey?: string;
  label?: string;
  port?: number | string;
  healthServer?: boolean;
  /** Disable when the embedding process owns its signal handlers. */
  handleSignals?: boolean;
  drainTimeoutMs?: number;
  onShutdown?: () => Promise<void>;
  agentMeta?: Record<string, unknown>[];
  primary?: AgentOptions | ((pool: ConnectionPool) => AgentOptions);
  /** A route this process adds. The health page itself only answers `/` and `/health`. */
  onRequest?: HealthRequestHandler;
}

export interface SingleAgentRun {
  agent: Agent;
  healthServer?: Server;
  shutdown(): Promise<void>;
}

export interface FleetRun {
  pool: ConnectionPool;
  primary: Agent | null;
  healthServer?: Server;
  shutdown(): Promise<void>;
}

function shutdownHandler(
  stop: () => Promise<void>,
  server: Server | undefined,
  options: RunnerOptions,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  const shutdown = () => {
    if (!pending) {
      process.off('SIGTERM', signal);
      process.off('SIGINT', signal);
      pending = (async () => {
        try {
          await stop();
          await options.onShutdown?.();
        } finally {
          if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      })();
    }
    return pending;
  };
  const signal = () => {
    runtimeLog.info(options.label || 'runner', 'Shutting down');
    void shutdown().then(
      () => process.exit(0),
      (err) => {
        runtimeLog.error(options.label || 'runner', `Shutdown failed: ${(err as Error).message}`);
        process.exit(1);
      },
    );
  };
  if (options.handleSignals !== false) {
    process.on('SIGTERM', signal);
    process.on('SIGINT', signal);
  }
  return shutdown;
}

async function healthServer(
  options: RunnerOptions,
  liveness: () => AgentLiveness[],
  pool?: ConnectionPool,
): Promise<Server | undefined> {
  if (options.healthServer === false) return undefined;
  const server = createHealthServer({
    port: Number(options.port ?? process.env.PORT ?? 8080),
    label: options.label || 'runner',
    pool,
    liveness,
    onRequest: options.onRequest,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => { server.off('error', reject); resolve(); });
  });
  return server;
}

export function runAgents(config: AgentOptions, options?: RunnerOptions): Promise<SingleAgentRun>;
export function runAgents(configs: AgentOptions[], options?: RunnerOptions): Promise<FleetRun>;
export async function runAgents(
  configOrConfigs: AgentOptions | AgentOptions[],
  options: RunnerOptions = {},
): Promise<SingleAgentRun | FleetRun> {
  const effectiveKey = options.operatorKey ?? process.env.ZIGGS_OPERATOR_KEY;
  const decorate = (config: AgentOptions): AgentOptions =>
    effectiveKey && !config.operatorKey ? { ...config, operatorKey: effectiveKey } : config;
  const drainTimeout = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;

  if (!Array.isArray(configOrConfigs)) {
    const agent = createAgent(decorate(configOrConfigs));
    let server: Server | undefined;
    // One budget for stopping intake and finishing in-flight work: the inbox
    // pass gets up to the whole of it to acknowledge, the queue what is left.
    const stop = async () => {
      const deadline = Date.now() + drainTimeout;
      await agent.disconnect(drainTimeout);
      await agent.drain(Math.max(0, deadline - Date.now()));
    };
    try {
      await agent.connectAsync();
      server = await healthServer(options, () => [agent.inboxLiveness()]);
    } catch (err) {
      await stop();
      throw err;
    }
    const shutdown = shutdownHandler(stop, server, options);
    return { agent, healthServer: server, shutdown };
  }

  const pool = new ConnectionPool();
  const configs = configOrConfigs.map(decorate);
  pool.register(configs, options.agentMeta);
  const primaryConfig = typeof options.primary === 'function' ? options.primary(pool) : options.primary;
  let primary: Agent | null = null;
  let server: Server | undefined;
  // Same single budget as the one-agent path, shared by the pool and the primary.
  const stop = async () => {
    const deadline = Date.now() + drainTimeout;
    await Promise.all([primary?.disconnect(drainTimeout), pool.shutdown(drainTimeout)]);
    await primary?.drain(Math.max(0, deadline - Date.now()));
  };
  try {
    if (primaryConfig) primary = createAgent(decorate(primaryConfig));
    const controlKey = effectiveKey ?? configs.find(c => c.operatorKey)?.operatorKey ?? primary?.options.operatorKey;
    if (controlKey) {
      const warning = boundKeyFleetWarning(controlKey, pool.size + (primary ? 1 : 0));
      if (warning) runtimeLog.warn(options.label || 'runner', warning);
    }
    await primary?.connectAsync();
    await pool.connectAll();
    const connected = pool.listActive().length;
    if (configs.length > 0 && connected === 0) {
      throw new Error(`0/${configs.length} agents started; process must restart`);
    }
    if (connected !== pool.size || pool.size !== configs.length) {
      runtimeLog.warn(
        options.label || 'runner',
        `Only ${connected}/${configs.length} agents started — hosting the ones that came up`,
      );
    }
    server = await healthServer(
      options,
      () => [...(primary ? [primary.inboxLiveness()] : []), ...pool.liveness()],
      pool,
    );
    runtimeLog.info(options.label || 'runner', `Ready — ${connected}/${pool.size} agents started`);
  } catch (err) {
    await stop();
    throw err;
  }
  const shutdown = shutdownHandler(stop, server, options);
  return { pool, primary, healthServer: server, shutdown };
}

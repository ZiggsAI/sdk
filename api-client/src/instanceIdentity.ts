import { decodeOperatorKeyClaims } from './shared/operatorKey.js';

/**
 * Which HOST is calling `GET /inbox` and `POST /inbox/ack`.
 *
 * `X-Ziggs-Instance` decides inbox ownership: the first host to read acquires
 * an agent's whole inbox, a second host is refused with
 * `409 INBOX_HOST_CONFLICT` until the owner has stopped renewing for 220
 * seconds, and an ack renews an owner but never acquires. A missing or
 * overlong value is `400 INBOX_HOST_REQUIRED`.
 *
 * So the value has to be stable for as long as a rail is one logical host, and
 * distinct between rails that are not. What each rail sends:
 *
 * | rail                                   | identity              |
 * | -------------------------------------- | --------------------- |
 * | fleet task on Fargate                  | `ecs:<task id>`       |
 * | any other long-lived process, stdio MCP included | `local:<host>:<pid>` |
 * | `ziggs-cli`                            | `cli:<host>:<user>`   |
 * | the hosted MCP server, per connection  | `mcp:<keyId>`         |
 * | anything a scheduler pins              | `ZIGGS_INSTANCE_ID`   |
 *
 * A process identity is right for a host that outlives its inbox reads and
 * wrong for one that does not. `ziggs-cli` is a new process per command, so
 * pid would refuse its own `--ack`; a cron that respawns
 * `npx @ziggs-ai/ziggs-mcp` every minute is a new host every minute, which is
 * what `ZIGGS_INSTANCE_ID` is for.
 *
 * `ZIGGS_INSTANCE_ID` beats the process default wherever it is read. It is NOT
 * read on the hosted rail: that one process serves every connected assistant,
 * and a single env var would collapse them back into the one host this exists
 * to separate.
 */

let cached: string | null = null;

/** The backend refuses anything longer; it truncates nothing itself. */
export const INSTANCE_IDENTITY_MAX_LENGTH = 64;

export const INBOX_HOST_CLAIMANT_HEADER = 'X-Ziggs-Instance';

/** This process: `ZIGGS_INSTANCE_ID`, else `ecs:<id>`, else `local:<host>:<pid>`. */
export function instanceIdentity(): string {
  if (cached) return cached;
  cached = fit(resolve());
  return cached;
}

/** Test seam: forget the memoized value so a case can set different env. */
export function resetInstanceIdentityForTests(): void {
  cached = null;
}

/**
 * The identity to send: a rail's own choice when it has one, this process
 * otherwise. Every caller-supplied value goes through the same length rule, so
 * no rail can put the header over the limit the backend enforces.
 */
export function hostIdentity(preferred?: string): string {
  const chosen = preferred?.trim();
  return chosen ? fit(chosen) : instanceIdentity();
}

/**
 * `ziggs-cli`: one identity per machine and user.
 *
 * Every command is its own process, so pid would make `ziggs inbox --ack` a
 * host that never read the inbox — refused, always — and a second
 * `ziggs inbox` inside the lease window a second host. A person at one
 * terminal is one host; consecutive commands share this.
 */
export function cliHostIdentity(): string {
  const pinned = process.env.ZIGGS_INSTANCE_ID?.trim();
  return fit(pinned || `cli:${hostLabel()}:${safeUsername()}`);
}

/**
 * The hosted MCP server: one identity per CONNECTION, off the key it serves.
 *
 * Not the backend task's identity. That process serves every connected
 * assistant at once, so its own identity makes them one host and changes under
 * all of them on every deploy — a hosted read answering 409 for up to 220
 * seconds after each restart, and replicas refusing each other's agents.
 *
 * The key survives both. A token refresh re-signs the same `keyId`, so an
 * assistant keeps its inbox across a backend restart and across its own
 * refresh, and two assistants holding different keys are two hosts, which is
 * what the ownership law says they are.
 *
 * Undefined when the credential carries no `keyId`. Every operator token the
 * backend mints has one, so this is the shape of a credential that cannot name
 * a stable host at all; the caller falls back to the process default rather
 * than send one value every such connection would share.
 */
export function mcpConnectionIdentity(operatorKey: string): string | undefined {
  const keyId = decodeOperatorKeyClaims(operatorKey)?.keyId?.trim();
  return keyId ? fit(`mcp:${keyId}`) : undefined;
}

function resolve(): string {
  const pinned = process.env.ZIGGS_INSTANCE_ID?.trim();
  if (pinned) return pinned;
  const metadataUri =
    process.env.ECS_CONTAINER_METADATA_URI_V4 ??
    process.env.ECS_CONTAINER_METADATA_URI;
  if (metadataUri) {
    const id = metadataUri.split('/').filter(Boolean).pop() ?? '';
    const short = id.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    if (short.length >= 8) return `ecs:${short}`;
  }
  return `local:${hostLabel()}:${process.pid}`;
}

/**
 * Keep an overlong identity unique.
 *
 * Plain truncation is what the backend stopped doing on purpose: two long
 * values cut to one is exactly the collision the header exists to prevent. A
 * readable head plus a hash of the whole stays inside the limit and stays
 * distinct.
 */
function fit(value: string): string {
  if (value.length <= INSTANCE_IDENTITY_MAX_LENGTH) return value;
  const head = value.slice(0, INSTANCE_IDENTITY_MAX_LENGTH - 9);
  return `${head}:${fnv1a(value)}`;
}

/** FNV-1a/32 in hex. Distinguishes hosts; it is not a checksum for anything. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function hostLabel(): string {
  return process.env.HOSTNAME || safeHostname();
}

function safeHostname(): string {
  return builtinOs<{ hostname?: () => string }>()?.hostname?.() || 'unknown-host';
}

function safeUsername(): string {
  const fromEnv = process.env.USER || process.env.USERNAME;
  if (fromEnv) return fromEnv;
  return (
    builtinOs<{ userInfo?: () => { username?: string } }>()?.userInfo?.()
      ?.username || 'unknown-user'
  );
}

/**
 * Reached for at call time, not imported at the top of the file. A static
 * `node:os` specifier makes this module — and through the inbox client, the
 * package entry — unresolvable to a bundler with no node builtins, which is
 * every mobile bundler. Nothing here needs the host name in order to load.
 *
 * `getBuiltinModule` arrived in Node 20.16 / 22.3. On anything older the
 * labels fall back to their `unknown-` forms, which costs a readable name on a
 * dev machine and nothing in a deployed task: those resolve through the
 * container metadata path above.
 */
function builtinOs<T>(): T | undefined {
  try {
    const load = (process as { getBuiltinModule?: (id: string) => unknown })
      .getBuiltinModule;
    return load?.('node:os') as T | undefined;
  } catch {
    return undefined;
  }
}

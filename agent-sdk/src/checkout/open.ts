import { randomBytes } from 'node:crypto';
import type { ConnectionWithGrants } from '@ziggs-ai/api-client';
import { CheckoutBoxClient, doorHeaders, type GitDoorTarget } from './boxClient.js';
import { checkoutBranchForTask, checkoutTargetFromTask } from './intake.js';
import type { CheckoutSession } from './tools.js';
import type { CheckoutBox, CheckoutProvider } from './types.js';
import { isCheckoutNeed, unmetNeedsMessage, type AgentNeed } from '../tools/needs.js';

/** A box that is open for one wake, and when it started, for the cost line. */
export interface OpenCheckout {
  session: CheckoutSession;
  box: CheckoutBox;
  startedAt: number;
}

export interface OpenCheckoutDeps {
  provider: CheckoutProvider | undefined;
  needs: AgentNeed[];
  /** The task this wake is for; no task, no checkout. */
  taskId: string | undefined;
  getTask(taskId: string): Promise<{ title?: string | null; description?: string | null }>;
  /** The agent's live connection grants, grouped by connection. */
  listConnections(): Promise<ConnectionWithGrants[]>;
  door: Pick<GitDoorTarget, 'backendUrl' | 'operatorKey' | 'agentId' | 'laneId'>;
  /** Close the task with the reason, the way the needs gate does. */
  failTask(taskId: string, reason: string): Promise<void>;
  log: (message: string) => void;
  fetchFn?: typeof fetch;
  /** Hard cap for the box, seconds. Default one hour. */
  ttlSeconds?: number;
  /** How long to wait for the box to answer. Default five minutes. */
  readyTimeoutMs?: number;
}

/** Connection providers whose grant can back a checkout. */
function canBackCheckout(provider: string | null | undefined): boolean {
  const p = String(provider ?? '').split('—')[0].trim().toLowerCase();
  return p === 'github' || p === 'mcp';
}

/**
 * Open the checkout a wake needs, or refuse the task by name.
 *
 * Returns null when this wake needs no checkout (the agent declares none, or
 * the wake carries no task), `'refused'` when the task was failed here with
 * the reason, and the open box otherwise. The caller destroys the box when
 * the wake ends ({@link closeCheckout}).
 */
export async function openCheckout(deps: OpenCheckoutDeps): Promise<OpenCheckout | null | 'refused'> {
  if (!deps.needs.some(isCheckoutNeed)) return null;
  const taskId = deps.taskId;
  if (!taskId) return null;
  const fetchFn = deps.fetchFn ?? fetch;

  const refuse = async (reason: string): Promise<'refused'> => {
    deps.log(`refusing task ${taskId} — ${reason}`);
    try {
      await deps.failTask(taskId, reason);
    } catch (err) {
      deps.log(`could not fail task ${taskId}: ${(err as Error).message}`);
    }
    return 'refused';
  };

  let task: { title?: string | null; description?: string | null };
  try {
    task = await deps.getTask(taskId);
  } catch (err) {
    deps.log(`checkout skipped: task ${taskId} could not be read: ${(err as Error).message}`);
    return null;
  }
  const target = checkoutTargetFromTask(task);
  if (!target) {
    return refuse(
      'Cannot start this task: it names no repository. Name it as owner/name (a GitHub URL also works), and the base branch if it is not the default branch.',
    );
  }
  if (!deps.provider) {
    return refuse(
      `Cannot start this task: it needs a checkout of ${target.repository} and this host provides none.`,
    );
  }

  let groups: ConnectionWithGrants[];
  try {
    groups = await deps.listConnections();
  } catch (err) {
    return refuse(`Cannot start this task: the connection grants could not be read (${(err as Error).message}).`);
  }
  const candidates = groups.filter((g) => (g.grants ?? []).length > 0 && canBackCheckout(g.provider));
  if (!candidates.length) return refuse(unmetNeedsMessage([{ checkout: 'git' }]));

  // The grant that can actually see the repository: asked of the door, which
  // answers for the connection it fronts. A grant on another MCP server, or a
  // GitHub account that cannot see this repository, is named rather than tried.
  let door: GitDoorTarget | null = null;
  const tried: string[] = [];
  for (const group of candidates) {
    const grantId = String((group.grants ?? [])[0]?.grantId ?? '');
    if (!grantId) continue;
    const candidate: GitDoorTarget = {
      ...deps.door,
      connectionId: group.connectionId,
      grantId,
      taskId,
      repository: { owner: target.owner, name: target.name },
    };
    try {
      const probe = await fetchFn(
        `${deps.door.backendUrl}/connections/${encodeURIComponent(group.connectionId)}/git/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/info/refs?service=git-upload-pack`,
        { headers: doorHeaders(candidate, {}), signal: AbortSignal.timeout(30_000) },
      );
      const text = await probe.text();
      if (probe.ok) {
        door = candidate;
        break;
      }
      tried.push(`${group.connectionId}: ${probe.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    } catch (err) {
      tried.push(`${group.connectionId}: ${(err as Error).message}`);
    }
  }
  if (!door) {
    return refuse(
      `Cannot start this task: no GitHub connection grant on this hire can read ${target.repository} (${tried.join('; ')}). ` +
        'Ask the connection owner to grant a GitHub connection that can see the repository, then re-assign the task.',
    );
  }

  const branch = checkoutBranchForTask(taskId);
  const secret = randomBytes(32).toString('hex');
  const startedAt = Date.now();
  let box: CheckoutBox;
  try {
    box = await deps.provider.start({
      secret,
      ttlSeconds: deps.ttlSeconds ?? 3600,
      label: { agentId: deps.door.agentId, taskId, repository: target.repository },
    });
  } catch (err) {
    return refuse(`Cannot start this task: the host could not start a box for the checkout (${(err as Error).message}).`);
  }
  const client = new CheckoutBoxClient(box.endpoint, fetchFn);
  try {
    await client.waitReady(deps.readyTimeoutMs ?? 5 * 60_000);
    client.startRelay(door);
    const ready = await client.setup({ repository: target.repository, baseBranch: target.baseBranch, branch });
    deps.log(
      `checkout open: ${target.repository} at ${ready.baseBranch} (${ready.head.slice(0, 10)}) on ${branch}` +
        `${ready.resumed ? ', continuing the branch an earlier wake pushed' : ''}, ${box.kind} box`,
    );
    return {
      box,
      startedAt,
      session: {
        client,
        target,
        baseBranch: ready.baseBranch,
        branch,
        taskId,
        boxKind: box.kind,
      },
    };
  } catch (err) {
    await client.stopRelay();
    await box.stop();
    return refuse(`Cannot start this task: could not open a checkout of ${target.repository} (${(err as Error).message}).`);
  }
}

/** Destroy the box. Returns how long it lived, for the cost line. */
export async function closeCheckout(open: OpenCheckout): Promise<{ kind: string; seconds: number; vcpu?: number; memoryMb?: number }> {
  await open.session.client.stop();
  await open.session.client.stopRelay();
  await open.box.stop();
  return {
    kind: open.box.kind,
    seconds: Math.max(1, Math.round((Date.now() - open.startedAt) / 1000)),
    ...(open.box.resources?.vcpu !== undefined ? { vcpu: open.box.resources.vcpu } : {}),
    ...(open.box.resources?.memoryMb !== undefined ? { memoryMb: open.box.resources.memoryMb } : {}),
  };
}

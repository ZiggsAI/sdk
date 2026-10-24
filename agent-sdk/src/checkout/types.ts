/**
 * The checkout need, host side.
 *
 * An agent declares `{ checkout: 'git' }`; whoever hosts it provides a box. A
 * box is a throwaway isolated unit (its own container) that holds a clone of
 * the task's repository and nothing of the host's: no host environment, no
 * credentials, no network into the host's services. The host talks to it over
 * one narrow channel (read a file, write a file, run a command, push the
 * branch) and the box's git traffic comes back over that same channel, so the
 * box never holds a credential at all.
 */

/** Where the host finds a box it started. */
export interface CheckoutBoxEndpoint {
  /** Base URL of the box's channel, e.g. `http://10.0.11.4:7777`. */
  url: string;
  /** Per-box bearer the host minted and passed into the box at start. */
  secret: string;
}

export interface CheckoutBoxSpec {
  /** Per-box channel secret, minted by the SDK; the provider passes it in as `BOX_SECRET`. */
  secret: string;
  /** Hard time cap for the box, in seconds; the box exits when it is reached. */
  ttlSeconds: number;
  /** For logs and task tags; never a credential. */
  label: { agentId: string; taskId: string; repository: string };
}

export interface CheckoutBox {
  endpoint: CheckoutBoxEndpoint;
  /** What kind of unit this is, for the cost line (`fargate`, `sandbox`, ...). */
  kind: string;
  /** The box's size, when the provider knows it, for the cost line. */
  resources?: { vcpu?: number; memoryMb?: number };
  /** Destroy the box. Idempotent; never throws. */
  stop(): Promise<void>;
}

/**
 * Whoever hosts the agent implements this: the fleet starts a Fargate task,
 * a lab starts a confined local process, a person's own runner could hand out
 * a container of its own. The SDK never knows which.
 */
/** Host-owned private storage, keyed by agent, hire lane, task, repository and base. */
export interface CheckoutCheckpointStore {
  load(key: string): Promise<Uint8Array | null>;
  save(key: string, data: Uint8Array): Promise<void>;
}

export interface CheckoutProvider {
  /** Optional. Without storage, later wakes resume only the pushed task branch. */
  checkpoints?: CheckoutCheckpointStore;
  start(spec: CheckoutBoxSpec): Promise<CheckoutBox>;
}

/** What a task has to name for a checkout to exist. */
export interface CheckoutTarget {
  /** `owner/name` on GitHub. */
  repository: string;
  owner: string;
  name: string;
  /** Named by the task, or null to use the repository's default branch. */
  baseBranch: string | null;
}

/** How a command ran in the box. */
export interface CheckoutRunResult {
  checkpointWarning?: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface CheckoutPushResult {
  checkpointWarning?: string;
  branch: string;
  commit: string | null;
  filesChanged: string[];
  pushed: boolean;
  /** Every command the brain ran in this box, with its exit code, for the pull request body. */
  ran: Array<{ command: string; exitCode: number | null }>;
}

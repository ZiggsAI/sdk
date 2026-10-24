import { defineTool, type ToolDefinition } from '../tools/defineTool.js';
import type { CheckoutBoxClient } from './boxClient.js';
import type { CheckoutTarget } from './types.js';

/**
 * What one wake holds once its checkout is open: the box, the repository it
 * cloned, the branch its change lands on. Put on the tool context by the host
 * for the wake, taken off it when the box is destroyed.
 */
export interface CheckoutSession {
  client: CheckoutBoxClient;
  target: CheckoutTarget;
  /** The base branch actually checked out (the task's, or the default branch). */
  baseBranch: string;
  /** `agent/<task id>`: the only branch the way out pushes to. */
  branch: string;
  taskId: string;
  /** The box's kind, for the pull request body and the cost line. */
  boxKind: string;
}

function sessionOf(ctx: Record<string, unknown>, tool: string): CheckoutSession {
  const session = ctx['checkout'] as CheckoutSession | undefined;
  if (!session?.client) {
    throw new Error(
      `${tool}: no checkout is open on this wake. A checkout opens when a task assigned to you names a repository (owner/name); this wake carries none.`,
    );
  }
  return session;
}

const CHECKOUT_LOCATION = 'Paths are relative to the root of the checkout, which is the repository the task named, cloned at its base branch.';

export const checkoutReadTool: ToolDefinition = defineTool(
  'checkout_read',
  {
    path: { type: 'string', required: true, description: 'File to read, relative to the checkout root.' },
  },
  async (args, ctx) => {
    const s = sessionOf(ctx, 'checkout_read');
    return s.client.read(String(args.path));
  },
  { description: `Read one file from the checkout. ${CHECKOUT_LOCATION} Large files come back truncated with truncated=true; read a narrower file or use checkout_run with sed to read a range.` },
);

export const checkoutWriteTool: ToolDefinition = defineTool(
  'checkout_write',
  {
    path: { type: 'string', required: true, description: 'File to write, relative to the checkout root. Folders are created as needed.' },
    content: { type: 'string', required: true, description: 'The complete new content of the file.' },
  },
  async (args, ctx) => {
    const s = sessionOf(ctx, 'checkout_write');
    return s.client.write(String(args.path), String(args.content));
  },
  { description: `Write one whole file in the checkout, creating or replacing it. ${CHECKOUT_LOCATION} Write complete files, never placeholders.` },
);

export const checkoutRunTool: ToolDefinition = defineTool(
  'checkout_run',
  {
    command: { type: 'string', required: true, description: 'A shell command, run from the checkout root inside the box (e.g. "npm ci", "npm test", "grep -rn Foo src", "git status").' },
    timeoutSeconds: { type: 'number', description: 'Give up after this many seconds (default 600, max 1800).' },
  },
  async (args, ctx) => {
    const s = sessionOf(ctx, 'checkout_run');
    return s.client.run(String(args.command), args.timeoutSeconds != null ? Number(args.timeoutSeconds) : undefined);
  },
  { description: `Run a shell command in the checkout and get its exit code, stdout and stderr (tails, capped). Use it to search the code, install dependencies, and run the build or tests the repository defines before you push. ${CHECKOUT_LOCATION} The box has no credentials and no network into Ziggs; package registries are reachable.` },
);

export const checkoutPushTool: ToolDefinition = defineTool(
  'checkout_push',
  {
    message: { type: 'string', required: true, description: 'One-line commit message saying what changed.' },
  },
  async (args, ctx) => {
    const s = sessionOf(ctx, 'checkout_push');
    const result = await s.client.push(String(args.message));
    const agreementId =
      (ctx['serviceAgreementId'] as string | undefined) ??
      (ctx['wakeAgreementId'] as string | undefined) ??
      (ctx['onBehalfOfAgreementId'] as string | undefined) ??
      null;
    const ran = result.ran.length
      ? result.ran.map((r) => `\`${r.command}\` (exit ${r.exitCode ?? 'killed'})`).join(', ')
      : 'nothing';
    return {
      ...result,
      baseBranch: s.baseBranch,
      repository: s.target.repository,
      pullRequest: {
        head: result.branch,
        base: s.baseBranch,
        draft: true,
        /** Paste these lines into the pull request body, verbatim. */
        bodyLines: [
          `Opened by a Ziggs agent${agreementId ? ` under hire ${agreementId}` : ''}, task ${s.taskId}.`,
          `Ran in the checkout (${s.boxKind} box): ${ran}.`,
        ],
      },
    };
  },
  {
    description:
      'Commit every change in the checkout as one commit and push it to the task\'s branch agent/<task id>. Never the base branch. Returns the branch, the commit, the files changed, what was run, and the lines to put in the pull request body. Call it once, after the build or tests you ran pass or you have decided to say they did not; then open the draft pull request with your GitHub tool.',
  },
);

export const CHECKOUT_TOOLS: ToolDefinition[] = [
  checkoutReadTool,
  checkoutWriteTool,
  checkoutRunTool,
  checkoutPushTool,
];

/**
 * Shared Claude-Agent-SDK cognition pieces.
 *
 * Everything a Claude-brain agent needs to turn a Ziggs wake into a `query()`
 * call, EXCEPT the loop itself. `ClaudeBrain` owns the loop (drive `query()`,
 * collect metrics); this module owns the periphery so it lives in one place and
 * is unit-testable without spinning up the SDK.
 *
 * The lockdown option set (`tools: []`, `strictMcpConfig`, `settingSources: []`,
 * bypass permissions, no local settings) is a security boundary, not a default —
 * it MUST be applied on every Claude-brain wake. Centralizing it here means a
 * caller cannot silently drift from it.
 */
import { SERVER_EVENTS } from '@ziggs-ai/contracts';
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type Options,
  type SDKAssistantMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { decisionWords } from '@ziggs-ai/api-client';
import type { RawEvent } from '../runtime/buildOutcome.js';
import { getBatchEvents } from '../context/batch.js';
import { DEFAULT_MODEL } from '../shared/fleetModel.js';

export interface ClaudeQueryOptionsParams {
  /**
   * The system prompt in cache-ordered blocks: the shared protocol first, then
   * this agent's role. Both are stable across wakes — see
   * {@link claudeQueryOptions} for why that matters.
   */
  systemPrompt: string[];
  /** Claude model id for the brain. */
  model: string;
  /** In-process MCP servers exposing the agent's tools (e.g. `{ ziggs }`). */
  mcpServers: NonNullable<Options['mcpServers']>;
  /** Max agentic turns per wake. */
  maxTurns: number;
  /** Working dir for the query subprocess. Defaults to `$CLAUDE_SDK_CWD` or `/tmp`. */
  cwd?: string;
  /** stderr sink for the query subprocess. */
  stderr?: (data: string) => void;
  /** Claude session id to resume across ticks. Omitted → a fresh session. */
  resume?: string;
  /**
   * Anthropic API key for this wake. Passed to the query subprocess via the
   * `env` option (which inherits `process.env` and overrides the key) rather
   * than mutating the parent process's global `process.env` — so agents with
   * different keys can share one process safely.
   */
  apiKey?: string;
}

/**
 * Pick the Claude model for a Claude-brain wake. The brain must run a `claude-*`
 * model, but the host's default model is provider-agnostic (an OpenAI id today),
 * so this prefers an explicit `claude-*` id (direct or via `services.llm`) and
 * otherwise falls back to {@link DEFAULT_MODEL} — never an OpenAI id.
 */
export function resolveClaudeModel(preferred?: string, servicesModel?: string): string {
  if (preferred?.startsWith('claude')) return preferred;
  if (servicesModel?.startsWith('claude')) return servicesModel;
  return DEFAULT_MODEL;
}

/**
 * Build the `query()` options for a Claude-brain wake. The lockdown fields are
 * fixed here; callers only supply the per-wake variables (prompt, model, tools,
 * turn budget, resume). Returns `Options` so it drops straight into `query()`.
 *
 * prompt caching. The system prompt is handed over as blocks with a
 * trailing `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`: everything before the marker is
 * eligible for cross-session caching, and there is nothing after it because
 * nothing in this prompt varies per wake. Every per-wake input — the event, the
 * context digest — is in the user prompt (`buildClaudeEventPrompt`), which sits
 * after the cached prefix and cannot invalidate it.
 *
 * Cross-SESSION is the point, not cross-turn: `statelessPerWake` starts a fresh
 * transcript on every wake, so without this the identical prefix was re-read at
 * full price on each one.
 *
 * Caching is a prefix match, so block ORDER decides how far the hit reaches:
 * the protocol block is byte-identical for every hosted agent and goes first,
 * the role block is per-agent and goes second. An agent whose combined prompt
 * lands under the model's minimum cacheable prefix (512 tokens on Sonnet 5.5,
 * 4,096 on Haiku 4.5) simply writes no entry — that is a silent no-op, not an error, so
 * read `cacheRead`/`cacheCreation` in the wake metrics rather than assuming.
 */
export function claudeQueryOptions(params: ClaudeQueryOptionsParams): Options {
  return {
    systemPrompt: [...params.systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY],
    model: params.model,
    mcpServers: params.mcpServers,
    // The agent's ONLY capabilities are its MCP tools — no built-in file/bash/web
    // tools, no project/user/plugin MCP config, no local settings / CLAUDE.md.
    // ToolSearch is the one built-in: it loads a deferred Ziggs tool's schema
    // when the model looks for it. Without it the SDK ignores deferral and
    // sends every schema on every wake.
    tools: ['ToolSearch'],
    strictMcpConfig: true,
    settingSources: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: params.maxTurns,
    cwd: params.cwd ?? process.env.CLAUDE_SDK_CWD ?? '/tmp',
    // Set the key for the subprocess without touching the parent process.env.
    // `env` replaces the subprocess environment, so spread process.env to keep
    // PATH/HOME/etc. and override only the key.
    ...(params.apiKey ? { env: { ...process.env, ANTHROPIC_API_KEY: params.apiKey } } : {}),
    ...(params.stderr ? { stderr: params.stderr } : {}),
    ...(params.resume ? { resume: params.resume } : {}),
  };
}

/**
 * Concatenate the text blocks of a completed Claude assistant turn. Tool-use,
 * thinking, and other block kinds are skipped — only the model's user-facing
 * prose is returned (empty string for a pure tool-use turn). This is what a
 * Claude-brain wake records as a `thought` per turn, the same way
 * the FSM's `emitThought` surfaces the model's reasoning.
 */
export function extractAssistantText(message: SDKAssistantMessage): string {
  const content = message.message?.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block && (block as { type?: string }).type === 'text') {
      out += (block as { text?: string }).text ?? '';
    }
  }
  return out;
}

/** One-line digest of a context snapshot for the wake prompt. */
export function summarizeContext(snap: Record<string, unknown> | null | undefined): string {
  if (!snap) return '';
  const agreements = Array.isArray(snap.agreements) ? snap.agreements.length : 0;
  const history = Array.isArray(snap.history) ? snap.history.length : 0;
  const users = Array.isArray(snap.users) ? snap.users.length : 0;
  return `${snap.workBrief ? `Work brief:\n${JSON.stringify(snap.workBrief)}\n` : ''}history=${history} messages, agreements=${agreements}, users=${users}${directArtifactGrantLine(snap)}${snap.work ? `\nWork context (exact scope, governing constraints and required dependencies):\n${JSON.stringify(snap.work)}` : ''}`;
}

/** Ids and names only. Absent when the wake has nothing outside the room inventory. */
function directArtifactGrantLine(snap: Record<string, unknown>): string {
  const granted = snap.grantedArtifacts;
  if (!granted || typeof granted !== 'object') return '';
  const items = (granted as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return '';
  const names = items.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { artifactId?: unknown; name?: unknown };
    if (typeof row.artifactId !== 'string' || !row.artifactId) return [];
    const name = typeof row.name === 'string' && row.name ? ` (${row.name})` : '';
    return [`${row.artifactId}${name}`];
  });
  if (names.length === 0) return '';
  const omitted = (granted as { omitted?: unknown }).omitted;
  const more = typeof omitted === 'number' && omitted > 0 ? ` ${omitted} more on grant_list.` : '';
  return `\nReadable artifacts not in this room: ${names.join(', ')}.${more} Bodies are not here; read one with context_read type=artifacts via=artifact:<id>.`;
}

/**
 * How a held task's deadline and reminder rule read in the prompt.
 *
 * Separate function because the wording is the mechanism here. The platform
 * does not refuse a reminder past the budget and does not report at the
 * deadline for the agent — the agent does both because these lines told it
 * to. A field dump ("checkBack: {everyMinutes:1440,maxReminders:3}") leaves
 * the model to infer an obligation from a JSON blob; an instruction does not.
 */
export function taskChaseLines(
  task: {
    dueAt?: unknown;
    checkBack?: unknown;
  },
  now: Date = new Date(),
): string[] {
  const lines: string[] = [];

  const dueAt =
    typeof task.dueAt === 'string' && task.dueAt
      ? task.dueAt
      : task.dueAt instanceof Date
        ? task.dueAt.toISOString()
        : null;
  if (dueAt) {
    // How long is left, said in words.
    //
    // An ISO timestamp alone made the agent do date arithmetic, and it got it
    // wrong in the direction that costs the most: woken by routine task
    // redelivery four minutes before its deadline, it read "07:49:17", called
    // the deadline "imminent", and closed the task early. An answer arriving
    // after that has no open task to land in — the whole wait thrown away with
    // minutes still on the clock.
    //
    // So the remaining time is computed here rather than left to the model,
    // and the line says plainly that the task stays open until then. "Do not
    // close early" has to be explicit: wrapping up a job you cannot finish
    // reads like diligence, which is exactly why it needs saying.
    const msLeft = Date.parse(dueAt) - now.getTime();
    const left =
      msLeft <= 0
        ? 'that time has passed — report and close now'
        : msLeft < 90_000
          ? 'under two minutes from now'
          : `about ${Math.round(msLeft / 60_000)} minutes from now`;
    lines.push(
      `Task deadline: ${dueAt} (${left}). At that time, post what you have and where you are stuck in the room where the question was asked, close the task, and stop. Until then the task stays OPEN — do not close it early even if you have nothing yet, because an answer can still arrive and closing throws away the time you were given. Do not keep chasing past it either.`,
    );
  }

  const cb = task.checkBack as
    | { everyMinutes?: unknown; maxReminders?: unknown }
    | null
    | undefined;
  const every = typeof cb?.everyMinutes === 'number' ? cb.everyMinutes : null;
  const max = typeof cb?.maxReminders === 'number' ? cb.maxReminders : null;
  if (every != null && max != null) {
    lines.push(
      `Task reminder rule: after your first ask, you may remind the same person at most ${max} time(s), and never less than ${every} minutes apart. Use wake_at to come back — do not wait in place. When the budget is spent, stop reminding and report; reminding more often or more times than this is a breach of the task, not diligence.`,
    );
  }

  return lines;
}

/** Render ONE event's fields into prompt lines (shared by single and batch frames). */
function renderEventLines(event: RawEvent | undefined, lines: string[], now: Date): void {
  if (event?.type) lines.push(`Event type: ${event.type}`);
  if (event?.type === 'wake-at') {
    if (typeof event.reason === 'string' && event.reason.trim()) {
      lines.push(`Timer reason: ${event.reason.trim()}`);
    }
    const scheduledFor = typeof event.scheduledFor === 'number'
      ? new Date(event.scheduledFor)
      : null;
    if (scheduledFor && Number.isFinite(scheduledFor.getTime())) {
      const secondsLate = Math.floor((now.getTime() - scheduledFor.getTime()) / 1000);
      lines.push(
        `Timer scheduled for: ${scheduledFor.toISOString()} (` +
          (secondsLate >= 0 ? `${secondsLate} seconds late` : `due in ${-secondsLate} seconds`) +
          ').',
      );
    }
    lines.push(
      'A scheduled time is not the current time or proof that a reminder is due. ' +
        'Use the host clock and the actual timestamp of your last ask or reminder to check the interval. ' +
        'If it is too soon, re-arm for the remaining interval without sending a reminder.',
    );
  }
  // notifications are not counterparty speech.
  // agreement_lifecycle is a work signal (hire approval) — label it as such.
  if (event?.text) {
    const label =
      event.type === 'agreement_lifecycle'
        ? 'Agreement lifecycle'
        : event.type === 'notification' || event.entryType === 'notification'
          ? 'Notification'
          : 'Message';
    lines.push(`${label}: ${event.text}`);
  }
  if (event?.senderId) lines.push(`Sender: ${event.senderId}`);
  if (event?.operation) lines.push(`Operation: ${event.operation}`);
  if (
    event?.type === 'agreement_lifecycle' &&
    (event.operation === 'proposal_approved' || event.operation === 'proposal_approved_execute')
  ) {
    lines.push(
      'Work signal: proposal approved. If you proposed this agreement, spawn the first task (task_create) under it now. If you are the hired provider, begin fulfilling per the agreement — do not ignore this wake.',
    );
  }
  // store claim wakes as resource_changed (no chat, reason
  // proposal_approved). Distinct from the lifecycle hire path above: open the
  // buyer chat first, then greet and serve terms.
  if (event?.type === SERVER_EVENTS.resourceChanged) {
    const resource = (event.resource ?? event) as {
      reason?: unknown;
      actorId?: unknown;
      agreementId?: unknown;
      resourceId?: unknown;
      kind?: unknown;
      ts?: unknown;
    };
    const reason =
      (typeof resource.reason === 'string' && resource.reason) ||
      (typeof event.reason === 'string' && event.reason) ||
      '';
    // The words for a decision on a request this agent made are shared with
    // the MCP inbox (decisionWords), so both rails say the same thing about
    // the same row. What follows each one here is the hosted brain's own
    // guidance on what NOT to do with it.
    const decisionActor =
      (typeof resource.actorId === 'string' && resource.actorId) ||
      (typeof event.actorId === 'string' && event.actorId) ||
      null;
    const decisionAgreementId =
      (resource.kind === 'agreement' && typeof resource.resourceId === 'string' && resource.resourceId) ||
      (typeof event.agreementId === 'string' && event.agreementId) ||
      (typeof resource.agreementId === 'string' && resource.agreementId) ||
      (resource.kind === 'agreement' &&
        typeof resource.resourceId === 'string' &&
        resource.resourceId) ||
      null;
    const decision = decisionWords({
      reason,
      actorId: decisionActor,
      ts: typeof resource.ts === 'string' ? resource.ts : null,
      agreementId: decisionAgreementId,
      surface: 'sdk',
    });
    if (reason === 'context_request_fulfilled' || reason === 'context_request_rejected') {
      lines.push(
        'Work signal: the owner answered your context access request. ' +
        (decision ? `${decision.sentence} ` : '') +
        'Read the permission request and this conversation to recover the pending work. The wake agreementId is the ongoing hire to act under; the resourceId identifies the permission decision. ' +
        (reason === 'context_request_fulfilled'
          ? 'Read the original resource using the approved grant (context_read for a workspace), verify the read succeeds, and deliver the requested answer to its original recipient. '
          : 'Access was rejected: report the unresolved dependency to the original requester. ') +
        'This is an access decision, not a new hire; do not create a new task or repeat your introduction.',
      );
    }
    // An approval slot answered on an agreement (`approval:approved` /
    // `approval:rejected`). Left unnamed, this wake read to the model as "a
    // person just arrived on an agreement I provide", and an agent whose OWN
    // proposal had just been approved re-sent its first-contact greeting
    // instead of acting on the answer.
    if (reason.startsWith('approval:')) {
      const verdict = reason.slice('approval:'.length) || 'answered';
      lines.push(
        `Work signal: an approval slot on this agreement was ${verdict}` +
          (decisionActor ? ` by ${decisionActor}` : '') +
          '. ' +
          (decision ? `${decision.sentence} ` : 'Read the agreement to identify what was answered. ') +
          'If this answers a request you proposed, act on the answer in the room where you asked for it ' +
          '(approved: carry out the next step you promised; rejected: ask what to change). ' +
          'Do not treat approval of your own request as a new hire or repeat your introduction. ' +
          'An open standing listing accepted by its provider is store setup, not a customer claim: ' +
          'do not greet its publisher or your own organization. An actual hire is active and names a concrete buyer. ' +
          'Only greet on confirmed first contact for an actual hire you provide.',
      );
    }
    if (reason === 'proposal_approved') {
      const buyerId =
        (typeof resource.actorId === 'string' && resource.actorId) ||
        (typeof event.actorId === 'string' && event.actorId) ||
        (typeof event.senderId === 'string' && event.senderId) ||
        '';
      const agreementId =
        (typeof resource.agreementId === 'string' && resource.agreementId) ||
        (typeof event.agreementId === 'string' && event.agreementId) ||
        (resource.kind === 'agreement' &&
          typeof resource.resourceId === 'string' &&
          resource.resourceId) ||
        '';
      lines.push(
        'Work signal: listing claimed (proposal_approved). Verify the accepted interaction mode. For task-only agreements, wait for assigned tasks and report results through tasks; no chat or greeting. Only if messages are accepted, call chat_open with the buyer' +
          (buyerId ? ` (participantId=${buyerId})` : ' (actorId / Sender on this event)') +
          (agreementId ? ` and agreementId=${agreementId}` : ' and the claimed agreementId') +
          ". That returns the hire's room, which the server usually made at claim, or opens one when there is none; then greet them and serve the agreement terms. Do not chat_send to an agrn-* session id — open a real chat first.",
      );
      if (buyerId) lines.push(`Buyer (claim actor): ${buyerId}`);
      // Prefer nested resource agreementId when the outer event omitted it.
      if (agreementId && !(typeof event.agreementId === 'string' && event.agreementId)) {
        lines.push(`Agreement: ${agreementId}`);
      }
    }
  }
  if (event?.agreementContext) {
    lines.push(`Service agreement context (server read): ${JSON.stringify(event.agreementContext)}`);
    lines.push('The wake is a reason to evaluate, not permission to start unrelated work. A final admitted message can still receive its answer when messagesRemaining is zero. New service needs active agreement coverage; negotiation and decisions remain available. Access grants are separate.');
  }
  if (typeof event?.agreementId === 'string' && event.agreementId) {
    lines.push(`Agreement: ${event.agreementId}`);
  }
  // surface the task/agreement this event carries. Without it the brain
  // can't tell WHICH task to update/complete (workers otherwise stall asking for
  // their own taskId) and can't see whether the referenced step already ran or
  // failed — which makes an orchestrator re-spawn duplicate delegations.
  const result = event?.result as
    | {
        taskId?: unknown;
        agreementId?: unknown;
        state?: unknown;
        result?: unknown;
        dueAt?: unknown;
        checkBack?: unknown;
      }
    | undefined;
  if (result && typeof result === 'object') {
    if (typeof result.taskId === 'string') lines.push(`Task: ${result.taskId}`);
    if (typeof result.agreementId === 'string') lines.push(`Agreement: ${result.agreementId}`);
    if (typeof result.state === 'string') lines.push(`Task state: ${result.state}`);
    // The deadline and the reminder budget the creator set on this task.
    //
    // These are the holder's side of the contract, and nothing on the server
    // enforces them: the task row carries them and the protocol text says to
    // obey them, so if they never reach the prompt the agent is being held to
    // a rule it cannot read. The wake already carries the whole task row here
    // (wakeTaskAssignment spreads getTask), so this is a rendering gap, not a
    // missing field — which is exactly why it was easy to miss.
    //
    // Stated as an instruction rather than a field dump. `dueAt: <iso>` is a
    // value; "report and stop at this time" is what the agent has to do with
    // it, and the second reads as work while the first reads as metadata.
    for (const line of taskChaseLines(result, now)) lines.push(line);
    // surface the task's RESULT payload too. Completion notifies now
    // pin it (backend), and an orchestrator consuming a worker's output has no
    // task-read tool — without this line the step outcome never reaches the
    // model and a chained pipeline stalls right after its first task.
    if (result.result != null) {
      const payload =
        typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      const MAX = 12_000;
      lines.push(`Task result: ${payload.length > MAX ? `${payload.slice(0, MAX)} …[truncated ${payload.length - MAX} chars]` : payload}`);
    }
  }
}

/**
 * Turn a Ziggs wake event + context digest into the user prompt that starts a
 * Claude-brain turn. The agent's standing instructions come from its system
 * prompt (protocol + role); this is just "here's what woke you, go handle it."
 *
 * EventQueue coalesces events that arrive while the lane is busy into
 * a `{type:'batch', events:[...]}` frame. The FSM path unwraps those
 * (PromptBuilder), but this path used to render just "Event type: batch" —
 * every payload inside (including task results) was invisible to the model,
 * stalling delegation pipelines whose notifications share one chat lane.
 * Render each batched event in order instead.
 */
export function buildClaudeEventPrompt(
  event: RawEvent | undefined,
  contextSummary: string,
  now: Date = new Date(),
): string {
  const lines: string[] = [
    'You received a new Ziggs event. Handle it per your protocol.',
    `Current time: ${now.toISOString()} (host clock at wake start).`,
  ];
  const batched = getBatchEvents(event);
  if (event && batched.length > 1) {
    lines.push(`This wake carries ${batched.length} coalesced events (oldest first). Handle them together — act once per distinct piece of work, not once per notification.`);
    batched.forEach((e, i) => {
      lines.push('', `— Event ${i + 1} of ${batched.length} —`);
      renderEventLines(e as RawEvent, lines, now);
    });
  } else {
    renderEventLines(event, lines, now);
  }
  if (contextSummary) {
    lines.push('', 'Session context snapshot:', contextSummary);
  }
  lines.push('', 'Use context_snapshot if you need more context. If the event needs nothing from you, say so briefly and stop.');
  return lines.join('\n');
}

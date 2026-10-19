import type { Action, CollectedSubtaskResult, Ctx, PromptDef } from '../types.js';
import { INBOUND_DISCOVERY_POLICY } from '../inboundDiscoveryPolicy.js';
import { HistoryFormatter, AgreementFormatter } from '../formatters/index.js';
import { validateContext } from '../cognition/validateContext.js';
import type { RawEvent } from './buildOutcome.js';
import { isBroadcastTarget, isOpaquePresentationRef, partySideIds, type AgreementParties, type AgreementPartySide } from '@ziggs-ai/api-client';
import {
  LANE_BOOK_KEY,
  allCollectedResults,
  allDelegatedAgreementIds,
  allPendingSubtasks,
} from './taskBookkeeping.js';

type AnyObj = Record<string, unknown>;

interface ServerContext {
  history?: AnyObj[];
  agreements?: AnyObj[];
  agents?: AnyObj[];
  users?: AnyObj[];
  [key: string]: unknown;
}

interface ServerContextBundle {
  context: ServerContext;
  tools: AnyObj[];
}

interface SenderMeta {
  senderId?: string;
  senderType?: string;
  [key: string]: unknown;
}

interface BuildArgs {
  statePrompt: PromptDef;
  actions: Record<string, Action>;
  serverContext: ServerContextBundle;
  incomingEvent: RawEvent | null;
  definition: { description?: string };
  chatId: string | null;
  stateId: string;
  ctx: Ctx;
  /** When true, respond-action schemas omit the "message" field — used for 2-call streaming. */
  omitMessageFromRespond?: boolean;
}

interface HistoryFormatterI { format(history: unknown[] | null | undefined, agentId: string, options?: AnyObj): string; }
interface AgreementFormatterI { format(agreements: unknown[] | null): string; }
interface LoggerI { info?(...args: unknown[]): void; warn?(...args: unknown[]): void; debug?(...args: unknown[]): void; }

export interface PromptBuilderOptions {
  description?: string;
  specialization?: string | null;
  maxHistoryEntries?: number;
  /**
   * Token budget for the <history> block. History is included newest-first up
   * to this many (estimated) tokens, so a few large turns can't blow the prompt
   * up to tens of thousands of input tokens. maxHistoryEntries still
   * applies as a secondary hard ceiling.
   */
  maxHistoryTokens?: number;
  historyFormatter?: HistoryFormatterI;
  agreementFormatter?: AgreementFormatterI;
  logger?: LoggerI | null | { warn: (msg: string) => void };
}

/** Rough chars-per-token ratio for budgeting (English/JSON averages ~4). */
const CHARS_PER_TOKEN = 4;

/**
 * Builds the XML prompt for a thinking-state turn:
 *   <agent><self/><world/><decision_schema/></agent>
 *
 * Reads Ctx (identity + persistent ids + lastOutcome) for <machine_context>.
 * Action tool binding is direct (action.tool). Decision schema documents the
 * action's `produces` outcome kind.
 */
export class PromptBuilder {
  description: string;
  specialization: string | null;
  maxHistoryEntries: number;
  maxHistoryTokens: number;
  historyFormatter: HistoryFormatterI;
  agreementFormatter: AgreementFormatterI;
  logger: LoggerI | null;

  constructor(options: PromptBuilderOptions = {}) {
    this.description = options.description || 'A capable agent ready to assist';
    this.specialization = options.specialization ?? null;
    this.maxHistoryEntries = options.maxHistoryEntries ?? 50;
    this.maxHistoryTokens = options.maxHistoryTokens ?? 8000;
    this.historyFormatter = options.historyFormatter || new HistoryFormatter();
    this.agreementFormatter = (options.agreementFormatter || new AgreementFormatter()) as AgreementFormatterI;
    this.logger = options.logger as LoggerI | null || null;
  }

  // Section order is deliberate and cache-stable: <self> (identity,
  // state, tools) is stable per agent+state and comes first, so OpenAI automatic
  // prompt caching can reuse it as a prefix across a conversation's turns. All
  // volatile content (the incoming event, history, and currentTime) lives later
  // in <world>, so it never invalidates that cacheable prefix.
  buildFromState(args: BuildArgs): string {
    const { statePrompt, actions, serverContext, incomingEvent, definition, stateId, ctx, omitMessageFromRespond } = args;
    const ctxObj = serverContext?.context || {};
    validateContext(ctxObj, { logger: this.logger as { warn: (msg: string) => void } | undefined });

    const agentId = this._getMyAgentId(ctxObj);
    const senderMeta = this._getSenderMeta(incomingEvent, ctxObj);
    const agreements = ctxObj.agreements || [];
    const otherAgents = (ctxObj.agents || []).filter((a) => !a.isYou);
    const users = ctxObj.users || [];
    const desc = definition?.description || this.description;

    return `<agent>

${this._renderSelfFromState(desc, statePrompt, serverContext?.tools)}

${this._renderWorld(incomingEvent, ctxObj, agentId, senderMeta, agreements, otherAgents, users, stateId, ctx)}

${this._renderDecisionSchemaFromActions(actions, senderMeta, ctxObj, omitMessageFromRespond)}

</agent>`;
  }

  _renderSelfFromState(description: string, statePrompt: PromptDef, tools?: AnyObj[]): string {
    const lines: string[] = ['<self>'];
    lines.push(`<identity>\nYou are an Autonomous Agent.\n${description}\n</identity>`);

    lines.push('\n<state>');
    if (statePrompt.role) lines.push(`Role: ${statePrompt.role}`);
    if (statePrompt.goal) lines.push(`Goal: ${statePrompt.goal}`);
    if (statePrompt.context) lines.push(`Context: ${statePrompt.context}`);
    if (statePrompt.constraints) lines.push(`Constraints: ${statePrompt.constraints}`);
    lines.push('</state>');
    lines.push(`\n<security>\n${INBOUND_DISCOVERY_POLICY}\n</security>`);

    if (tools?.length) {
      lines.push('\n<tools>');
      for (const tool of tools) {
        const toolAny = tool as AnyObj;
        const fn = (toolAny.schema as AnyObj | undefined)?.function as AnyObj | undefined || toolAny.schema as AnyObj | undefined;
        const name = fn?.name;
        const desc = fn?.description;
        if (name) lines.push(`- ${name}${desc ? ': ' + desc : ''}`);
      }
      lines.push('</tools>');
    }

    lines.push('</self>');
    return lines.join('\n');
  }

  _renderWorld(
    event: RawEvent | null,
    ctxObj: ServerContext,
    agentId: string | null,
    senderMeta: SenderMeta,
    agreements: AnyObj[],
    otherAgents: AnyObj[],
    users: AnyObj[],
    stateId: string,
    ctx: Ctx,
  ): string {
    const lines: string[] = ['<world>'];

    const machineBlock = this._renderMachineContext(stateId, ctx);
    if (machineBlock) {
      lines.push(machineBlock);
      lines.push('');
    }

    lines.push(this._renderEvent(event, senderMeta));
    lines.push('');
    lines.push(this._renderHistory(ctxObj.history, agentId));
    lines.push('');
    lines.push(this._renderAgreements(agreements));
    if (ctxObj.work) lines.push(`<work-context>\n${JSON.stringify(ctxObj.work)}\n</work-context>`);

    const collected = ctx ? allCollectedResults(ctx) : [];
    if (collected.length) {
      lines.push('');
      lines.push(this._renderSubtaskResults(collected));
    }

    if (users.length > 0 || otherAgents.length > 0) {
      lines.push('');
      lines.push(this._renderRecipients(users, otherAgents, agreements, agentId));
    }

    lines.push(`\n<context>\n  currentTime: ${new Date().toISOString()}\n</context>`);
    lines.push('</world>');
    return lines.join('\n');
  }

  _renderMachineContext(stateId: string, ctx: Ctx): string {
    if (!ctx) return stateId ? `<machine_context>\n${JSON.stringify({ stateId }, null, 2)}\n</machine_context>` : '';
    const out: Record<string, unknown> = { stateId };
    if (ctx.identity?.sessionId) out.chatId = ctx.identity.sessionId;
    if (ctx.identity?.laneKey) out.laneKey = ctx.identity.laneKey;
    if (ctx.identity?.agentId) out.ownAgentId = ctx.identity.agentId;
    if (ctx.activeAgreementId) out.activeAgreementId = ctx.activeAgreementId;
    if (ctx.activeTaskId) out.activeTaskId = ctx.activeTaskId;
    if (ctx.pendingProposalAgreementId) out.pendingProposalAgreementId = ctx.pendingProposalAgreementId;
    const openTaskIds = Object.keys(ctx.tasks ?? {}).filter((id) => id !== LANE_BOOK_KEY);
    if (openTaskIds.length) out.openTaskIds = openTaskIds;
    const delegated = allDelegatedAgreementIds(ctx);
    if (delegated.length) out.delegatedAgreementIds = delegated;
    const pending = allPendingSubtasks(ctx);
    if (Object.keys(pending).length) out.pendingSubtasks = pending;
    if (ctx.lastOutcome) out.lastOutcomeKind = ctx.lastOutcome.kind;
    return `<machine_context>\n${JSON.stringify(out, null, 2)}\n</machine_context>`;
  }

  _renderSubtaskResults(results: CollectedSubtaskResult[]): string {
    const lines: string[] = ['<subtask_results>'];
    lines.push(`All ${results.length} finished subtask(s) for the current engagement, oldest first. Synthesize from ALL of them — not just the most recent event.`);
    for (const r of results) {
      const payload = r.result == null ? null : typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
      const display = payload && payload.length > 2000 ? payload.slice(0, 2000) + `… [truncated of ${payload.length} chars]` : payload;
      lines.push(`- taskId=${r.taskId} agent=${r.agentId ?? 'unknown'} status=${r.status}`);
      lines.push(`  result: ${display ?? '(none)'}`);
    }
    lines.push('</subtask_results>');
    return lines.join('\n');
  }

  _renderEvent(event: RawEvent | AnyObj | null, senderMeta: SenderMeta): string {
    if (!event) return '<event type="none">No incoming event.</event>';

    const evAny = event as AnyObj;
    if (evAny.type === 'batch' && Array.isArray(evAny.events) && (evAny.events as unknown[]).length > 0) {
      const parts = (evAny.events as AnyObj[]).map((e: AnyObj, i: number) => {
        const sub: SenderMeta = { ...senderMeta, senderId: (e.senderId ?? senderMeta.senderId) as string | undefined, senderType: (e.senderType ?? senderMeta.senderType) as string | undefined };
        return (i > 0 ? '\n---\n' : '') + this._renderEvent(e, sub);
      });
      return `<event type="batch" count="${(evAny.events as unknown[]).length}">\n${parts.join('')}\n</event>`;
    }

    const eventType = String(evAny.type || 'message');
    const from = `${senderMeta.senderId} (${String(senderMeta.senderType || 'unknown').toLowerCase()})`;

    const result = evAny.result as AnyObj | undefined;
    if (eventType === 'task_result' && result?.taskId) {
      return this._renderTaskResultEvent(result, from);
    }
    if (eventType === 'tool_result') {
      const r = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
      return `<event type="${eventType}" from="${from}">\nTool: ${evAny.tool}\nResult:\n${r}\n</event>`;
    }
    if (eventType === 'tool_error') {
      return `<event type="${eventType}" from="${from}">\nTool Error: ${evAny.tool}\nMessage: ${evAny.error}\n</event>`;
    }
    if (eventType === 'message_sent') {
      return `<event type="${eventType}" from="${from}">\nYour message was delivered. Do not repeat it.\n</event>`;
    }

    const agreementContext = evAny.agreementContext ? `Service agreement context: ${JSON.stringify(evAny.agreementContext)}\nTool access requires separate grants. Zero remaining messages does not prevent answering the final admitted message.\n` : '';
    const content = event.text || event.result || event.content;
    if (!content) return `<event type="${eventType}" from="${from}">(Empty)</event>`;
    const str = typeof content === 'object' ? JSON.stringify(content) : String(content);
    // Matches MAX_MSG_CHARS in runTurn.ts — the incoming instruction shouldn't
    // be truncated tighter than what the agent itself is allowed to send back.
    const display = str.length > 3500 ? str.slice(0, 3500) + '...' : str;
    return `<event type="${eventType}" from="${from}">\n${agreementContext}${display}\n</event>`;
  }

  _renderTaskResultEvent(task: AnyObj, from: string): string {
    const lines: string[] = [];
    const ag = task.agreement as AnyObj | undefined;
    const parties = (ag?.parties as AnyObj) || {};
    const creatorIsYou = task.creatorIsYou;
    const providerIsYou = task.providerIsYou;

    if (ag?.agreementId) {
      const named = (name: string): string =>
        partySideIds(parties[name] as AgreementPartySide | undefined).join(' via ');
      lines.push(`Agreement: ${ag.agreementId}${creatorIsYou ? ' (yours)' : ''}`);
      lines.push(`  Creator: ${named('creator') || 'N/A'}${creatorIsYou ? ' (You)' : ''}`);
      lines.push(`  Provider: ${named('provider') || 'N/A'}${providerIsYou ? ' (You)' : ''}`);
      const proposal = ag.proposal as AnyObj | undefined;
      if (proposal?.status) {
        lines.push(`  Proposal: ${proposal.status} (to ${named('proposedTo')}${task.proposedToIsYou ? ' - You' : ''})`);
      }
      const money = ag.money as AnyObj | undefined;
      if (typeof money?.price === 'number' && (money.price as number) > 0) {
        lines.push(`  Price: ${money.price} hundredths of a point (${money.paymentStatus})`);
      }
    }

    lines.push('');
    lines.push(`Task: ${task.taskId}`);
    lines.push(`  Description: ${task.description}`);
    lines.push(`  State: ${task.state}`);
    if (task.parentTaskId) lines.push(`  Parent task: ${task.parentTaskId}`);

    // Tasks are always born active in the new model. Proposal lifecycle lives
    // only on the agreement; the prompt surfaces it through the <agreements>
    // section, not via task state.
    void ag;
    void parties;

    return `<event type="task_result" from="${from}"${creatorIsYou ? ' own_agreement="true"' : ''}>\n${lines.join('\n')}\n</event>`;
  }

  _renderHistory(history: AnyObj[] | undefined, agentId: string | null): string {
    const all = history || [];
    const charBudget = this.maxHistoryTokens * CHARS_PER_TOKEN;

    // Include entries newest-first, bounded by BOTH a token budget and the
    // entry-count ceiling. The newest entry is always kept even if it alone
    // exceeds the budget, so the most recent turn is never dropped.
    let startIdx = all.length;
    let usedChars = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all.length - i > this.maxHistoryEntries) break;
      const size = this._estimateEntryChars(all[i]);
      if (startIdx < all.length && usedChars + size > charBudget) break;
      usedChars += size;
      startIdx = i;
    }

    const entries = all.slice(startIdx);
    const dropped = all.length - entries.length;
    const truncNote = dropped > 0
      ? `[Showing last ${entries.length} of ${all.length} entries — older turns dropped to fit the context budget]\n\n`
      : '';
    const formatted = this.historyFormatter.format(entries, agentId ?? '', {});
    return `<history>\n${truncNote}${formatted}\n</history>`;
  }

  /** Rough character size of one history entry, used for the token budget. */
  _estimateEntryChars(entry: AnyObj): number {
    try { return JSON.stringify(entry)?.length ?? 0; } catch { return 0; }
  }

  _renderAgreements(agreements: AnyObj[]): string {
    const formatted = this.agreementFormatter.format(agreements || []);
    return `<agreements>\n${formatted}\n</agreements>`;
  }

  _renderRecipients(users: AnyObj[], otherAgents: AnyObj[], agreements: AnyObj[], myAgentId: string | null | undefined): string {
    // <recipients> is grouped by surface so the LLM knows which ids it can use
    // for each kind of action. Same id appears in multiple subsections when it
    // participates in multiple surfaces. <users> / <agents> stay as the typed
    // directory (existing prompts reference <recipients><users>); the new
    // <chat>/<agreement>/<task>/<transfer> subsections narrow that directory
    // to a specific action surface.
    const userIds = new Set<string>();
    const userLabels = new Map<string, string>();
    for (const u of users) {
      const id = u?.userId as string | undefined;
      if (!id || id === myAgentId) continue;
      userIds.add(id);
      userLabels.set(id, u.userName ? `${u.userName} (${id})` : id);
    }
    const agentIds = new Set<string>();
    const agentLabels = new Map<string, string>();
    for (const a of otherAgents) {
      const id = a?.agentId as string | undefined;
      if (!id || id === myAgentId) continue;
      agentIds.add(id);
      const desc = typeof a.description === 'string' ? `: ${a.description.slice(0, 80)}` : '';
      const name = a.name && a.name !== id ? `${a.name} (${id})` : id;
      agentLabels.set(id, `${name}${desc}`);
    }
    // The server declares what each participant is (`kind` on the snapshot row),
    // so read that. Which array a row arrived in is a projection detail, and
    // guessing from it mislabels the first participant that is neither a person
    // nor an agent. A backend too old to send `kind` still resolves by array.
    const declaredKinds = new Map<string, string>();
    for (const row of [...users, ...otherAgents]) {
      const id = (row?.['userId'] ?? row?.['agentId']) as string | undefined;
      const kind = row?.['kind'];
      if (id && typeof kind === 'string') declaredKinds.set(id, kind);
    }
    const kindOf = (id: string): string =>
      declaredKinds.get(id) ??
      (userIds.has(id) ? 'user' : agentIds.has(id) ? 'agent' : 'unknown');
    const labelOf = (id: string): string =>
      userLabels.get(id) ?? agentLabels.get(id) ?? id;
    const tagged = (id: string): string => `${labelOf(id)} [${kindOf(id)}]`;

    // Agreement parties — derived from current agreements, role-tagged.
    type PartyHit = { agreementId: string; role: string };
    const agreementParties = new Map<string, PartyHit[]>();
    for (const ag of agreements || []) {
      const agId = ag?.agreementId as string | undefined;
      const parties = (ag?.parties as AnyObj) || {};
      for (const role of ['creator', 'provider', 'payer', 'proposedTo']) {
        // Both columns of a side are addressable and carry the same role: the
        // principal is who the deal is with, the actor is who acts on it.
        for (const pid of partySideIds(parties[role] as AgreementPartySide | undefined)) {
          if (pid === myAgentId) continue;
          // Opaque presentation refs are not principal slots.
          if (isOpaquePresentationRef(pid)) continue;
          if (!agreementParties.has(pid)) agreementParties.set(pid, []);
          agreementParties.get(pid)!.push({ agreementId: agId ?? '', role });
        }
      }
    }

    // Chat keeps the full directory — including opaque `rpb_*` / `psn_*` refs
    // the persona layer may surface. To name a masked party, pass its `rpb_`
    // ref as it came; the backend resolves it in-room. Transfer (and any
    // account-id action) must never list opaque refs — lookup / wake / pay
    // against them 400s.
    const chatIds = new Set<string>([...userIds, ...agentIds]);
    const transferIds = new Set<string>(
      [...userIds, ...agentIds].filter((id) => !isOpaquePresentationRef(id)),
    );

    const lines: string[] = ['<recipients>'];

    lines.push('<users>');
    if (userIds.size === 0) lines.push('  (none)');
    else for (const id of userIds) lines.push(`  - ${userLabels.get(id)}`);
    lines.push('</users>');

    lines.push('<agents>');
    if (agentIds.size === 0) lines.push('  (none)');
    else for (const id of agentIds) lines.push(`  - ${agentLabels.get(id)}`);
    lines.push('</agents>');

    lines.push('<chat>');
    if (chatIds.size === 0) lines.push('  (none)');
    else for (const id of chatIds) lines.push(`  - ${tagged(id)}`);
    lines.push('</chat>');

    lines.push('<agreement>');
    if (agreementParties.size === 0) lines.push('  (no agreement parties in this chat)');
    else for (const [id, hits] of agreementParties) {
      const tag = hits.map((h) => `${h.agreementId}:${h.role}`).join(', ');
      lines.push(`  - ${tagged(id)} [${tag}]`);
    }
    lines.push('</agreement>');

    lines.push('<task>');
    if (agreementParties.size === 0) lines.push('  (no task parties in this chat)');
    else for (const [id, hits] of agreementParties) {
      const tag = hits.map((h) => `${h.agreementId}:${h.role}`).join(', ');
      lines.push(`  - ${tagged(id)} [${tag}]`);
    }
    lines.push('</task>');

    lines.push('<transfer>');
    if (transferIds.size === 0) lines.push('  (none)');
    else for (const id of transferIds) lines.push(`  - ${tagged(id)}`);
    lines.push('</transfer>');

    lines.push('</recipients>');
    return lines.join('\n');
  }

  _renderDecisionSchemaFromActions(actions: Record<string, Action>, senderMeta: SenderMeta, ctxObj: ServerContext, omitMessage?: boolean): string {
    const lines: string[] = ['<decision_schema>'];
    lines.push('Return ONE JSON object. ALWAYS include "thought" as the FIRST field — briefly explain your reasoning before choosing an action.');
    lines.push('Set "action" to exactly one of the action names below.');
    lines.push('Name "receiverId" only when you mean a specific recipient. Leave it out to write back in this room; an answer without one is sent without one.');
    lines.push('Message text is rendered as markdown (CommonMark + GFM). You MAY use **bold**, *italic*, `code`, fenced code blocks, lists, links, and tables when they improve clarity — plain text is also fine.\n');

    const pendingProposals = (ctxObj.agreements || []).filter(
      (a) => (a.proposal as Record<string, unknown> | undefined)?.status === 'pending' && (a.proposedToIsYou || isBroadcastTarget((a.parties as AgreementParties | undefined)?.proposedTo?.principal)),
    );

    if (pendingProposals.length > 0) {
      lines.push(`PRIORITY: You have ${pendingProposals.length} pending proposal(s) directed at you. Respond BEFORE other actions.`);
      lines.push(`{"thought": "...", "action": "<action_bound_to_agreement_respond>", "args": {"agreementId": "<id>", "action": "approve|reject"}}\n`);
    }

    for (const [name, actionDef] of Object.entries(actions)) {
      lines.push(`─── "${name}" ───`);
      if (actionDef.prompt?.when) lines.push(`Use when: ${actionDef.prompt.when}`);
      if (actionDef.prompt?.instruction) lines.push(`Instruction: ${actionDef.prompt.instruction}`);
      if (actionDef.prompt?.format) lines.push(`Format: ${actionDef.prompt.format}`);

      const boundTool = actionDef.tool ?? null;
      if (boundTool) {
        lines.push(`Tool: ${boundTool}`);
        lines.push(`Response: {"thought": "...", "action": "${name}", "args": {...}}`);
      } else {
        lines.push(this._buildActionSchema(name, omitMessage));
      }

      if (actionDef.prompt?.examples?.length) {
        lines.push('Examples:');
        for (const ex of actionDef.prompt.examples) {
          const desc = ex.scenario || ex.input || '';
          const out = ex.output || ex.query || '';
          lines.push(`  - ${desc}${out ? ' → ' + out : ''}`);
        }
      }

      lines.push('');
    }

    lines.push('</decision_schema>');
    return lines.join('\n');
  }

  _buildActionSchema(name: string, omitMessage?: boolean): string {
    if (name === 'wait') {
      return `Response: {"thought": "...", "action": "${name}"}`;
    }
    if (omitMessage) {
      return `Response: {"thought": "...", "action": "${name}"}`;
    }
    return `Response: {"thought": "...", "action": "${name}", "message": "..."}`;
  }

  _getSenderMeta(event: RawEvent | AnyObj | null, ctxObj: ServerContext): SenderMeta {
    const ev = event as AnyObj | null;
    const senderId = String(ev?.senderId || 'system');
    const senderType = ev?.senderType ? String(ev.senderType).toUpperCase() : 'SYSTEM';
    const myId = this._getMyAgentId(ctxObj);

    return { senderId, senderType, myAgentId: myId };
  }

  _getMyAgentId(ctxObj: ServerContext): string | null {
    const agents = ctxObj.agents || [];
    const me = agents.find((a) => a.isYou);
    return (me?.agentId as string | undefined) || null;
  }
}

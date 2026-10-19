import type { AgentConfig, DefineAgentInput, Workflow } from './types.js';
import { validateWorkflow } from './runtime/validateWorkflow.js';
import { injectKickoffDefault } from './runtime/kickoff.js';
import { injectTaskIntakeDefault } from './runtime/taskIntake.js';
import { runtimeLog } from './shared/runtimeLog.js';
import { resolveFleetModel } from './shared/fleetModel.js';
import { normalizeNeeds, toolsForNeeds } from './tools/needs.js';
import { toolName, type ToolDefinition } from './tools/defineTool.js';

/**
 * Validates the workflow synchronously, resolves merged tools and model, and
 * returns a frozen AgentConfig. Never mutates the input. `wait` defaults remain
 * the author's visible spread of `thinkingDefaults`. TWO defaults are injected
 * (as new objects), each appended LAST so author transitions always win:
 *  - the agreement-kickoff state `kickingOff`, reached from every state that
 *    does not already handle a proposer-side proposal-resolved/approve outcome
 *    (runtime/kickoff.ts);
 *  - the assigned-task-intake state `workingAssignedTask`, reached from every
 *    state that does not already route a task-assigned outcome
 *    (runtime/taskIntake.ts) — so a standing hire's task #2..N is never
 *    silently dropped by a parked state.
 * Both state names are reserved; defining either throws.
 *
 * Validation throws WorkflowValidationError on hard problems and logs warnings
 * on soft ones (e.g. missing wait fallthrough).
 */
export function defineAgent(input: DefineAgentInput): AgentConfig {
  if (!input?.agentId) throw new Error('[defineAgent] agentId is required');
  if (!input?.description) throw new Error('[defineAgent] description is required');
  if (!input?.states) throw new Error('[defineAgent] states is required');
  if (!input?.initial) throw new Error('[defineAgent] initial state is required');

  // Agreement-kickoff + assigned-task-intake defaults (runtime/kickoff.ts,
  // runtime/taskIntake.ts): injected BEFORE validation so the injected
  // states/transitions are validated too.
  const workflow: Workflow = injectTaskIntakeDefault(
    injectKickoffDefault({
      id: input.agentId,
      // The workflow description is the agent's role text, which PromptBuilder
      // renders into <self>. split that from the store-facing
      // `description`: prefer the prompt when the author supplied one.
      description: input.systemPrompt || input.description,
      initial: input.initial,
      states: input.states,
    }),
  );

  const { warnings } = validateWorkflow(workflow);
  for (const w of warnings) runtimeLog.warn('defineAgent', w);

  // Tools the DECLARATION produces, not the author. An agent that says
  // it needs a connection gets the tools to see and use one, so the prompt and
  // the toolset cannot describe different worlds. Author tools come last and win
  // on name, so hand-listing a derived tool is a no-op rather than a duplicate.
  const needs = normalizeNeeds(input.needs);
  const tools: unknown[] = [];
  const positionByName = new Map<string, number>();
  for (const tool of [
    ...toolsForNeeds(needs),
    ...(Array.isArray(input.tools) ? input.tools : []),
    ...(Array.isArray(input.services?.tools) ? input.services!.tools! : []),
  ]) {
    const name = toolName(tool as ToolDefinition | undefined);
    // A nameless entry cannot be deduped — keep it and let ToolManager reject
    // it the way it always has, rather than silently dropping it here.
    if (!name) {
      tools.push(tool);
      continue;
    }
    const at = positionByName.get(name);
    if (at === undefined) {
      positionByName.set(name, tools.length);
      tools.push(tool);
    } else {
      tools[at] = tool;
    }
  }

  // One resolution for every agent: a pin, then LLM_MODEL, then DEFAULT_MODEL.
  const model = resolveFleetModel(input.services?.llm?.model);

  // Strip the structural fields we already consumed; pass through everything
  // else (operatorKey, taskTools, custom keys consumed by Agent).
  const {
    agentId, description, specialization, services: _services, initial: _initial,
    states: _states, tools: _tools, operatorKey, taskTools, ...rest
  } = input;

  const config: AgentConfig = {
    openaiKey: process.env.OPENAI_API_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    ...(operatorKey ? { operatorKey } : {}),
    agentId,
    description,
    ...(specialization ? { specialization } : {}),
    tools,
    model,
    workflow,
    // declaration is the source — receiving dynamic proposals is an
    // explicit opt-in, and the default is claim-only (false). Derivation no
    // longer decides; it validates: an explicit opt-in whose workflow wires no
    // agreement_respond action is a declared door that cannot open.
    respondsToProposals: input.respondsToProposals ?? false,
    ...(input.services ? { services: input.services } : {}),
    ...(taskTools !== undefined ? { taskTools } : {}),
    ...rest,
    // After `rest`, so the config carries the NORMALIZED needs — Agent
    // enforces these at task start and should not have to re-parse the raw field.
    ...(needs.length ? { needs } : {}),
  };

  return Object.freeze(config) as AgentConfig;
}

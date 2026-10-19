import {
  replaceTaskPlan,
  SOURCES_PARAM,
  type PlanReplaceStep,
} from '@ziggs-ai/api-client';
import { defineTool, type ToolDefinition } from '../../../tools/defineTool.js';
import { credsFromToolContext } from '../../../tools/toolCreds.js';

/**
 * `task_replace_plan` — write the checklist of a task you hold.
 *
 * The hosted tool set could only UPDATE a step that already existed
 * (`task_update_plan_step` takes a stepId), and a task created without a plan
 * has none, so an agent had no way to record anything about its own work on
 * the task row. That mattered the moment one agent served two customers: from
 * the second customer's room it could not find the approval request it had
 * sent under the first customer's hire, and told them it had never been sent
 * (store-opening lab, 2026-09-15). The MCP surface has had
 * `ziggs_task_replace_plan` all along; this is the same client call for the
 * hosted brain.
 *
 * The plan is the agent's own notebook on the task: step results can carry
 * ids (an approval agreement, an artifact), and `task_list` reads the plan back
 * from any room the agent is woken in.
 */
export const taskReplacePlanTool: ToolDefinition = defineTool(
  'task_replace_plan',
  {
    taskId: { type: 'string', required: true, minLength: 1, pattern: '\\S' },
    steps: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        properties: {
          stepId: {
            type: 'string',
            description: 'Stable id for this step. Omit to let the server assign step-<n>.',
          },
          description: { type: 'string', minLength: 1, pattern: '\\S' },
          order: {
            type: 'integer',
            description: 'Position in the plan. Omit to use the array index.',
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'skipped'],
            description: 'Step progress. Omit for pending.',
          },
          result: {
            type: 'object',
            description:
              'What this step produced, as an object — e.g. { "agreementId": "agr_…" } for an approval you requested, or { "artifactId": "art_…" } for a pack you recorded. Stored with the step and read back by task_list.',
          },
          sources: SOURCES_PARAM as unknown as Record<string, unknown>,
        },
        required: ['description'],
      },
      description:
        'The FULL ordered step list. Existing steps are replaced wholesale, not appended to — read the current plan with task_list first and send it back with your changes.',
    },
  },
  async (args, ctx) => {
    const creds = credsFromToolContext(ctx, 'task_replace_plan');
    const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
    if (!taskId) throw new Error('task_replace_plan: taskId is required');
    const steps = args.steps;
    if (!Array.isArray(steps)) throw new Error('task_replace_plan: steps must be an array');
    return replaceTaskPlan(taskId, steps as PlanReplaceStep[], creds);
  },
  {
    description:
      'Replace the plan of a task you hold with the full ordered step list. Use it to write your own checklist on a task that arrived without one, and to record what a step produced (an approval agreement id, an artifact id) so a later wake — in any room — can find it with task_list. Steps you do not send are removed; mark finished steps completed so closing the task does not rewrite them as skipped.',
  },
);

export const PLAN_TOOLS: ToolDefinition[] = [taskReplacePlanTool];

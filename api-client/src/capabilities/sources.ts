import type { CapabilityParam } from './types.js';

/**
 * What a write drew on. Every write that carries text the agent composed
 * can say it: things in Ziggs by kind and id, or outside things as a url.
 * Never shown to anyone; the writer's company admin reads it back by query.
 */
export const WRITE_SOURCE_KINDS = [
  'message',
  'artifact',
  'task_result',
  'task_plan_step',
  'url',
] as const;

export type WriteSourceKind = (typeof WRITE_SOURCE_KINDS)[number];

/**
 * - `message`: `id` is the messageId, `chatId` its room.
 * - `artifact`: `id` is the artifactId.
 * - `task_result`: `id` is the taskId.
 * - `task_plan_step`: `id` is the stepId, `taskId` its task.
 * - `url`: `value` is the outside source.
 */
export interface WriteSource {
  kind: WriteSourceKind;
  id?: string;
  chatId?: string;
  taskId?: string;
  value?: string;
}

/** One line, shared by every tool that takes `sources`: it is repeated per tool. */
export const SOURCES_DESCRIPTION =
  'What this text drew on: {kind,id} for a message (+chatId), artifact, task_result or task_plan_step (+taskId); {kind:"url",value} outside. [] = nothing more.';

export const SOURCES_PARAM: CapabilityParam = {
  type: 'array',
  description: SOURCES_DESCRIPTION,
  items: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: WRITE_SOURCE_KINDS },
      id: { type: 'string' },
      chatId: { type: 'string' },
      taskId: { type: 'string' },
      value: { type: 'string' },
    },
    required: ['kind'],
  },
};

/** The `sources` a tool call carried, ready for the request body. */
export function sourcesArg(
  args: Record<string, unknown>,
): { sources: WriteSource[] } | Record<string, never> {
  const raw = args['sources'];
  return Array.isArray(raw) ? { sources: raw as WriteSource[] } : {};
}

import { ContentTypes, type ContentType } from '@ziggs-ai/api-client';

export { ContentTypes, type ContentType };

/** Entry kinds. `task_history` is a legacy alias the wire still accepts. */
export const EntryTypes = {
  MESSAGE: 'message',
  NOTIFICATION: 'notification',
  ARTIFACT: 'artifact',
  TASK_HISTORY: 'task_history',
} as const;

export type EntryType = (typeof EntryTypes)[keyof typeof EntryTypes];

export const ContextProperties = {
  HISTORY: 'history',
  AGREEMENTS: 'agreements',
  AGENTS: 'agents',
  USERS: 'users',
} as const;

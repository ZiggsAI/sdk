import type { ResourceAction, ResourceActionCall } from '../http/ContextOpenClient.js';

export function presentResourceCall<T extends ResourceActionCall>(value: T, surface: 'sdk' | 'mcp'): T {
  const name = value.tool.replace(/^ziggs_/, '');
  return { ...value, tool: surface === 'mcp' ? `ziggs_${name}` : name };
}

/** Bind canonical tool names without changing the backend's decision or scope. */
export function presentResourceActions(actions: ResourceAction[], surface: 'sdk' | 'mcp'): ResourceAction[] {
  return actions.map(action => ({ ...action,
    ...(action.tool ? { tool: presentResourceCall({ tool: action.tool, args: action.args ?? {} }, surface).tool } : {}),
    ...(action.recovery ? { recovery: presentResourceCall(action.recovery, surface) } : {}),
  }));
}

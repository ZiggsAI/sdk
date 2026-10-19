export { backendToolPick, type ToolPickOption, type ToolPickAnswer, type PickTool } from '@ziggs-ai/api-client';

/** What the picker is told a tool does: its title and the first sentence it says. */
export function pickLine(title: string, description: string): string {
  const first = description.split(/(?<=\.)\s/)[0] ?? '';
  return `${title}. ${first}`.slice(0, 300);
}

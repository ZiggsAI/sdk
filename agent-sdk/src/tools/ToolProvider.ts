export class ToolProvider {
  async getAvailableTools(): Promise<unknown[]> {
    throw new Error('getAvailableTools must be implemented');
  }
  async executeTool(_name: string, _args?: Record<string, unknown>, _context?: Record<string, unknown>): Promise<unknown> {
    throw new Error('executeTool must be implemented');
  }
  getTool(_name: string): unknown | null {
    throw new Error('getTool must be implemented');
  }
  _normalizeName(name: unknown): unknown {
    if (!name || typeof name !== 'string') return name;
    const prefixes = ['functions.', 'tools.', 'function.', 'tool.'];
    for (const prefix of prefixes) {
      if (name.startsWith(prefix)) return name.substring(prefix.length);
    }
    return name;
  }
}

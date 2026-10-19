import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolManager } from '../src/tools/ToolManager.js';
import { ToolProvider } from '../src/tools/ToolProvider.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTool(
  name: string,
  handler: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown> = async () => 'result',
  params: Record<string, unknown> | null = null,
) {
  const schema = { type: 'function' as const, function: { name, ...(params ? { parameters: params } : {}) } };
  return { schema, handler };
}

const REQUIRED_STRING_SCHEMA = {
  type: 'object',
  properties: { msg: { type: 'string' } },
  required: ['msg'],
};

// ── ToolProvider ──────────────────────────────────────────────────────────────

describe('ToolProvider._normalizeName', () => {
  const provider = new ToolManager(); // ToolManager inherits _normalizeName

  it('strips "functions." prefix', () => {
    assert.equal(provider._normalizeName('functions.my_tool'), 'my_tool');
  });

  it('strips "tools." prefix', () => {
    assert.equal(provider._normalizeName('tools.my_tool'), 'my_tool');
  });

  it('strips "function." prefix', () => {
    assert.equal(provider._normalizeName('function.my_tool'), 'my_tool');
  });

  it('strips "tool." prefix', () => {
    assert.equal(provider._normalizeName('tool.my_tool'), 'my_tool');
  });

  it('passes through names with no prefix', () => {
    assert.equal(provider._normalizeName('my_tool'), 'my_tool');
  });

  it('passes through null and undefined unchanged', () => {
    assert.equal(provider._normalizeName(null),      null);
    assert.equal(provider._normalizeName(undefined), undefined);
  });

  it('passes through non-string values unchanged', () => {
    assert.equal(provider._normalizeName(42), 42);
  });
});

describe('ToolProvider abstract methods', () => {
  class Bare extends ToolProvider {}
  const bare = new Bare();

  it('getAvailableTools throws not-implemented', async () => {
    await assert.rejects(() => bare.getAvailableTools(), /must be implemented/);
  });

  it('executeTool throws not-implemented', async () => {
    await assert.rejects(() => bare.executeTool('x'), /must be implemented/);
  });

  it('getTool throws not-implemented', () => {
    assert.throws(() => bare.getTool('x'), /must be implemented/);
  });
});

// ── ToolManager.register ──────────────────────────────────────────────────────

describe('ToolManager.register', () => {
  it('throws when tool has no schema', () => {
    const mgr = new ToolManager();
    assert.throws(() => mgr.register({ handler: async () => {} } as any), /must have a schema/);
  });

  it('throws when handler is not a function', () => {
    const mgr = new ToolManager();
    assert.throws(
      () => mgr.register({ schema: { type: 'function' as const, function: { name: 'x' } }, handler: 'nope' } as any),
      /must have a handler function/,
    );
  });

  it('throws when schema has no name', () => {
    const mgr = new ToolManager();
    assert.throws(
      () => mgr.register({ schema: { type: 'function' as const, function: {} }, handler: async () => {} } as any),
      /must have a name/,
    );
  });

  it('returns the registered tool name', () => {
    const mgr = new ToolManager();
    const name = mgr.register(makeTool('greet'));
    assert.equal(name, 'greet');
  });

  it('supports schema.name fallback (no schema.function wrapper)', () => {
    const mgr = new ToolManager();
    const tool = { schema: { name: 'flat_tool' }, handler: async () => {} } as any;
    const name = mgr.register(tool);
    assert.equal(name, 'flat_tool');
  });

  it('overwrites a previously registered tool with the same name', () => {
    const mgr = new ToolManager();
    const first  = makeTool('dup', async () => 'first');
    const second = makeTool('dup', async () => 'second');
    mgr.register(first);
    mgr.register(second);
    assert.equal(mgr.getTool('dup'), second);
  });
});

// ── ToolManager.registerAll ───────────────────────────────────────────────────

describe('ToolManager.registerAll', () => {
  it('registers multiple tools', async () => {
    const mgr = new ToolManager();
    mgr.registerAll([makeTool('a'), makeTool('b'), makeTool('c')]);
    const tools = await mgr.getAvailableTools();
    assert.equal(tools.length, 3);
  });

  it('handles an empty array without throwing', () => {
    const mgr = new ToolManager();
    assert.doesNotThrow(() => mgr.registerAll([]));
  });
});

// ── ToolManager.getAvailableTools / getTool ───────────────────────────────────

describe('ToolManager.getAvailableTools', () => {
  it('returns registered tools as an array', async () => {
    const mgr = new ToolManager();
    const tool = makeTool('ping');
    mgr.register(tool);
    const tools = await mgr.getAvailableTools();
    assert.ok(Array.isArray(tools));
    assert.equal(tools.length, 1);
    assert.equal(tools[0], tool);
  });

  it('returns empty array when no tools are registered', async () => {
    const mgr = new ToolManager();
    const tools = await mgr.getAvailableTools();
    assert.deepEqual(tools, []);
  });
});

describe('ToolManager.getTool', () => {
  it('returns a registered tool by its exact name', () => {
    const mgr  = new ToolManager();
    const tool = makeTool('say_hello');
    mgr.register(tool);
    assert.equal(mgr.getTool('say_hello'), tool);
  });

  it('normalizes prefixed names when looking up', () => {
    const mgr  = new ToolManager();
    const tool = makeTool('say_hello');
    mgr.register(tool);
    assert.equal(mgr.getTool('functions.say_hello'), tool);
    assert.equal(mgr.getTool('tools.say_hello'),     tool);
  });

  it('returns null for an unregistered tool', () => {
    const mgr = new ToolManager();
    assert.equal(mgr.getTool('nonexistent'), null);
  });
});

// ── ToolManager.executeTool ───────────────────────────────────────────────────

describe('ToolManager.executeTool', () => {
  it('calls handler with args and context and returns the result', async () => {
    const mgr     = new ToolManager();
    const handler = async (args: Record<string, unknown>, ctx: Record<string, unknown>) => ({ args, ctx });
    mgr.register(makeTool('echo', handler));

    const result = await mgr.executeTool('echo', { x: 1 }, { userId: 'u1' }) as { args: unknown; ctx: unknown };

    assert.deepEqual(result.args, { x: 1 });
    assert.deepEqual(result.ctx,  { userId: 'u1' });
  });

  it('throws with type tool_not_found for unregistered tool', async () => {
    const mgr = new ToolManager();
    await assert.rejects(
      () => mgr.executeTool('ghost'),
      (err: unknown) => {
        assert.equal((err as Record<string, unknown>).type, 'tool_not_found');
        return true;
      },
    );
  });

  it('resolves prefixed tool names during execution', async () => {
    const mgr = new ToolManager();
    mgr.register(makeTool('do_thing', async () => 'done'));
    const result = await mgr.executeTool('functions.do_thing');
    assert.equal(result, 'done');
  });

  it('strips null and undefined args before handler call', async () => {
    const mgr     = new ToolManager();
    let  captured = null;
    mgr.register(makeTool('spy', async (args) => { captured = args; }));

    await mgr.executeTool('spy', { keep: 'yes', drop: null, also: undefined });

    assert.deepEqual(captured, { keep: 'yes' });
  });

  it('throws with type validation_error when args fail schema', async () => {
    const mgr = new ToolManager();
    mgr.register(makeTool('strict', async () => 'ok', REQUIRED_STRING_SCHEMA));

    await assert.rejects(
      () => mgr.executeTool('strict', {}), // missing required field 'msg'
      (err: unknown) => {
        assert.equal((err as Record<string, unknown>).type, 'validation_error');
        assert.ok(Array.isArray((err as Record<string, unknown>).data && ((err as Record<string, Record<string, unknown>>).data).errors));
        return true;
      },
    );
  });

  it('passes validation when required args are provided', async () => {
    const mgr = new ToolManager();
    mgr.register(makeTool('strict', async (a: Record<string, unknown>) => a.msg, REQUIRED_STRING_SCHEMA));
    const result = await mgr.executeTool('strict', { msg: 'hello' });
    assert.equal(result, 'hello');
  });

  it('wraps handler errors with type tool_error', async () => {
    const mgr = new ToolManager();
    mgr.register(makeTool('boom', async () => { throw new Error('handler blew up'); }));

    await assert.rejects(
      () => mgr.executeTool('boom'),
      (err: unknown) => {
        assert.equal((err as Record<string, unknown>).type, 'tool_error');
        assert.match((err as Error).message, /handler blew up/);
        return true;
      },
    );
  });
});

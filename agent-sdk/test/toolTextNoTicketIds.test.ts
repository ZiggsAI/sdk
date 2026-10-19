import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARTIFACT_TOOLS,
  CHAT_TOOLS,
  CONNECTION_TOOLS,
  CONTEXT_TOOLS,
  DISCOVERY_TOOLS,
  GRANTS_TOOLS,
  LINK_TOOLS,
  MARKETPLACE_TOOLS,
  PAYMENT_TOOLS,
  PROTOCOL_TOOLS,
} from '../src/index.js';
import type { ToolDefinition } from '../src/tools/defineTool.js';

/**
 * ZIG-1128 — the same guard `ziggs-mcp/test/tool-descriptions.test.ts` applies to
 * the MCP surface, applied to the SDK's own tool surface.
 *
 * The ZIG-1056 sweep stripped ticket ids from user-facing strings, but it read
 * the MCP tool list and stopped there. The SDK's tier-1 tool definitions are
 * just as model-visible — they become the function schemas an LLM is handed —
 * and two references survived there (`protocolTools.ts` and
 * `api-client/src/capabilities/connections.ts`, the latter reached through the
 * capability adapter). An internal ticket id in a tool description is noise the
 * model has to read and cannot act on, and it leaks our tracker into a surface
 * third-party developers see.
 */
const BUNDLES: Array<[string, ToolDefinition[]]> = [
  ['PROTOCOL_TOOLS', PROTOCOL_TOOLS],
  ['PAYMENT_TOOLS', PAYMENT_TOOLS],
  ['CONNECTION_TOOLS', CONNECTION_TOOLS],
  ['DISCOVERY_TOOLS', DISCOVERY_TOOLS],
  ['MARKETPLACE_TOOLS', MARKETPLACE_TOOLS],
  ['CONTEXT_TOOLS', CONTEXT_TOOLS],
  ['GRANTS_TOOLS', GRANTS_TOOLS],
  ['LINK_TOOLS', LINK_TOOLS],
  ['ARTIFACT_TOOLS', ARTIFACT_TOOLS],
  ['CHAT_TOOLS', CHAT_TOOLS],
];

/** Everything about a tool the model actually sees: name, description, schema. */
function modelVisibleBlob(tool: ToolDefinition): string {
  return JSON.stringify(tool.schema?.function ?? {});
}

function toolName(tool: ToolDefinition): string {
  return String(
    (tool.schema?.function as { name?: unknown } | undefined)?.name ?? '<unnamed>',
  );
}

describe('SDK tool text (ZIG-1128)', () => {
  it('no model-visible tool text cites an internal ticket id', () => {
    const offenders: string[] = [];
    for (const [bundleName, tools] of BUNDLES) {
      assert.ok(
        tools.length > 0,
        `${bundleName} is empty — this guard would prove nothing`,
      );
      for (const tool of tools) {
        const found = modelVisibleBlob(tool).match(/ZIG-\d+/g);
        if (found) {
          offenders.push(`${bundleName}/${toolName(tool)}: ${[...new Set(found)].join(', ')}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `tool descriptions/schemas citing ZIG ids:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('every tool the model is handed has a name and a description', () => {
    const bare: string[] = [];
    for (const [bundleName, tools] of BUNDLES) {
      for (const tool of tools) {
        const fn = (tool.schema?.function ?? {}) as {
          name?: unknown;
          description?: unknown;
        };
        if (typeof fn.name !== 'string' || !fn.name.trim()) {
          bare.push(`${bundleName}: tool with no name`);
          continue;
        }
        if (typeof fn.description !== 'string' || !fn.description.trim()) {
          bare.push(`${bundleName}/${fn.name}: no description`);
        }
      }
    }
    assert.deepEqual(bare, [], `tools missing name/description:\n  ${bare.join('\n  ')}`);
  });
});

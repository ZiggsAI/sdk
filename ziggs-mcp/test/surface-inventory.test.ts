import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityMap, renderCapabilityMap } from '../../scripts/capability-map.mts';
import { DIRECTORY_TOOLS } from '../src/directorySurface.js';

describe('capability inventory from registered tools', () => {
  it('captures every configuration without contacting the backend or running a tool', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => {
      throw new Error('schema inspection must not contact the backend');
    });
    try {
      const inventory = await capabilityMap();
      assert.deepEqual(inventory.surfaces.consent.tools.map((tool) => tool.name).sort(), [...DIRECTORY_TOOLS].sort());
      assert.ok(inventory.surfaces.direct.catalog.some((tool) => tool.name === 'ziggs_message_send'));
      const open = inventory.surfaces.consent.tools.find((tool) => tool.name === 'ziggs_message_send');
      assert.ok(open?.inputSchema.properties?.command, 'captured schemas retain the domain command');
      assert.ok(inventory.surfaces.consent.catalog.every((entry) => inventory.surfaces.consent.tools.some((tool) => tool.name === entry.name)), 'every directory catalog entry is listed natively');
      assert.ok(inventory.sdkTools.includes('message_send'), 'SDK names use the same toolName resolver as execution');
      assert.equal(fetch.mock.calls.length, 0);
      const rendered = renderCapabilityMap(inventory);
      assert.ok(rendered.includes(`| consent | ${DIRECTORY_TOOLS.size} | 0 | ${DIRECTORY_TOOLS.size} |`));
      assert.ok(rendered.includes('`ziggs_message_send`'));
      assert.ok(rendered.includes('`message_send`'));
    } finally { fetch.mock.restore(); }
  });
});

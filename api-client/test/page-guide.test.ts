import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_GUIDE, pageGuideCapability } from '../src/capabilities/pageGuide.js';
import { mcpDescription } from '../src/capabilities/mcpBriefs.js';

describe('page_guide', () => {
  it('returns the guide without calling the backend', async () => {
    const result = await pageGuideCapability.handler({}, {
      creds: { operatorKey: 'op_test' },
      surface: 'mcp',
    });
    assert.equal((result as { guide: string }).guide, PAGE_GUIDE);
  });

  it('is the three sections a working page needs', () => {
    assert.match(PAGE_GUIDE, /^LIVE HTML PAGES\n/);
    assert.match(PAGE_GUIDE, /\nFEEDING A PAGE\n/);
    assert.match(PAGE_GUIDE, /\nFORMS ON A PAGE\n/);
    assert.match(PAGE_GUIDE, /window\.ziggs/);
    assert.match(PAGE_GUIDE, /ziggs\.submit/);
    assert.match(PAGE_GUIDE, /Open this as a page to use it/);
    assert.match(PAGE_GUIDE, /Never use a <form> that submits/);
  });

  it('fits the MCP description budget', () => {
    const text = mcpDescription('ziggs_page_guide', 'read-only');
    assert.ok(text.length <= 250, text.length);
  });
});

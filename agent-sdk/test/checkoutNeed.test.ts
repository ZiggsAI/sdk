/**
 * The checkout need: declared like a connection need, enforced like one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defineAgent } from '../src/defineAgent.js';
import { toolName } from '../src/tools/defineTool.js';
import {
  describeNeed,
  isCheckoutNeed,
  normalizeNeeds,
  toolsForNeeds,
  unmetNeeds,
  unmetNeedsMessage,
} from '../src/tools/needs.js';
import { checkoutBranchForTask, checkoutTargetFromTask, checkoutTargetFromText } from '../src/checkout/intake.js';
import { doorPathFor, doorHeaders } from '../src/checkout/boxClient.js';

const parked = {
  initial: 'ready',
  states: { ready: { kind: 'parked' as const, transitions: [] } },
};
const names = (tools: unknown[]) => tools.map((t) => toolName(t as never)).filter(Boolean) as string[];

describe('a checkout need', () => {
  it('is read from the manifest next to a connection need', () => {
    const needs = normalizeNeeds([{ connection: 'mcp' }, { checkout: 'git' }, { checkout: 'svn' }, {}]);
    assert.deepEqual(needs, [{ connection: 'mcp' }, { checkout: 'git' }]);
    assert.ok(isCheckoutNeed(needs[1]));
    assert.ok(!isCheckoutNeed(needs[0]));
  });

  it('produces the checkout tools and the grant lister', () => {
    const got = names(toolsForNeeds([{ checkout: 'git' }]));
    assert.deepEqual(
      [...got].sort(),
      ['checkout_push', 'checkout_read', 'checkout_run', 'checkout_write', 'connection_list_grants'],
    );
  });

  it('merges with an MCP need instead of registering the lister twice', () => {
    const got = names(toolsForNeeds([{ connection: 'mcp' }, { checkout: 'git' }]));
    assert.equal(new Set(got).size, got.length);
    assert.ok(got.includes('mcp_tool_call'));
    assert.ok(got.includes('checkout_push'));
  });

  it('an agent that declares it gets the tools without listing them', () => {
    const config = defineAgent({ agentId: 'coder', description: 'd', needs: [{ checkout: 'git' }], ...parked });
    assert.ok(names(config.tools).includes('checkout_run'));
    assert.deepEqual(config.needs, [{ checkout: 'git' }]);
  });

  it('is met by a GitHub grant, directly or through an MCP connection, and by nothing else', () => {
    const need = [{ checkout: 'git' as const }];
    assert.deepEqual(unmetNeeds(need, ['github — acme']), []);
    assert.deepEqual(unmetNeeds(need, ['mcp']), []);
    assert.deepEqual(unmetNeeds(need, ['linear']), need);
    assert.deepEqual(unmetNeeds(need, []), need);
  });

  it('refuses by name', () => {
    assert.equal(describeNeed({ checkout: 'git' }), 'a GitHub connection (for the checkout)');
    assert.match(unmetNeedsMessage([{ checkout: 'git' }]), /no live grant for a GitHub connection \(for the checkout\)/);
  });
});

describe('what the task names', () => {
  it('reads owner/name and a base branch from the task text', () => {
    assert.deepEqual(checkoutTargetFromText('Add a page to ZiggsAI/frontend, base branch main.'), {
      repository: 'ZiggsAI/frontend', owner: 'ZiggsAI', name: 'frontend', baseBranch: 'main',
    });
    assert.deepEqual(checkoutTargetFromText('In acme/site-v2.git, change the footer (branch: release/1.2).'), {
      repository: 'acme/site-v2', owner: 'acme', name: 'site-v2', baseBranch: 'release/1.2',
    });
  });

  it('accepts a GitHub URL and defaults the base branch to the repository default', () => {
    const t = checkoutTargetFromText('Repository https://github.com/ZiggsAI/frontend. Add a page.');
    assert.equal(t?.repository, 'ZiggsAI/frontend');
    assert.equal(t?.baseBranch, null);
  });

  it('does not mistake a path or a figure of speech for a repository', () => {
    assert.equal(checkoutTargetFromText('Edit src/pages/index.tsx and/or the header'), null);
    assert.equal(checkoutTargetFromText('Change the copy on the home page'), null);
  });

  it('reads the title before the description', () => {
    const t = checkoutTargetFromTask({ title: 'ZiggsAI/frontend: add a page', description: 'see acme/other' });
    assert.equal(t?.repository, 'ZiggsAI/frontend');
  });

  it('keeps dotted names and reads a base branch from the description', () => {
    for (const text of ['acme/site.web', 'https://github.com/acme/site.web', 'https://github.com/acme/site.web.git.']) {
      assert.equal(checkoutTargetFromText(text)?.repository, 'acme/site.web');
    }
    assert.deepEqual(checkoutTargetFromTask({ title: 'Fix acme/site', description: 'Use base branch release/2.0' }), {
      repository: 'acme/site', owner: 'acme', name: 'site', baseBranch: 'release/2.0',
    });
  });

  it('lands on agent/<task id>, never the base branch', () => {
    assert.equal(checkoutBranchForTask('task_ABC.1'), 'agent/task_abc.1');
    assert.equal(checkoutBranchForTask('weird id!'), 'agent/weird-id-');
  });
});

describe('the git relay maps the box to the door', () => {
  const door = {
    backendUrl: 'http://backend', operatorKey: 'op', agentId: 'a1', laneId: 'chat_1',
    connectionId: 'con_1', grantId: 'cgr_1', taskId: 'task_1', repository: { owner: 'ZiggsAI', name: 'frontend' },
  };

  it('maps the three smart-http paths onto the connection door', () => {
    assert.equal(
      doorPathFor('/ZiggsAI/frontend.git/info/refs?service=git-upload-pack', door),
      '/connections/con_1/git/ZiggsAI/frontend/info/refs?service=git-upload-pack',
    );
    assert.equal(doorPathFor('/ZiggsAI/frontend.git/git-receive-pack', door), '/connections/con_1/git/ZiggsAI/frontend/git-receive-pack');
    assert.equal(doorPathFor('/ziggsai/frontend/git-upload-pack', door), '/connections/con_1/git/ziggsai/frontend/git-upload-pack');
  });

  it('serves the task\'s repository only', () => {
    assert.equal(doorPathFor('/ZiggsAI/backend.git/info/refs?service=git-upload-pack', door), null);
    assert.equal(doorPathFor('/ZiggsAI/frontend.git/../x', door), null);
    assert.equal(doorPathFor('/etc/passwd', door), null);
  });

  it('sends the room and hire as separate wake headers', () => {
    const h = doorHeaders({ ...door, laneId: 'chat_1@agr_1' }, {});
    assert.equal(h['x-ziggs-lane'], undefined);
    assert.equal(h['x-ziggs-agreement'], undefined);
  });

  it('presents the host\'s grant, the lane and the task, and only git\'s own headers', () => {
    const h = doorHeaders(door, { 'content-type': 'application/x-git-upload-pack-request', cookie: 'no', 'git-protocol': 'version=2' });
    assert.equal(h.authorization, 'Bearer op');
    assert.equal(h['x-agent-id'], 'a1');
    assert.equal(h['x-grant-id'], 'cgr_1');
    assert.equal(h['x-ziggs-lane'], undefined);
    assert.equal(h['x-ziggs-task-id'], 'task_1');
    assert.equal(h['git-protocol'], 'version=2');
    assert.equal(h['cookie'], undefined);
  });
});

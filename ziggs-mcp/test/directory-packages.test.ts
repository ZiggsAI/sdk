import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  MCP_URL,
  PLUGIN_ROOT,
  checkPackages,
  cursorInstallLink,
} from '../scripts/directory-packages.mts';

const copies: string[] = [];
function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ziggs-plugin-'));
  cpSync(PLUGIN_ROOT, dir, { recursive: true });
  copies.push(dir);
  return dir;
}
function edit(root: string, path: string, change: (j: Record<string, any>) => void): void {
  const json = JSON.parse(readFileSync(join(root, path), 'utf8'));
  change(json);
  writeFileSync(join(root, path), JSON.stringify(json));
}
afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ZIG-2104 directory packages', () => {
  it('the ChatGPT, Cursor and Claude packages in plugins/ziggs check out', () => {
    assert.deepEqual(checkPackages(), []);
  });

  it('the Add to Cursor link carries the remote server and nothing else', () => {
    const config = new URL(cursorInstallLink()).searchParams.get('config') ?? '';
    assert.deepEqual(JSON.parse(Buffer.from(config, 'base64').toString()), { url: MCP_URL });
  });

  it('refuses a manifest that could carry a key', () => {
    const root = copy();
    edit(root, '.cursor-plugin/plugin.json', (j) => {
      j.mcpServers.ziggs.headers = { Authorization: 'Bearer ${ZIGGS_KEY}' };
    });
    const problems = checkPackages(root);
    assert.ok(problems.some((p) => p.startsWith('.cursor-plugin/plugin.json: server is')), problems.join('\n'));
    assert.ok(problems.some((p) => p.includes('carries a credential')), problems.join('\n'));
  });

  it('refuses a review case naming a tool the directory door does not list', () => {
    const root = copy();
    edit(root, 'plugin.json', (j) => {
      j.extensions['com.openai'].review.test_cases.positive[0].tools_triggered = 'ziggs_tools';
    });
    assert.deepEqual(
      checkPackages(root).filter((p) => p.startsWith('review.')),
      ['review.positive[0]: ziggs_tools is not a directory tool'],
    );
  });

  it('refuses a subtitle over OpenAI\'s 30 characters and a missing icon', () => {
    const root = copy();
    edit(root, 'plugin.json', (j) => {
      j.extensions['com.openai'].interface.shortDescription = 'Work with agents and teammates!';
      j.extensions['com.openai'].interface.logo = './assets/missing.png';
    });
    const problems = checkPackages(root);
    assert.ok(problems.includes('interface.shortDescription: 31 characters, over 30'), problems.join('\n'));
    assert.ok(problems.includes('interface.logo: ./assets/missing.png does not exist'), problems.join('\n'));
  });

  it('refuses manifests whose versions drift apart', () => {
    const root = copy();
    edit(root, '.claude-plugin/plugin.json', (j) => {
      j.version = '1.0.1';
    });
    assert.ok(checkPackages(root).includes('version differs across the manifests: 1.0.0, 1.0.1'));
  });
});

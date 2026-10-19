/**
 * Skill parser + validator, and the factory's prompt/pin/collision rules.
 *
 * The instructions-only policy is the security property this whole path rests
 * on, so most of what is asserted here is what gets REFUSED.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSkill,
  skillHash,
  skillRolePrompt,
  skillReferenceOneLine,
  splitFrontmatter,
  SkillValidationError,
  type SkillFile,
} from '../src/skills/parseSkill.js';
import { skillReadReferenceTool } from '../src/skills/skillReadReference.js';
import { loadSkill, assertSkillHash } from '../src/skills/loadSkill.js';
import { warnOnShadowedPlatformTools } from '../src/Agent.js';
import type { ToolDefinition } from '../src/tools/defineTool.js';
import { CLAUDE_SDK_PROTOCOL } from '../src/brain/claudeSdkProtocol.js';

const file = (path: string, content: string): SkillFile => ({ path, bytes: Buffer.from(content, 'utf-8') });

const GOOD_SKILL = `---
name: changelog-writer
description: Turns a list of merged changes into a release note a customer can read.
---

You write release notes.

Group changes by what a user can now do, not by which module moved.`;

const goodPackage = (): SkillFile[] => [file('SKILL.md', GOOD_SKILL)];

describe('splitFrontmatter', () => {
  it('reads scalar keys and returns the body', () => {
    const { frontmatter, body } = splitFrontmatter(GOOD_SKILL);
    assert.equal(frontmatter['name'], 'changelog-writer');
    assert.match(frontmatter['description'], /^Turns a list/);
    assert.match(body, /^You write release notes\./);
    assert.ok(!body.includes('---'));
  });

  it('strips one layer of quotes and tolerates CRLF + BOM', () => {
    const { frontmatter } = splitFrontmatter('﻿---\r\nname: "quoted"\r\ndescription: \'also quoted\'\r\n---\r\n\r\nbody');
    assert.equal(frontmatter['name'], 'quoted');
    assert.equal(frontmatter['description'], 'also quoted');
  });

  it('treats a file with no frontmatter as all body', () => {
    const { frontmatter, body } = splitFrontmatter('just markdown');
    assert.deepEqual(frontmatter, {});
    assert.equal(body, 'just markdown');
  });
});

describe('parseSkill — accepted layout', () => {
  it('maps frontmatter to fields and keeps the body internal', () => {
    const skill = parseSkill(goodPackage());
    assert.equal(skill.name, 'changelog-writer');
    assert.equal(skill.description, 'Turns a list of merged changes into a release note a customer can read.');
    assert.match(skill.body, /^You write release notes\./);
    assert.deepEqual(skill.references, []);
    assert.match(skill.hash, /^[0-9a-f]{64}$/);
  });

  it('accepts references/*.md and sorts them by path', () => {
    const skill = parseSkill([
      ...goodPackage(),
      file('references/tone.md', 'Be plain.'),
      file('references/audience.md', 'Customers, not engineers.'),
    ]);
    assert.deepEqual(
      skill.references.map((r) => r.path),
      ['references/audience.md', 'references/tone.md'],
    );
  });
});

describe('parseSkill — instructions-only, hard reject', () => {
  const rejects = (files: SkillFile[], pattern: RegExp) => {
    assert.throws(() => parseSkill(files), (err: unknown) => {
      assert.ok(err instanceof SkillValidationError, `expected SkillValidationError, got ${err}`);
      assert.match((err as Error).message, pattern);
      return true;
    });
  };

  it('refuses a scripts/ folder', () => {
    rejects([...goodPackage(), file('scripts/run.py', 'print(1)')], /instructions-only.*scripts\/run\.py/s);
  });

  it('refuses assets and any non-markdown file', () => {
    rejects([...goodPackage(), file('assets/logo.png', 'binary')], /instructions-only/);
    rejects([...goodPackage(), file('config.json', '{}')], /instructions-only/);
  });

  it('refuses markdown outside references/', () => {
    rejects([...goodPackage(), file('EXTRA.md', 'hi')], /instructions-only/);
    rejects([...goodPackage(), file('references/nested/deep.md', 'hi')], /instructions-only/);
  });

  it('refuses a package with no SKILL.md', () => {
    rejects([file('references/tone.md', 'Be plain.')], /no SKILL\.md/);
  });

  it('refuses an empty package', () => {
    rejects([], /empty/);
  });

  it('refuses missing name or description', () => {
    rejects([file('SKILL.md', '---\ndescription: d\n---\n\nbody')], /missing a "name"/);
    rejects([file('SKILL.md', '---\nname: n\n---\n\nbody')], /missing a "description"/);
    rejects([file('SKILL.md', 'no frontmatter at all')], /missing a "name"/);
  });

  it('refuses frontmatter with an empty body', () => {
    rejects([file('SKILL.md', '---\nname: n\ndescription: d\n---\n')], /no body/);
  });

  it('refuses content over the size cap, counting references', () => {
    const big = 'x'.repeat(500);
    assert.throws(
      () => parseSkill([...goodPackage(), file('references/big.md', big)], { maxChars: 200 }),
      /over the 200 limit/,
    );
  });

  // A nested value is not silently flattened into a usable name — it fails the
  // required-field check instead, which is the loud outcome.
  it('refuses a non-scalar name', () => {
    rejects([file('SKILL.md', '---\nname:\n  - a\ndescription: d\n---\n\nbody')], /missing a "name"/);
  });
});

describe('skillHash — the pin', () => {
  it('is stable across runs and independent of file order', () => {
    const a = [...goodPackage(), file('references/tone.md', 'Be plain.')];
    const b = [file('references/tone.md', 'Be plain.'), ...goodPackage()];
    assert.equal(skillHash(a), skillHash(b));
    assert.equal(skillHash(a), skillHash(a));
  });

  it('changes when any byte changes', () => {
    const base = skillHash(goodPackage());
    assert.notEqual(base, skillHash([file('SKILL.md', `${GOOD_SKILL} `)]));
    assert.notEqual(base, skillHash([...goodPackage(), file('references/tone.md', 'Be plain.')]));
  });

  // Length-delimiting the path is what stops `a/bc` + `d` colliding with `a/b` + `cd`.
  it('does not collide when a path boundary shifts', () => {
    assert.notEqual(
      skillHash([file('SKILL.md', 'a'), file('references/bc.md', 'd')]),
      skillHash([file('SKILL.md', 'a'), file('references/b.md', 'cd')]),
    );
  });
});

describe('assertSkillHash', () => {
  it('passes when unpinned or matching, throws on drift', () => {
    const skill = parseSkill(goodPackage());
    assert.doesNotThrow(() => assertSkillHash(skill, undefined, 'x'));
    assert.doesNotThrow(() => assertSkillHash(skill, skill.hash, 'x'));
    assert.throws(() => assertSkillHash(skill, 'deadbeef', '/skills/foo'), /never auto-update/);
  });
});

describe('skillRolePrompt', () => {
  it('puts the body first and catalogs references without their bodies', () => {
    const skill = parseSkill([...goodPackage(), file('references/tone.md', 'Be plain.')]);
    const prompt = skillRolePrompt(skill);
    assert.ok(prompt.startsWith('You write release notes.'));
    assert.match(prompt, /skill_read_reference/);
    assert.match(prompt, /- tone: Be plain\./);
    assert.doesNotMatch(prompt, /## Reference: tone\n\nBe plain\./);
  });

  // The protocol block is prepended by the Claude-brain prompt assembly, and the
  // skill is the role block that follows. A skill can never sit above protocol.
  it('is a role block only — it carries no protocol text of its own', () => {
    const prompt = skillRolePrompt(parseSkill(goodPackage()));
    assert.ok(!prompt.includes(CLAUDE_SDK_PROTOCOL));
    const assembled = [CLAUDE_SDK_PROTOCOL, `## Your role\n${prompt}`].join('\n');
    assert.ok(assembled.indexOf(CLAUDE_SDK_PROTOCOL) < assembled.indexOf(prompt));
  });
});

describe('skill_read_reference', () => {
  it('returns one file and refuses an unknown name', async () => {
    const skill = parseSkill([
      ...goodPackage(),
      file('references/tone.md', 'Be plain.'),
    ]);
    const tool = skillReadReferenceTool(skill);
    const ok = await tool.handler({ name: 'tone' }, {});
    assert.deepEqual(ok, {
      name: 'tone',
      path: 'references/tone.md',
      content: 'Be plain.',
    });
    await assert.rejects(
      () => tool.handler({ name: 'missing' }, {}),
      /unknown skill reference "missing"/,
    );
  });

  it('picks the first prose line for the catalog, skipping headings', () => {
    assert.equal(
      skillReferenceOneLine('# Title\n\nHooks automatically run commands.\nMore.'),
      'Hooks automatically run commands.',
    );
  });

  it('does not inline vendored reference bodies on the published skill', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ziggs-skill-'));
    await mkdir(join(dir, 'references'), { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), GOOD_SKILL);
    await writeFile(
      join(dir, 'references', 'hooks-patterns.md'),
      'Hooks automatically run commands.\n\nCode stays formatted without thinking about it.\n',
    );
    const skill = await loadSkill(dir);
    const prompt = skillRolePrompt(skill);
    assert.match(prompt, /skill_read_reference/);
    assert.match(prompt, /- hooks-patterns:/);
    assert.doesNotMatch(prompt, /Code stays formatted without thinking about it/);
  });
});

describe('loadSkill — from disk', () => {
  const writeSkillDir = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'ziggs-skill-'));
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, content, 'utf-8');
    }
    return dir;
  };

  it('reads a folder, validates it, and honours the pin', async () => {
    const dir = await writeSkillDir({ 'SKILL.md': GOOD_SKILL, 'references/tone.md': 'Be plain.' });
    const skill = await loadSkill(dir);
    assert.equal(skill.name, 'changelog-writer');
    assert.deepEqual(skill.references.map((r) => r.path), ['references/tone.md']);
    await assert.doesNotReject(() => loadSkill(dir, { expectedHash: skill.hash }));
    await assert.rejects(() => loadSkill(dir, { expectedHash: 'nope' }), /does not match its pinned hash/);
  });

  // The walk must SEE rejected files, not filter them — otherwise a skill with a
  // scripts/ folder imports cleanly and its author believes the script runs.
  it('rejects a folder containing scripts/', async () => {
    const dir = await writeSkillDir({ 'SKILL.md': GOOD_SKILL, 'scripts/run.sh': 'echo hi' });
    await assert.rejects(() => loadSkill(dir), /instructions-only/);
  });
});

describe('warnOnShadowedPlatformTools', () => {
  const tool = (name: string): ToolDefinition => ({
    schema: { type: 'function', function: { name, description: '', parameters: {} } },
    handler: async () => ({}),
  });

  // ToolManager is a Map keyed by name and the agent's own tools register
  // last, so a same-named MCP/extra tool silently replaces the platform one.
  // This warning is the ONLY thing that makes that visible — an agent that
  // loses task_set_result to a remote tool otherwise just looks confused.
  it('names every shadowed platform tool at boot', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    warnOnShadowedPlatformTools(
      [tool('task_set_result'), tool('context_snapshot')],
      [tool('task_set_result'), tool('context_snapshot'), tool('search_web')],
      'a1',
    );
    assert.equal(warn.mock.callCount(), 1);
    const message = String(warn.mock.calls[0].arguments[0]);
    assert.match(message, /a1/);
    assert.match(message, /task_set_result, context_snapshot/);
  });

  it('stays silent when nothing clashes', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    warnOnShadowedPlatformTools([tool('task_set_result')], [tool('search_web')], 'a1');
    warnOnShadowedPlatformTools([tool('task_set_result')], [], 'a1');
    assert.equal(warn.mock.callCount(), 0);
  });
});

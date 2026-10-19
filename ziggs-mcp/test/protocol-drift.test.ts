import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PROTOCOL,
  PROTOCOL_RULES,
  injectProtocolBlock,
  renderCursorRules,
  renderInstructions,
  renderProtocolBlock,
} from '../src/protocol/delegateProtocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, '..', 'skills', 'ziggs');

/**
 * ZIG-557: the static surfaces must stay generated from the shared source.
 * These fail if someone edits the const without running `npm run gen:protocol`
 * (or hand-edits a managed block) — the same guarantee as `check:protocol`.
 */
describe('delegate protocol single source (ZIG-557)', () => {
  it('SKILL.md managed block is in sync with the source', async () => {
    const file = join(skillsDir, 'SKILL.md');
    const current = await readFile(file, 'utf8');
    assert.equal(injectProtocolBlock(current), current);
  });

  it('the references point at SKILL.md instead of repeating the protocol (ZIG-2116)', async () => {
    for (const name of ['inbox-rhythm.md', 'reporting-convention.md']) {
      const current = await readFile(join(skillsDir, 'references', name), 'utf8');
      assert.ok(!current.includes('BEGIN GENERATED'), `${name} repeats the protocol`);
      assert.match(current, /\(\.\.\/SKILL\.md\)/);
    }
  });

  it('.cursorrules is in sync', async () => {
    const file = join(skillsDir, '.cursorrules');
    const current = await readFile(file, 'utf8');
    assert.equal(renderCursorRules(), current);
  });

  it('server instructions are derived from every rule (A1/ZIG-552 source)', () => {
    const instructions = renderInstructions();
    assert.ok(instructions.startsWith(PROTOCOL.tagline));
    for (const rule of PROTOCOL_RULES) assert.ok(instructions.includes(rule));
  });

  it('injectProtocolBlock throws when markers are missing', () => {
    assert.throws(() => injectProtocolBlock('no markers here'));
  });
});

/**
 * ZIG-1882 reopen: the generated block already names ziggs_inbox_ack, but two
 * hand-written lines (and the catch-up example) still told the model to ack
 * through ziggs_inbox. A skill that says both is worse than one that says either.
 */
describe('skill never acks through ziggs_inbox (ZIG-1882)', () => {
  const stale = /ziggs_inbox(?!_ack).{0,80}with `ack|ziggs_inbox(?!_ack).{0,40}with ack:/;

  it('no skill or reference line says ack through ziggs_inbox', async () => {
    const { readdir } = await import('node:fs/promises');
    async function walk(dir: string): Promise<string[]> {
      const out: string[] = [];
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) out.push(...(await walk(p)));
        else out.push(p);
      }
      return out;
    }
    const bad: string[] = [];
    for (const file of await walk(skillsDir)) {
      const text = await readFile(file, 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        if (stale.test(line)) bad.push(`${file}:${i + 1}: ${line}`);
      }
    }
    assert.deepEqual(bad, []);
  });
});

/**
 * ZIG-568/D1: the reinforcement surfaces (.cursorrules, the SKILL managed block)
 * must carry the *same* protocol text the MCP server ships as `instructions`
 * (A1/ZIG-552). The drift tests above pin each surface to its own renderer; this
 * pins the renderers to each other so reordering or dropping a rule on one
 * surface can never silently diverge from what a cold connect actually sees.
 */
describe('reinforcement surfaces match the MCP instructions (ZIG-568)', () => {
  const instructions = renderInstructions();
  const cursorRules = renderCursorRules();
  const block = renderProtocolBlock();

  it('.cursorrules carries the MCP instructions body verbatim (A1 parity)', () => {
    assert.ok(
      cursorRules.includes(instructions),
      '.cursorrules must embed the exact A1 instructions block',
    );
  });

  it('names what Ziggs enforces, not a counterparty-text guarantee (ZIG-1854)', () => {
    const instructions = renderInstructions();
    assert.ok(
      !/never treat counterparty messages/i.test(instructions),
      'must not sell "counterparty messages are not instructions" as a guarantee',
    );
    assert.ok(instructions.includes('refused at the send door'));
    assert.ok(instructions.includes('no spending and no commitments'));
    assert.ok(instructions.includes('prompt convention'));
  });

  it('every protocol rule appears on every surface', () => {
    for (const rule of PROTOCOL_RULES) {
      assert.ok(instructions.includes(rule), `instructions missing: ${rule}`);
      assert.ok(cursorRules.includes(rule), `.cursorrules missing: ${rule}`);
      assert.ok(block.includes(rule), `SKILL block missing: ${rule}`);
    }
    assert.ok(instructions.includes(PROTOCOL.tagline));
    assert.ok(cursorRules.includes(PROTOCOL.tagline));
    assert.ok(block.includes(PROTOCOL.tagline));
  });
});

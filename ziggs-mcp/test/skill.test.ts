import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const skillRoot = new URL('../skills/ziggs/', import.meta.url);

function collectMarkdownFiles(dir: URL): string[] {
  const paths: string[] = [];
  for (const name of readdirSync(dir)) {
    const child = new URL(name, dir);
    if (name.endsWith('.md')) paths.push(readFileSync(child, 'utf8'));
    else if (!name.includes('.')) {
      paths.push(...collectMarkdownFiles(new URL(`${name}/`, dir)));
    }
  }
  return paths;
}

describe('ZIG-437 ziggs skill files', () => {
  const bodies = collectMarkdownFiles(skillRoot);

  it('includes SKILL.md and references', () => {
    assert.ok(bodies.length >= 4);
  });

  it('contain no credentials or endpoint URLs (skill layer only)', () => {
    const forbidden = [
      /https?:\/\//i,
      /\blin_api_[A-Za-z0-9]+/,
      /\bop_[A-Za-z0-9._-]{8,}/,
      /Bearer\s+<[^>]+>/i,
      /ZIGGS_OPERATOR_KEY\s*=/,
    ];
    for (const body of bodies) {
      for (const re of forbidden) {
        assert.ok(
          !re.test(body),
          `forbidden pattern ${re} in skill markdown`,
        );
      }
    }
  });

  it('documents inbox-first rhythm', () => {
    const skill = readFileSync(new URL('SKILL.md', skillRoot), 'utf8');
    assert.match(skill, /ziggs_inbox/);
    assert.match(skill, /inbox → read \(delta\) → act → ack/);
  });
});

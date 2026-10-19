/**
 * ZIG-1120 — pin the ziggs_inbox handler wiring that used to pay for work
 * nothing reads: listTasks after every poll, and a full grant walk on idle.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const toolsSrc = readFileSync(
  fileURLToPath(new URL('../src/tools.ts', import.meta.url)),
  'utf8',
);

/** Slice of tools.ts from the ziggs_inbox registration through the next tool. */
function inboxHandlerSource(): string {
  const start = toolsSrc.indexOf(
    "registerStrictTool(\n    server,\n    'ziggs_inbox'",
  );
  assert.ok(start >= 0, 'ziggs_inbox registration present');
  const next = toolsSrc.indexOf('registerCapabilities(server, GRANTS_CAPABILITIES', start);
  assert.ok(next > start, 'grants registration follows inbox');
  return toolsSrc.slice(start, next);
}

describe('ZIG-1120 ziggs_inbox dead-work wiring', () => {
  it('does not call listTasks (activeWorkCount comes from tasksAwaitingMe)', () => {
    const body = inboxHandlerSource();
    assert.equal(
      /listTasks\s*\(/.test(body),
      false,
      'ziggs_inbox must not round-trip listTasks — inbox.tasksAwaitingMe already carries the count',
    );
    assert.match(body, /formatInboxToolResult\([\s\S]*undefined/);
  });

  it('skips listAllGrants when deliveries is empty', () => {
    const body = inboxHandlerSource();
    assert.match(
      body,
      /deliveries\?\.length/,
      'grant walk must be gated on deliveries.length',
    );
    assert.match(body, /listAllGrants/);
  });

  it('acks through ackOrTakeHost so a departed host does not cost a second wake', () => {
    const body = inboxHandlerSource();
    assert.match(body, /ackOrTakeHost\s*\(/);
    assert.equal(
      /client\.ack\s*\(/.test(body),
      false,
      'bare ack cannot take an expired inbox; the recovery lives on ackOrTakeHost',
    );
  });
});

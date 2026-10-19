import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HANDLE_ALPHABET, findHandles, parseHandle, parseRef } from '../src/handles.js';

/** The server's check letter (Luhn mod 32), to build fixtures. */
function withCheck(body: string): string {
  let factor = 2;
  let sum = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    let addend = factor * HANDLE_ALPHABET.indexOf(body[i]);
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / 32) + (addend % 32);
    sum += addend;
  }
  return body + HANDLE_ALPHABET[(32 - (sum % 32)) % 32];
}

describe('short handles', () => {
  const task = withCheck('T7K2QX');
  it('reads a handle in any case and names its kind', () => {
    assert.deepEqual(parseHandle(task.toLowerCase()), { kind: 'task', id: task });
    assert.equal(parseHandle(withCheck('C9HDF2'))?.kind, 'chat');
    assert.equal(parseHandle(withCheck('A3MWR8'))?.kind, 'agreement');
    assert.equal(parseHandle(withCheck('FQ4N7T'))?.kind, 'artifact');
  });
  it('refuses a typo before any call', () => {
    const typo = task.slice(0, 6) + (task[6] === '0' ? '1' : '0');
    assert.equal(parseHandle(typo), null);
    assert.equal(parseRef(typo), null);
  });
  it('reads a Ziggs URL and older ids', () => {
    assert.deepEqual(parseRef(`https://ziggsai.com/app/open/${task}`), { kind: 'task', id: task });
    assert.equal(parseRef('agr_1791956531449_if5x724t')?.kind, 'agreement');
    assert.equal(parseRef('eufateaglljwkqosgycqxhbj')?.kind, 'chat');
  });
  it('finds the handles named in free text, once each, and no look-alike words', () => {
    const chat = withCheck('C9HDF2');
    const text = `look at ${task} and ${chat.toLowerCase()}, then ${task} again. CATEGORY is a word.`;
    assert.deepEqual(findHandles(text).map((h) => h.id), [task, chat]);
  });
});

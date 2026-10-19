import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseListFields,
  pickListedRow,
  pickListedRows,
} from '../src/capabilities/listedFields.js';

describe('list fields projection (ZIG-1444)', () => {
  it('omission leaves the row untouched', () => {
    const row = { taskId: 't1', description: 'x', plan: { steps: [] } };
    assert.deepEqual(pickListedRow(row, undefined), row);
    assert.deepEqual(pickListedRows([row], undefined), [row]);
  });

  it('keeps only the named keys, in the order asked', () => {
    const row = { taskId: 't1', state: 'active', description: 'long', plan: {} };
    assert.deepEqual(pickListedRow(row, ['taskId', 'state']), {
      taskId: 't1',
      state: 'active',
    });
  });

  it('skips a key that this row does not have rather than inventing null', () => {
    assert.deepEqual(pickListedRow({ taskId: 't1' }, ['taskId', 'title']), {
      taskId: 't1',
    });
  });

  it('refuses an empty or non-array fields value', () => {
    assert.throws(() => parseListFields([]), /non-empty array/);
    assert.throws(() => parseListFields('taskId'), /non-empty array/);
    assert.equal(parseListFields(undefined), undefined);
  });

  it('dedupes names and rejects blank entries', () => {
    assert.deepEqual(parseListFields(['taskId', 'taskId', 'state']), [
      'taskId',
      'state',
    ]);
    assert.throws(() => parseListFields(['taskId', '']), /non-empty strings/);
  });
});

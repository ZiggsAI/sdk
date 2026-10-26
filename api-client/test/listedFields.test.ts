import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  listedFieldNote,
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

  it('resolves the names list rows actually store', () => {
    assert.deepEqual(
      pickListedRow(
        {
          description: 'Research',
          providerAgent: 'agent-1',
          provider: 'org-1',
          engagementKind: 'hire',
        },
        ['name', 'agentId', 'providerId', 'kind'],
      ),
      {
        name: 'Research',
        agentId: 'agent-1',
        providerId: 'org-1',
        kind: 'hire',
      },
    );
    assert.deepEqual(
      pickListedRow(
        { scope: { kind: 'chat', id: 'room-1' }, terms: { description: 'The deal' } },
        ['scopeKind', 'scopeId', 'title'],
      ),
      { scopeKind: 'chat', scopeId: 'room-1', title: 'The deal' },
    );
  });

  it('refuses an empty or non-array fields value', () => {
    assert.throws(() => parseListFields([]), /non-empty array/);
    assert.throws(() => parseListFields('taskId'), /non-empty array/);
    assert.equal(parseListFields(undefined), undefined);
  });

  it('names a field that no row has', () => {
    assert.deepEqual(listedFieldNote([{ taskId: 't1' }], ['taskId', 'missing']), {
      unknownFields: ['missing'],
    });
    assert.deepEqual(listedFieldNote([], ['missing']), {});
  });

  it('dedupes names and rejects blank entries', () => {
    assert.deepEqual(parseListFields(['taskId', 'taskId', 'state']), [
      'taskId',
      'state',
    ]);
    assert.throws(() => parseListFields(['taskId', '']), /non-empty strings/);
  });
});

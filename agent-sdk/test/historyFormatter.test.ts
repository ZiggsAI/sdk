import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryFormatter } from '../src/formatters/HistoryFormatter.js';

const AGENT_ID = 'agent-001';

// ── Helpers ───────────────────────────────────────────────────────────────────

function msg(text: string, senderId = 'user-1', senderType = 'user', receiverId: string | null = null, ts = '2024-01-01T10:00:00.000Z') {
  return {
    entryType: 'message',
    text,
    sender:    { id: senderId, type: senderType },
    receiver:  receiverId ? { id: receiverId, type: 'agent' } : null,
    timestamp: ts,
  };
}

function taskHistory(changeType: string, extra: Record<string, unknown> = {}, ts = '2024-01-01T10:00:00.000Z') {
  return {
    entryType: 'task_history',
    timestamp: ts,
    service: {
      changeType,
      task: {
        taskId:      'task_001',
        agreementId: 'agr_001',
        description: 'Do the thing',
        agreement: { parties: { creator: { actor: 'agent-001' }, provider: { actor: 'agent-002' }, proposedTo: { principal: 'user-1' } } },
      },
      ...extra,
    },
  };
}

function artifact(text: string, contentType: string | null = null, ts = '2024-01-01T10:00:00.000Z') {
  return { entryType: 'artifact', text, contentType: contentType, timestamp: ts };
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe('HistoryFormatter constructor', () => {
  it('defaults showTimestamps to true and shortIds to false', () => {
    const f = new HistoryFormatter();
    assert.equal((f as any).showTimestamps, true);
    assert.equal((f as any).shortIds, false);
  });

  it('accepts showTimestamps: false', () => {
    const f = new HistoryFormatter({ showTimestamps: false });
    assert.equal((f as any).showTimestamps, false);
  });

  it('accepts shortIds: true', () => {
    const f = new HistoryFormatter({ shortIds: true });
    assert.equal((f as any).shortIds, true);
  });
});

// ── format() ─────────────────────────────────────────────────────────────────

describe('HistoryFormatter.format', () => {
  it('returns "No previous activity." for null input', () => {
    const f = new HistoryFormatter();
    assert.equal(f.format(null, AGENT_ID), 'No previous activity.');
  });

  it('returns "No previous activity." for empty array', () => {
    const f = new HistoryFormatter();
    assert.equal(f.format([], AGENT_ID), 'No previous activity.');
  });

  it('sorts entries by timestamp ascending', () => {
    const f = new HistoryFormatter({ showTimestamps: false });
    const entries = [
      msg('second', 'u', 'user', null, '2024-01-01T10:00:02.000Z'),
      msg('first',  'u', 'user', null, '2024-01-01T10:00:01.000Z'),
    ];
    const result = f.format(entries, AGENT_ID);
    const lines = result.split('\n');
    assert.ok(lines[0].includes('first'));
    assert.ok(lines[1].includes('second'));
  });

  it('adds [CHAT] prefix in mission mode for message entries', () => {
    const f = new HistoryFormatter({ showTimestamps: false });
    const result = f.format([msg('hello')], AGENT_ID, { mode: 'mission' });
    assert.ok(result.startsWith('[CHAT]'), `expected [CHAT] prefix, got: ${result}`);
  });

  it('adds [TASK] prefix in mission mode for task_history entries', () => {
    const f = new HistoryFormatter({ showTimestamps: false });
    const entry = taskHistory('state_changed', {
      previousState: { state: 'active' },
      newState: { state: 'completed' },
    });
    const result = f.format([entry], AGENT_ID, { mode: 'mission' });
    assert.ok(result.startsWith('[TASK]'), `expected [TASK] prefix, got: ${result}`);
  });
});

// ── formatMessage ─────────────────────────────────────────────────────────────

describe('HistoryFormatter.formatMessage', () => {
  const f = new HistoryFormatter({ showTimestamps: false });

  it('renders sender id and text', () => {
    const result = f.format([msg('hello', 'user-42', 'user')], AGENT_ID);
    assert.ok(result.includes('user-42'));
    assert.ok(result.includes('hello'));
  });

  it('renders "You" when sender id matches agentId', () => {
    const result = f.format([msg('hi', AGENT_ID, 'agent')], AGENT_ID);
    assert.ok(result.includes('You'));
    assert.ok(!result.includes(AGENT_ID));
  });

  it('renders "System" for system-type sender', () => {
    const result = f.format([msg('system msg', 'sys', 'system')], AGENT_ID);
    assert.ok(result.includes('System'));
  });

  it('includes receiver when present', () => {
    const entry = msg('hey', 'user-1', 'user', AGENT_ID);
    const result = f.format([entry], AGENT_ID);
    assert.ok(result.includes('→'));
    assert.ok(result.includes('You')); // receiver is agentId → "You"
  });

  it('ZIG-1035: notifications render as [notice], not chat speech', () => {
    const entry = {
      entryType: 'notification',
      text: 'Task created: t1',
      sender: { id: 'system', type: 'system' },
      receiver: { id: AGENT_ID, type: 'agent' },
      timestamp: '2024-01-01T10:00:00.000Z',
    };
    const result = f.format([entry], AGENT_ID);
    assert.ok(result.includes('[notice] Task created: t1'), `got: ${result}`);
    assert.ok(!result.includes('→'), `notice must not use chat speech framing: ${result}`);
  });
});

// ── formatTaskHistory ─────────────────────────────────────────────────────────

describe('HistoryFormatter.formatTaskHistory', () => {
  const f = new HistoryFormatter({ showTimestamps: false });

  it('renders "Task created" with description and ids for changeType=created', () => {
    const result = f.format([taskHistory('created')], AGENT_ID);
    assert.ok(result.includes('Task created'), `got: ${result}`);
    assert.ok(result.includes('Do the thing'));
    assert.ok(result.includes('task_001'));
    assert.ok(result.includes('agr_001'));
  });

  it('renders state transition arrows for changeType=state_changed', () => {
    const entry = taskHistory('state_changed', {
      previousState: { state: 'active' },
      newState:      { state: 'completed' },
    });
    const result = f.format([entry], AGENT_ID);
    assert.ok(result.includes('active → completed'), `got: ${result}`);
    assert.ok(result.includes('Do the thing'));
  });

  it('renders processing start for changeType=processing_changed', () => {
    const entry = taskHistory('processing_changed', {
      newState: { processing: true },
    });
    const result = f.format([entry], AGENT_ID);
    assert.ok(result.includes('processing started'), `got: ${result}`);
  });

  it('renders processing stop for changeType=processing_changed (false)', () => {
    const entry = taskHistory('processing_changed', {
      newState: { processing: false },
    });
    const result = f.format([entry], AGENT_ID);
    assert.ok(result.includes('processing stopped'), `got: ${result}`);
  });

  it('renders changeType as fallback for unknown types', () => {
    const entry = taskHistory('mystery_event', {});
    const result = f.format([entry], AGENT_ID);
    assert.ok(result.includes('mystery_event'), `got: ${result}`);
  });

  it('returns "Update" when service.task is missing', () => {
    const entry = {
      entryType: 'task_history',
      timestamp: '2024-01-01T10:00:00.000Z',
      service:   { changeType: 'created' },
    };
    const result = f.format([entry], AGENT_ID);
    assert.ok(result.includes('Update'), `got: ${result}`);
  });
});

// ── formatArtifact ────────────────────────────────────────────────────────────

describe('HistoryFormatter.formatArtifact', () => {
  const f = new HistoryFormatter({ showTimestamps: false });

  it('renders "Thought:" prefix for thought content type', () => {
    const result = f.format([artifact('I am thinking', 'thought')], AGENT_ID);
    assert.ok(result.startsWith('Thought:'), `got: ${result}`);
    assert.ok(result.includes('I am thinking'));
  });

  it('renders "Tool starting:" for operation_started with tool type', () => {
    const text = `operation_started:${JSON.stringify({ type: 'tool', tool: 'do_work', args: { x: 1 } })}`;
    const result = f.format([artifact(text)], AGENT_ID);
    assert.ok(result.includes('Tool starting:'), `got: ${result}`);
    assert.ok(result.includes('do_work'));
  });

  it('renders "Tool completed:" for operation_completed with tool type', () => {
    const text = `operation_completed:${JSON.stringify({ type: 'tool', tool: 'do_work' })}`;
    const result = f.format([artifact(text)], AGENT_ID);
    assert.ok(result.includes('Tool completed:'), `got: ${result}`);
    assert.ok(result.includes('do_work'));
  });

  it('renders "ERROR:" for operation_error', () => {
    const text = `operation_error:${JSON.stringify({ error: 'something broke' })}`;
    const result = f.format([artifact(text)], AGENT_ID);
    assert.ok(result.includes('ERROR:'), `got: ${result}`);
    assert.ok(result.includes('something broke'));
  });

  it('passes unrecognised artifact text through unchanged', () => {
    const result = f.format([artifact('raw artifact text')], AGENT_ID);
    assert.ok(result.includes('raw artifact text'), `got: ${result}`);
  });
});

// ── formatParticipant ─────────────────────────────────────────────────────────

describe('HistoryFormatter.formatParticipant', () => {
  const f = new HistoryFormatter();

  it('returns "unknown" for null participant', () => {
    assert.equal(f.formatParticipant(null, AGENT_ID), 'unknown');
  });

  it('returns "System" for system type', () => {
    assert.equal(f.formatParticipant({ id: 'sys', type: 'system' }, AGENT_ID), 'System');
  });

  it('returns "You" when id matches agentId', () => {
    assert.equal(f.formatParticipant({ id: AGENT_ID, type: 'agent' }, AGENT_ID), 'You');
  });

  it('returns "id (type)" for other participants', () => {
    assert.equal(f.formatParticipant({ id: 'user-42', type: 'user' }, AGENT_ID), 'user-42 (user)');
  });

  // ZIG-1137 — persona-masked faces prefer presentation name; opaque ids are labeled.
  it('prefers presentation face name over raw type', () => {
    assert.equal(
      f.formatParticipant(
        {
          id: 'rpb_face_1',
          type: 'agent',
          presentation: { ref: 'rpb_face_1', name: 'Lab Delegate', mode: 'persona' },
        },
        AGENT_ID,
      ),
      'Lab Delegate (rpb_face_1)',
    );
  });

  it('labels opaque refs without presentation as presentation', () => {
    assert.equal(
      f.formatParticipant({ id: 'psn_abc', type: 'agent' }, AGENT_ID),
      'psn_abc (presentation)',
    );
  });
});

// ── formatTime ────────────────────────────────────────────────────────────────

describe('HistoryFormatter.formatTime', () => {
  const f = new HistoryFormatter();

  it('returns "??:??" for null timestamp', () => {
    assert.equal(f.formatTime(null), '??:??');
  });

  it('returns "??:??" for invalid timestamp string', () => {
    assert.equal(f.formatTime('not-a-date'), '??:??');
  });

  it('returns HH:MM:SS format for valid ISO timestamp', () => {
    const result = f.formatTime('2024-01-01T14:30:45.000Z');
    assert.match(result, /^\d{2}:\d{2}:\d{2}$/);
    assert.equal(result, '14:30:45');
  });
});

// ── shortId ───────────────────────────────────────────────────────────────────

describe('HistoryFormatter.shortId', () => {
  it('returns full id when shortIds is false (default)', () => {
    const f = new HistoryFormatter({ shortIds: false });
    const id = 'task_1234567890_abcdefghij';
    assert.equal(f.shortId(id), id);
  });

  it('shortens a long id when shortIds is true', () => {
    const f = new HistoryFormatter({ shortIds: true });
    const id = 'task_1234567890_abcdefghij';
    const result = f.shortId(id);
    assert.ok(result.length < id.length, `expected shorter id, got: ${result}`);
    assert.ok(result.includes('...'));
  });

  it('returns "?" for null id', () => {
    const f = new HistoryFormatter();
    assert.equal(f.shortId(null), '?');
  });
});

// ── formatArgs ────────────────────────────────────────────────────────────────

describe('HistoryFormatter.formatArgs', () => {
  const f = new HistoryFormatter();

  it('returns empty string for null/non-object args', () => {
    assert.equal(f.formatArgs(null as unknown as Record<string, unknown>),   '');
    assert.equal(f.formatArgs('str' as unknown as Record<string, unknown>),  '');
  });

  it('returns empty string for empty object', () => {
    assert.equal(f.formatArgs({}), '');
  });

  it('formats up to 3 entries as key=value pairs', () => {
    const result = f.formatArgs({ a: 1, b: 'x' });
    assert.ok(result.includes('a=1'));
    assert.ok(result.includes('b="x"'));
  });

  it('JSON-stringifies when there are more than 3 entries', () => {
    const args = { a: 1, b: 2, c: 3, d: 4 };
    const result = f.formatArgs(args);
    assert.ok(result.startsWith('{'), `expected JSON, got: ${result}`);
  });
});

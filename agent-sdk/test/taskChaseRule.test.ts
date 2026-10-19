/**
 * The holder's side of a chased task: the deadline and the reminder budget
 * have to reach the prompt, because nothing else makes the agent keep to them.
 *
 * The fields were stored, served and carried on the wake and still could not
 * be obeyed — they were never rendered, so the agent was being held to a rule
 * it had no way to read. These tests pin the rendering, not the storage.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClaudeEventPrompt,
  taskChaseLines,
} from '../src/brain/claudeCognition.js';
import { CLAUDE_SDK_PROTOCOL } from '../src/brain/claudeSdkProtocol.js';
import type { RawEvent } from '../src/runtime/buildOutcome.js';

const taskWake = (task: Record<string, unknown>): RawEvent =>
  ({
    type: 'task_result',
    chatId: 'chat_1',
    result: { taskId: 'task_1', state: 'active', ...task },
  }) as unknown as RawEvent;

describe('taskChaseLines', () => {
  const now = new Date('2026-09-12T16:00:00Z');

  it('states the deadline as an instruction, not a field', () => {
    // "dueAt: <iso>" is a value; the agent has to be told what to do with it.
    const lines = taskChaseLines({ dueAt: '2026-09-12T17:00:00Z' }, now);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /2026-09-12T17:00:00Z/);
    assert.match(lines[0], /post what you have/);
    assert.match(lines[0], /stop/);
  });

  it('accepts a Date, since the read edge may hand one over', () => {
    const lines = taskChaseLines({ dueAt: new Date('2026-09-12T17:00:00Z') }, now);
    assert.match(lines[0], /2026-09-12T17:00:00\.000Z/);
  });

  describe('how long is left', () => {
    // A lab run closed a task four minutes early: woken by routine task
    // redelivery, the agent read the ISO timestamp, called the deadline
    // "imminent" and wrapped up. The arithmetic is done here now.
    it('says the remaining time in words, so the model does not compute it', () => {
      const lines = taskChaseLines({ dueAt: '2026-09-12T17:00:00Z' }, now);
      assert.match(lines[0], /about 60 minutes from now/);
    });

    it('rounds to the nearest minute', () => {
      const lines = taskChaseLines(
        { dueAt: '2026-09-12T16:04:20Z' },
        now,
      );
      assert.match(lines[0], /about 4 minutes from now/);
    });

    it('does not say "0 minutes" when the deadline is seconds away', () => {
      const lines = taskChaseLines({ dueAt: '2026-09-12T16:00:30Z' }, now);
      assert.match(lines[0], /under two minutes from now/);
    });

    it('says the time has passed once it has', () => {
      const lines = taskChaseLines({ dueAt: '2026-09-12T15:59:00Z' }, now);
      assert.match(lines[0], /that time has passed — report and close now/);
    });

    it('forbids closing early, which is the failure that was observed', () => {
      const lines = taskChaseLines({ dueAt: '2026-09-12T17:00:00Z' }, now);
      assert.match(lines[0], /stays OPEN/);
      assert.match(lines[0], /do not close it early/);
      assert.match(lines[0], /an answer can still arrive/i);
    });
  });

  it('states both halves of the reminder rule and names the cost', () => {
    const lines = taskChaseLines({
      checkBack: { everyMinutes: 1440, maxReminders: 3 },
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /at most 3 time/);
    assert.match(lines[0], /1440 minutes apart/);
    // Without this the agent has no way to come back and would either wait in
    // place or never remind at all.
    assert.match(lines[0], /wake_at/);
    assert.match(lines[0], /breach of the task/);
  });

  it('renders both when both are set', () => {
    const lines = taskChaseLines(
      {
        dueAt: '2026-09-12T17:00:00Z',
        checkBack: { everyMinutes: 5, maxReminders: 2 },
      },
      now,
    );
    assert.equal(lines.length, 2);
  });

  it('says nothing for a task that carries neither — no phantom obligation', () => {
    assert.deepEqual(taskChaseLines({}), []);
    assert.deepEqual(taskChaseLines({ dueAt: null, checkBack: null }), []);
  });

  it('ignores a half-filled rule rather than inventing the missing half', () => {
    // The server refuses these on write, so one here means a legacy row or a
    // hand-written payload. Guessing a budget would be worse than silence.
    assert.deepEqual(taskChaseLines({ checkBack: { everyMinutes: 60 } }), []);
    assert.deepEqual(taskChaseLines({ checkBack: { maxReminders: 3 } }), []);
  });

  it('ignores a non-ISO deadline instead of pasting it in', () => {
    assert.deepEqual(taskChaseLines({ dueAt: 1789200000000 }, now), []);
  });
});

describe('the task wake prompt', () => {
  it('carries the rule to the agent that has to keep to it', () => {
    const p = buildClaudeEventPrompt(
      taskWake({
        dueAt: '2026-09-12T17:00:00Z',
        checkBack: { everyMinutes: 1440, maxReminders: 3 },
      }),
      '',
    );
    assert.match(p, /Task deadline: 2026-09-12T17:00:00Z/);
    assert.match(p, /Task reminder rule:/);
    assert.match(p, /at most 3 time/);
  });

  it('leaves an ordinary task wake exactly as it was', () => {
    const p = buildClaudeEventPrompt(taskWake({}), '');
    assert.match(p, /Task: task_1/);
    assert.doesNotMatch(p, /Task deadline|Task reminder rule/);
  });
});

describe('the standing protocol', () => {
  it('tells the holder the rule is the job, and that nothing enforces it', () => {
    // The tool description for task_create speaks to whoever CREATES a task.
    // The holder never reads that, so the obligation has to be stated here too.
    assert.match(CLAUDE_SDK_PROTOCOL, /a task you hold carries a deadline/);
    assert.match(CLAUDE_SDK_PROTOCOL, /wake_at/);
    assert.match(CLAUDE_SDK_PROTOCOL, /breach of the task, not diligence/);
  });
});

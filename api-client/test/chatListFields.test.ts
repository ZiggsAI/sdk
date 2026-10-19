import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_LIST_DEFAULT_FIELDS,
  approxTokens,
  projectChatListRows,
  utf8Bytes,
} from '../src/capabilities/chatListFields.js';

function persona(id: string, name: string) {
  return { id: `psn_${id}`, name, image: `https://cdn.example/${id}.png` };
}

function presentation(id: string, name: string) {
  const face = persona(id, name);
  return {
    persona: face,
    mode: 'persona' as const,
    subject: { id, type: 'user' as const },
  };
}

function participant(id: string, name: string) {
  const view = presentation(id, name);
  return {
    id,
    type: 'user' as const,
    via: [{ kind: 'grant' as const }],
    access: 'write' as const,
    persona: view.persona,
    presentation: view.mode,
    presentationView: view,
  };
}

function member(id: string, name: string) {
  return {
    principalId: id,
    agentId: null,
    presentation: presentation(id, name),
  };
}

function rosterRow(id: string, name: string) {
  const view = presentation(id, name);
  return {
    id,
    type: 'user' as const,
    via: [{ kind: 'grant' as const }],
    access: 'write' as const,
    persona: view.persona,
    presentation: view.mode,
    presentationView: view,
  };
}

function fullChat(i: number) {
  const people = [
    [`usr_buyer_${i}`, 'Buyer'],
    [`agt_hired_${i}`, 'Hired agent'],
    [`usr_observer_${i}`, 'Observer'],
  ] as const;
  return {
    chatId: `cht_${i}`,
    name: `Hire room ${i}`,
    updatedAt: `2026-09-2${i}T10:00:00.000Z`,
    lastMessage: {
      sender: people[1][0],
      at: `2026-09-2${i}T10:00:00.000Z`,
      snippet: `Deliverable draft ${i} is ready for review.`,
    },
    unreadCount: i,
    addressKind: 'pair',
    participantsRefreshAt: null,
    members: people.map(([id, name]) => member(id, name)),
    rosterSummary: people.map(([id, name]) => rosterRow(id, name)),
    participantSummary: people.map(([id, name]) => participant(id, name)),
  };
}

const SIX_CHATS = [1, 2, 3, 4, 5, 6].map(fullChat);

describe('chat list default projection (ZIG-1945)', () => {
  it('omitted fields keeps one roster and drops the other two', () => {
    const [row] = projectChatListRows([SIX_CHATS[0]]) as Array<
      Record<string, unknown>
    >;
    // The fixture predates `readable`; a key the row lacks is not invented.
    assert.deepEqual(
      Object.keys(row),
      CHAT_LIST_DEFAULT_FIELDS.filter((key) => key in SIX_CHATS[0]),
    );
    assert.equal(row.members, undefined);
    assert.equal(row.rosterSummary, undefined);
    assert.ok(Array.isArray(row.participantSummary));
    assert.equal((row.participantSummary as unknown[]).length, 3);
  });

  it('keeps a listed room unreadable, with the read request and no message (ZIG-2170)', () => {
    const requestAccess = {
      tool: 'ziggs_access_request',
      args: { scopeKind: 'chat', scopeId: 'c1', permission: 'read', recipientId: 'p1' },
      requiredInput: ['reason'],
    };
    const [row] = projectChatListRows([
      { chatId: 'c1', name: 'Plans', updatedAt: null, participantSummary: [], readable: false, requestAccess },
    ]) as Array<Record<string, unknown>>;
    assert.equal(row.readable, false);
    assert.deepEqual(row.requestAccess, requestAccess);
    assert.equal(row.lastMessage, undefined);
  });

  it('names each participant once with one face, not presentationView', () => {
    const [row] = projectChatListRows([SIX_CHATS[0]]) as Array<{
      participantSummary: Array<Record<string, unknown>>;
    }>;
    const ids = row.participantSummary.map((p) => p.id);
    assert.deepEqual(new Set(ids).size, ids.length);
    for (const p of row.participantSummary) {
      assert.ok(p.persona, 'persona stays');
      assert.equal(p.presentation, 'persona');
      assert.equal(p.presentationView, undefined);
    }
  });

  it('fields can still ask for members or rosterSummary', () => {
    const [row] = projectChatListRows([SIX_CHATS[0]], [
      'chatId',
      'members',
      'rosterSummary',
    ]) as Array<Record<string, unknown>>;
    assert.equal(row.chatId, 'cht_1');
    assert.ok(Array.isArray(row.members));
    assert.ok(Array.isArray(row.rosterSummary));
    assert.equal(row.participantSummary, undefined);
    assert.equal(row.name, undefined);
  });

  it('still slims participantSummary when fields names it', () => {
    const [row] = projectChatListRows([SIX_CHATS[0]], [
      'chatId',
      'participantSummary',
    ]) as Array<{
      participantSummary: Array<Record<string, unknown>>;
    }>;
    assert.equal(row.participantSummary[0].presentationView, undefined);
    assert.ok(row.participantSummary[0].persona);
  });

  it('measures bytes and tokens on a six-room list', () => {
    const before = { count: SIX_CHATS.length, chats: SIX_CHATS };
    const after = {
      count: SIX_CHATS.length,
      chats: projectChatListRows(SIX_CHATS),
    };
    const beforeBytes = utf8Bytes(before);
    const afterBytes = utf8Bytes(after);
    const beforeTok = approxTokens(before);
    const afterTok = approxTokens(after);
    // Keep the ticket numbers honest: a six-room hire-shaped list must
    // shrink, not just rearrange keys.
    assert.ok(
      afterBytes < beforeBytes * 0.45,
      `expected default < 45% of full row, got ${afterBytes}/${beforeBytes}`,
    );
    assert.ok(afterTok < beforeTok);
    // Surface the measured numbers for the Linear comment.
    process.stdout.write(
      `ZIG-1945 measure six-room hire list: before ${beforeBytes} B / ~${beforeTok} tok → after ${afterBytes} B / ~${afterTok} tok (${Math.round((afterBytes / beforeBytes) * 100)}%)\n`,
    );
  });
});

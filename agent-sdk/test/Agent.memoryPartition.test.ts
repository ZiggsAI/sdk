import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/Agent.js';
import { InMemoryStore } from '../src/memory/MemoryStore.js';
import type { TickInput, TickOutput } from '../src/brain/ZiggsBrain.js';
import type { Ctx } from '../src/types.js';

type HostInternals = {
  sessions: Map<
    string,
    { sessionId: string; ownAgentId: string; ctx?: Ctx; state?: string }
  >;
  _processEvent: (event: unknown, laneKey: string) => Promise<void>;
};

const parkedTick = (): TickOutput => ({
  ctx: {},
  state: 'idle',
  parked: true,
  stateTimeoutUnhandled: false,
  metrics: { llmCalls: 0, tokens: { total: 0, input: 0, output: 0 } },
});

describe('Agent hire-scoped memory', () => {
  it('a note written in one hire wake is unreadable in another', async () => {
    const backing = new InMemoryStore();
    const host = new Agent({
      agentId: 'agent-me',
      operatorKey: 'op-key',
      anthropicKey: 'test-key',
      initial: 'idle',
      states: { idle: { kind: 'parked' as const, transitions: [] } },
      inboxCatchUp: false,
      memory: backing,
    });

    host.brain = {
      workflow: { id: 'mem', description: 'test', initial: 'idle', states: { idle: { kind: 'parked' as const, transitions: [] } } },
      async tick({ memory, ctx }: TickInput) {
        const hire = String(
          (ctx as { activeAgreementId?: string } | undefined)?.activeAgreementId ?? '',
        );
        const existing = await memory?.get('note');
        await memory?.put('note', hire);
        return { ...parkedTick(), ctx: { ...(ctx ?? {}), lastRead: existing } as Ctx };
      },
    } as Agent['brain'];

    const internals = host as unknown as HostInternals;
    internals.sessions.set('agent-me:chat-dana', {
      sessionId: 'chat-dana',
      ownAgentId: 'agent-me',
      ctx: { activeAgreementId: 'agr_dana' } as Ctx,
      state: 'idle',
    });
    internals.sessions.set('agent-me:chat-omar', {
      sessionId: 'chat-omar',
      ownAgentId: 'agent-me',
      ctx: { activeAgreementId: 'agr_omar' } as Ctx,
      state: 'idle',
    });

    const message = (id: string) => ({
      type: 'message',
      text: 'hi',
      senderId: id,
      senderType: 'USER',
      messageId: `m-${id}`,
    });

    await internals._processEvent(message('dana'), 'agent-me:chat-dana');
    await internals._processEvent(message('omar'), 'agent-me:chat-omar');

    assert.equal(await backing.get('hire:agr_dana:note'), 'agr_dana');
    assert.equal(await backing.get('hire:agr_omar:note'), 'agr_omar');
    assert.equal(internals.sessions.get('agent-me:chat-omar')?.ctx?.lastRead, undefined);

    await internals._processEvent(message('dana-again'), 'agent-me:chat-dana');
    assert.equal(internals.sessions.get('agent-me:chat-dana')?.ctx?.lastRead, 'agr_dana');
  });

  it('partitions two chat-room wakes by the delivery hire, with no ctx pin', async () => {
    const backing = new InMemoryStore();
    const host = new Agent({
      agentId: 'agent-me',
      operatorKey: 'op-key',
      anthropicKey: 'test-key',
      initial: 'idle',
      states: { idle: { kind: 'parked' as const, transitions: [] } },
      inboxCatchUp: false,
      memory: backing,
    });

    host.brain = {
      workflow: { id: 'mem', description: 'test', initial: 'idle', states: { idle: { kind: 'parked' as const, transitions: [] } } },
      async tick({ memory }: TickInput) {
        const existing = await memory?.get('note');
        await memory?.put('note', 'mine');
        return { ...parkedTick(), ctx: { lastRead: existing } as Ctx };
      },
    } as Agent['brain'];

    const internals = host as unknown as HostInternals;
    internals.sessions.set('agent-me:chat-dana', {
      sessionId: 'chat-dana',
      ownAgentId: 'agent-me',
      ctx: {} as Ctx,
      state: 'idle',
    });
    internals.sessions.set('agent-me:chat-omar', {
      sessionId: 'chat-omar',
      ownAgentId: 'agent-me',
      ctx: {} as Ctx,
      state: 'idle',
    });

    await internals._processEvent(
      { type: 'message', text: 'hi', senderId: 'dana', agreementId: 'agr_dana' },
      'agent-me:chat-dana',
    );
    await internals._processEvent(
      { type: 'message', text: 'hi', senderId: 'omar', agreementId: 'agr_omar' },
      'agent-me:chat-omar',
    );

    assert.equal(await backing.get('hire:agr_dana:note'), 'mine');
    assert.equal(await backing.get('hire:agr_omar:note'), 'mine');
    assert.equal(await backing.get('agent:note'), undefined);
    assert.equal(internals.sessions.get('agent-me:chat-omar')?.ctx?.lastRead, undefined);

    await internals._processEvent(
      { type: 'message', text: 'again', senderId: 'dana' },
      'agent-me:chat-dana',
    );
    assert.equal(internals.sessions.get('agent-me:chat-dana')?.ctx?.lastRead, 'mine');

    // Exact incoming work wins over an old room pin.
    internals.sessions.get('agent-me:chat-dana')!.ctx = { activeAgreementId: 'agr_dana' } as Ctx;
    await internals._processEvent(
      { type: 'message', text: 'new work', senderId: 'lee', agreementId: 'agr_lee' },
      'agent-me:chat-dana',
    );
    assert.equal(internals.sessions.get('agent-me:chat-dana')?.ctx?.lastRead, undefined);
    assert.equal(await backing.get('hire:agr_lee:note'), 'mine');
  });
});

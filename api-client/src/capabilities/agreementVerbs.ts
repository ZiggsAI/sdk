import { SOURCES_PARAM, sourcesArg } from './sources.js';
import {
  delegateAgreement,
  getAgreement,
  proposeBroadcast,
  proposeDirectTo,
  type ProposeTerms,
} from '../http/AgreementClient.js';
import { fullCreds } from './types.js';
import type { CapabilityDefinition, CapabilityEnv, CapabilityParam } from './types.js';
import { nextCall } from './nextCall.js';

/**
 * One verb per shape of agreement, instead of one verb and a dispatch table.
 *
 * `agreement_propose` computed which of nine shapes you meant from a
 * combination of `proposedTo`, `providerId`, `parentAgreementId` and
 * `engagementKind`, then spent 420 words of description teaching a caller to
 * reconstruct that same table in its head so it could pick the params that
 * produced the shape it already knew it wanted. Roughly a tenth of the whole
 * tool surface was one tool, and most of that tenth explained `providerId`
 * permutations.
 *
 * The direction of work is in the verb name now, so `providerId` survives on
 * exactly one verb — `agreement_broker` — where naming a third-party provider
 * is the entire point rather than a puzzle. Every shape the old dispatch could
 * reach still has a verb: nothing was dropped to make the list shorter.
 *
 * The count goes up, from one tool to six. That is the trade on purpose: the
 * cost was never the number of tools, it was the number of decisions per call.
 */

/**
 * Terms every commercial agreement carries, whoever works and whoever pays.
 * Hosted-agent tools spread this instead of keeping a shorter copy.
 */
export const AGREEMENT_TERMS_PARAMS: Record<string, CapabilityParam> = {
  description: {
    type: 'string',
    required: true,
    description: 'What the work is, in the words the counterparty will read.',
  },
  price: {
    type: 'number',
    description:
      'Price in POINTS, as an integer of hundredths — 500 means ϟ5.00. Recording a price here does not itself move any. Convert BOTH ways or you are off by 100x: a human who says "ϟ2" means 200, and quoting 500 back as "ϟ500" is the same mistake inverted.',
  },
  billing: {
    type: 'string',
    enum: ['total', 'per_task'],
    description:
      'How price reads. total (default) is one price for the whole engagement, settled at fulfilment; per_task is a rate settled as each task completes (standing agreements only, and the default for a hire).',
  },
  engagementKind: {
    type: 'string',
    enum: ['service', 'hire'],
    description:
      'service (default) is one deliverable; hire is an ongoing engagement you keep spawning tasks under.',
  },
  lifecycle: {
    type: 'string',
    enum: ['open', 'time-bound', 'count-bound'],
    description:
      'open (default) is standing: no expiry, unlimited tasks. Set this only when the engagement should end on its own.',
  },
  expiresAt: {
    type: 'string',
    description: 'ISO timestamp after which this can no longer be acted on.',
  },
  interactionMode: { type: 'string', enum: ['messages', 'tasks', 'both'], description: 'Accepted interface. Task-only services need no chat or negotiation.' },
  conversationAllowance: { type: 'number', description: 'Shared incoming-message limit across covered rooms. A helper hired inside this job draws on this limit and has none of its own. Omit for unlimited messages on a new agreement; on a counter, omission preserves the existing term.' },
  maxExecutions: {
    type: 'number',
    description: 'End the engagement after this many tasks.',
  },
  sources: SOURCES_PARAM,
};

/** Pull the shared terms off a validated arg bag. */
function termsFrom(args: Record<string, unknown>): ProposeTerms {
  return {
    description: args['description'] as string,
    ...(args['price'] === undefined ? {} : { price: args['price'] as number }),
    ...(args['billing'] === undefined
      ? {}
      : { billing: args['billing'] as 'total' | 'per_task' }),
    ...(args['lifecycle'] === undefined
      ? {}
      : { lifecycle: args['lifecycle'] as string }),
    ...(args['expiresAt'] === undefined
      ? {}
      : { expiresAt: args['expiresAt'] as string }),
    ...(args['interactionMode'] === undefined ? {} : { interactionMode: args['interactionMode'] as 'messages' | 'tasks' | 'both' }),
    ...(args['conversationAllowance'] === undefined ? {} : { conversationAllowance: args['conversationAllowance'] as number | null }),
    ...(args['maxExecutions'] === undefined
      ? {}
      : { maxExecutions: args['maxExecutions'] as number }),
    ...sourcesArg(args),
  };
}

function engagementKindFrom(args: Record<string, unknown>): 'service' | 'hire' {
  return (args['engagementKind'] as 'service' | 'hire' | undefined) ?? 'service';
}

/** The declared job governs the work; hiring consent uses grants or agreement approval. */
const MANDATE_PARAM: CapabilityParam = {
  type: 'string',
  description:
    "The active agreement whose work this is part of — the job you are doing. It becomes this engagement's parent, so it ends when the job ends, but does not itself authorize a hire. Agent-initiated hires require a covering approval-authority grant or approval on the agreement. Name only an agreement you are actually a party to; the server checks, and a wrong name simply earns nothing. Leave it out for work that belongs to no job. It never names who you act for — the server reads that off the room or contract that woke you.",
};

/** Pull the declared mandate off a validated arg bag, as the wire field. */
function mandateFrom(args: Record<string, unknown>): { parentAgreementId?: string } {
  const declared = args['parentAgreementId'] ?? args['mandateAgreementId'];
  return typeof declared === 'string' && declared ? { parentAgreementId: declared } : {};
}

/** The audience a broadcast reaches. */
const AUDIENCE_PARAM: CapabilityParam = {
  type: 'string',
  enum: ['everyone', 'org'],
  required: true,
  description:
    'everyone is fully public; org is your active organization only.',
};

/**
 * The triage string a supplier host compares against with no LLM turn. Only a
 * REQUEST carries one, and until now only the web door could set it: every
 * request an agent published reached its suppliers with nothing to triage on,
 * which made "no triage" the normal case rather than the edge.
 */
const MATCH_PARAM: CapabilityParam = {
  type: 'string',
  required: false,
  description:
    'Optional exact-match triage string suppliers compare against verbatim, so a host can decide whether the work is theirs without spending a turn on it. Leave it out and the request still reaches everyone — they just have to read it to know.',
};

const COUNTERPARTY_PARAM: CapabilityParam = {
  type: 'string',
  required: true,
  description: 'Agent or user id of the counterparty.',
};

/**
 * Optional, because the server has always accepted a proposal without one and
 * the client was the only thing refusing.
 *
 * The room is where a conversation about the terms happens; it is not how the
 * counterparty is TOLD. A directed proposal is delivered to the party slots
 * (the create-time agreement event targets parties, not a chat), so a chatless
 * proposal lands in their inbox exactly like any other. What is lost is
 * narrower than it sounds: the notice posted INTO a room, which is worth
 * nothing when there is no room.
 *
 * Requiring it here meant a bookkeeping agreement between parties who have no
 * conversation had to invent a chat id to exist. The lab's own self-hire did:
 * it passed `lab-hire-<run>`, a chat that does not exist, which the server
 * tolerates by falling back to the credential's tenant. A fiction the caller
 * was forced to write down is worse than an absent field.
 */
const CHAT_PARAM: CapabilityParam = {
  type: 'string',
  required: false,
  description:
    'The room this is proposed in, when there is one — the counterparty can read and discuss the terms there. Omit it for an agreement between parties with no conversation; the proposal still reaches them, it just has no room to be discussed in.',
};

/** Marketplace follow-up: a published listing is claimed, never countered. */
function publishedNext(env: CapabilityEnv) {
  return [
    nextCall(
      env,
      'marketplace_view',
      undefined,
      'see it listed alongside everything else on offer',
    ),
  ];
}

/* ─────────────────────────── direct, to one counterparty ─────────────────── */

export const agreementBuyCapability: CapabilityDefinition = {
  key: 'agreement_buy',
  names: { sdk: 'agreement_buy', mcp: 'ziggs_agreement_buy' },
  title: 'They work, you pay (named counterparty)',
  descriptions: {
    sdk: 'Ask a named counterparty to do work your side pays for. They provide, you pay. For work you would do for them instead, use agreement_bid; to reach whoever is available rather than someone named, use agreement_request.',
  },
  annotation: 'destructive',
  params: {
    counterparty: COUNTERPARTY_PARAM,
    chatId: CHAT_PARAM,
    ...AGREEMENT_TERMS_PARAMS,
    mandateAgreementId: MANDATE_PARAM,
    parentAgreementId: { type: 'string', description: 'The job this work is part of; ending that job ends this work. Never a link: a link is who can reach whom, so paid work cannot be placed under one. This placement does not grant spending consent.' },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const counterparty = args['counterparty'] as string;
    const agreement = await proposeDirectTo(
      {
        ...termsFrom(args),
        ...mandateFrom(args),
        proposedTo: counterparty,
        chatId: args['chatId'] as string,
        // They provide. The payer is derived server-side as the other side.
        providerId: counterparty,
        engagementKind: engagementKindFrom(args),
      },
      fullCreds(env),
    );
    return { agreement };
  },
  sdkOptions: { isAgreementCreation: true },
};

export const agreementBidCapability: CapabilityDefinition = {
  key: 'agreement_bid',
  names: { sdk: 'agreement_bid', mcp: 'ziggs_agreement_bid' },
  title: 'You work, they pay (named counterparty)',
  descriptions: {
    sdk: 'Offer to do work for a named counterparty, who pays. You provide. A standing listing for whoever claims it is published by a person or the deploy, not by this verb.',
  },
  annotation: 'destructive',
  params: {
    counterparty: COUNTERPARTY_PARAM,
    chatId: CHAT_PARAM,
    ...AGREEMENT_TERMS_PARAMS,
    mandateAgreementId: MANDATE_PARAM,
    parentAgreementId: { type: 'string', description: 'The job this work is part of; ending that job ends this work. Never a link: a link is who can reach whom, so paid work cannot be placed under one. This placement does not grant spending consent.' },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const creds = fullCreds(env);
    const agreement = await proposeDirectTo(
      {
        ...termsFrom(args),
        ...mandateFrom(args),
        proposedTo: args['counterparty'] as string,
        chatId: args['chatId'] as string,
        // You provide, so the counterparty pays.
        providerId: creds.agentId || undefined,
        engagementKind: engagementKindFrom(args),
      },
      creds,
    );
    return { agreement };
  },
  sdkOptions: { isAgreementCreation: true },
};

export const agreementBrokerCapability: CapabilityDefinition = {
  key: 'agreement_broker',
  names: { sdk: 'agreement_broker', mcp: 'ziggs_agreement_broker' },
  title: 'A third party does the work, you arrange it',
  descriptions: {
    sdk: 'Introduce a provider to a customer: the provider does the work, the counterparty pays, and neither side is you. The provider must already have a matching active offer.',
  },
  annotation: 'destructive',
  params: {
    counterparty: {
      ...COUNTERPARTY_PARAM,
      description: 'Who the work is done for, and who pays.',
    },
    provider: {
      type: 'string',
      required: true,
      description: 'Agent id of the party who does the work.',
    },
    chatId: CHAT_PARAM,
    ...AGREEMENT_TERMS_PARAMS,
    mandateAgreementId: MANDATE_PARAM,
    parentAgreementId: { type: 'string', description: 'The job this work is part of; ending that job ends this work. Never a link: a link is who can reach whom, so paid work cannot be placed under one. This placement does not grant spending consent.' },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const agreement = await proposeDirectTo(
      {
        ...termsFrom(args),
        ...mandateFrom(args),
        proposedTo: args['counterparty'] as string,
        chatId: args['chatId'] as string,
        providerId: args['provider'] as string,
        engagementKind: engagementKindFrom(args),
      },
      fullCreds(env),
    );
    return { agreement };
  },
  sdkOptions: { isAgreementCreation: true },
};

/* ──────────────────────────────── broadcast ──────────────────────────────── */

export const agreementRequestCapability: CapabilityDefinition = {
  key: 'agreement_request',
  names: { sdk: 'agreement_request', mcp: 'ziggs_agreement_request' },
  title: 'They work, you pay (open to anyone)',
  descriptions: {
    sdk: 'Post work you want done and will pay for, for whoever claims it. Whoever claims does the work. A standing listing of work you would do is published by a person or the deploy.',
  },
  annotation: 'destructive',
  params: {
    audience: AUDIENCE_PARAM,
    ...AGREEMENT_TERMS_PARAMS,
    match: MATCH_PARAM,
    mandateAgreementId: MANDATE_PARAM,
    parentAgreementId: { type: 'string', description: 'The job this work is part of; ending that job ends this work. Never a link: a link is who can reach whom, so paid work cannot be placed under one. This placement does not grant spending consent.' },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const agreement = await proposeBroadcast(
      {
        ...termsFrom(args),
        ...mandateFrom(args),
        chatId: '',
        audience: args['audience'] as 'everyone' | 'org',
        engagementKind: engagementKindFrom(args),
        match: typeof args['match'] === 'string' ? args['match'] : undefined,
      },
      fullCreds(env),
    );
    return { agreement, readPlan: publishedNext(env) };
  },
  sdkOptions: { isAgreementCreation: true },
};

/* ──────────────────────────────── hand-off ───────────────────────────────── */

export const agreementHandoffCapability: CapabilityDefinition = {
  key: 'agreement_handoff',
  names: { sdk: 'agreement_handoff', mcp: 'ziggs_agreement_handoff' },
  title: 'Pass a hire you hold to whoever claims it',
  descriptions: {
    sdk: 'Share an agent you have hired: the provider stays pinned, and whoever claims or approves becomes the customer the work is done for. Omit `to` to make it claimable by anyone. Handing off someone else\'s agent leaves that provider\'s approval pending — it must accept once before the hand-off can be claimed.',
  },
  annotation: 'destructive',
  params: {
    parentAgreementId: {
      type: 'string',
      required: true,
      description: 'The ACTIVE hire you are handing off.',
    },
    to: {
      type: 'string',
      description:
        'Who receives it. Omit to publish it claimable by anyone; name a party and they approve directly.',
    },
    ...AGREEMENT_TERMS_PARAMS,
    description: {
      type: 'string',
      description: 'What the recipient is getting. Defaults to the parent hire.',
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const creds = fullCreds(env);
    const parentAgreementId = args['parentAgreementId'] as string;

    // Read the provider off the parent instead of asking for it. The caller
    // would have had to look it up to pass it, and a lookup whose answer is
    // unique is not a decision worth handing to the caller.
    const parent = await getAgreement(parentAgreementId, creds);
    if (typeof parent?.publishedService !== 'boolean') {
      throw new Error('Service publishing requires an updated server. No proposal was sent.');
    }
    const providerId = parent?.parties?.provider?.actor;
    if (!providerId) {
      throw new Error(
        `Cannot hand off ${parentAgreementId}: it names no provider, so there is no hire to share. Check the id with agreement_get.`,
      );
    }

    const terms = {
      ...termsFrom(args),
      description: (args['description'] as string | undefined) ?? parent.description ?? '',
      parentAgreementId,
    };
    const to = args['to'] as string | undefined;

    const agreement = to
      ? await proposeDirectTo(
          { ...terms, proposedTo: to, chatId: '', useParentProvider: true, engagementKind: 'hire' },
          creds,
        )
      : await proposeBroadcast(
          { ...terms, chatId: '', audience: 'everyone', useParentProvider: true, engagementKind: 'hire' },
          creds,
        );

    return { agreement, ...(to ? {} : { readPlan: publishedNext(env) }) };
  },
  sdkOptions: { isAgreementCreation: true },
};

export const AGREEMENT_VERB_CAPABILITIES: CapabilityDefinition[] = [
  agreementBuyCapability,
  agreementBidCapability,
  agreementBrokerCapability,
  agreementRequestCapability,
  agreementHandoffCapability,
];

/**
 * Pause and resume left the agent surface. A person or the deploy
 * opens and closes a listing. The array stays so registration has one place
 * to look and finds nothing.
 */
export const LISTING_DOOR_CAPABILITIES: CapabilityDefinition[] = [];

/**
 * Subcontract sits next to the propose verbs, not inside them: the parent
 * already exists, and the conversation is optional. The server uses the
 * parent's own chat when none is named. That list of required arguments is
 * this definition — nextCall, MCP, and the SDK tool all read it.
 */
export const agreementSubcontractCapability: CapabilityDefinition = {
  key: 'agreement_subcontract',
  names: { sdk: 'agreement_subcontract', mcp: 'ziggs_agreement_subcontract' },
  title: 'Subcontract part of your work',
  descriptions: {
    sdk: 'Delegate a slice of an active parent agreement to another agent. Name the parent, the worker, and the slice. The worker must approve — never impersonated. A chat is optional: omit it and the slice lands in the parent agreement\'s own room.',
  },
  annotation: 'destructive',
  params: {
    parentAgreementId: {
      type: 'string',
      required: true,
      description: 'The active agreement you are delegating under',
    },
    executorId: {
      type: 'string',
      required: true,
      description: 'Agent doing the delegated work',
    },
    description: {
      type: 'string',
      required: true,
      description: 'What the sub-agreement covers',
    },
    chatId: {
      type: 'string',
      description:
        "Chat the subcontract is coordinated in. Omit it and the server uses the parent agreement's own chat — which is where a slice with no conversation of its own belongs.",
    },
    price: {
      type: 'number',
      description:
        'Price in POINTS, as an integer of hundredths — 500 means ϟ5.00. Recording a price here does not itself move any.',
    },
    lifecycle: {
      type: 'string',
      enum: ['open', 'time-bound', 'count-bound'],
      description:
        "Usually inferred: expiresAt → 'time-bound', maxExecutions → 'count-bound', neither → 'open' (standing).",
    },
    expiresAt: { type: 'string' },
    maxExecutions: { type: 'number' },
    interactionMode: { type: 'string', enum: ['messages', 'tasks', 'both'], description: 'Accepted interface. Task-only services need no chat or negotiation.' },
  conversationAllowance: { type: 'number', description: 'Message allowance for this agreement. A helper hired inside the job draws on the job and has none of its own.' },
    agreementDescription: { type: 'string' },
    payerId: {
      type: 'string',
      description: 'Who pays for the subcontracted work. Defaults to the delegating side.',
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const chatId = args['chatId'];
    const agreement = await delegateAgreement(
      {
        parentAgreementId: args['parentAgreementId'] as string,
        executorId: args['executorId'] as string,
        description: args['description'] as string,
        ...(typeof chatId === 'string' && chatId.trim()
          ? { chatId: chatId.trim() }
          : {}),
        ...(args['price'] === undefined ? {} : { price: args['price'] as number }),
        ...(args['lifecycle'] === undefined
          ? {}
          : { lifecycle: args['lifecycle'] as string }),
        ...(args['expiresAt'] === undefined
          ? {}
          : { expiresAt: args['expiresAt'] as string }),
        ...(args['interactionMode'] === undefined ? {} : { interactionMode: args['interactionMode'] as 'messages' | 'tasks' | 'both' }),
    ...(args['conversationAllowance'] === undefined ? {} : { conversationAllowance: args['conversationAllowance'] as number | null }),
        ...(args['maxExecutions'] === undefined
          ? {}
          : { maxExecutions: args['maxExecutions'] as number }),
        ...(args['agreementDescription'] === undefined
          ? {}
          : { agreementDescription: args['agreementDescription'] as string }),
        ...(args['payerId'] === undefined
          ? {}
          : { payerId: args['payerId'] as string }),
      },
      fullCreds(env),
    );
    return { agreement };
  },
  sdkOptions: { isAgreementCreation: true },
};

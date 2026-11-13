import type { FormEntry, PageForm } from '@ziggs-ai/contracts';
import {
  BucketsClient,
  BUCKET_ITEM_KINDS,
  type BucketItemKind,
  type BucketItemRef,
} from '../http/BucketsClient.js';
import { ArtifactsClient } from '../http/ArtifactsClient.js';
import { type CapabilityDefinition, type CapabilityParam, fullCreds, rethrowWithContext } from './types.js';
import { pageGuideCapability } from './pageGuide.js';

/**
 * The bucket operations as tools, one per route.
 *
 * A bucket is a high-level way to work with context: pointers to items and to
 * who it is for, with no permission of its own. Whether everyone it is for can
 * read each item is computed from the items' own grants whenever it is asked;
 * what does not fit comes back as `misfits`, and the caller chooses to share
 * or to split. Every message is sent through a bucket.
 */

const BUCKET_ID: CapabilityParam = {
  type: 'string',
  required: true,
};

const ITEMS: CapabilityParam = {
  type: 'array',
  required: true,
  description: '{kind, id}, up to 100.',
  items: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...BUCKET_ITEM_KINDS] },
      id: { type: 'string' },
    },
    required: ['kind', 'id'],
  },
};

const SHARE: CapabilityParam = {
  type: 'boolean',
  description: 'Share misfits first.',
};

const AUDIENCE: CapabilityParam = {
  type: 'array',
  description: 'Other person, agent or workspace ids.',
  items: { type: 'string' },
};

function client(env: Parameters<CapabilityDefinition['handler']>[1]): BucketsClient {
  const creds = fullCreds(env);
  return new BucketsClient(creds.operatorKey, creds.agentId || undefined);
}

function bucketId(args: Record<string, unknown>): string {
  const id = args['bucketId'];
  if (typeof id !== 'string' || !id.trim()) throw new Error('bucketId is required');
  return id.trim();
}

function items(args: Record<string, unknown>): BucketItemRef[] {
  const raw = args['items'];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('items must be a non-empty list of {kind, id}');
  return raw.map((entry) => {
    const item = entry as { kind?: unknown; id?: unknown };
    if (!BUCKET_ITEM_KINDS.includes(item?.kind as BucketItemKind) || typeof item.id !== 'string' || !item.id.trim()) {
      throw new Error(`Each item is {kind, id} with kind one of ${BUCKET_ITEM_KINDS.join(', ')}`);
    }
    return { kind: item.kind as BucketItemKind, id: item.id.trim() };
  });
}

function principals(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error(`${field} must be a list of ids`);
  }
  return raw.map((id: string) => id.trim());
}

async function run<T>(label: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    rethrowWithContext(e, label);
  }
}

export const bucketCreateCapability: CapabilityDefinition = {
  key: 'bucket_create',
  names: { sdk: 'bucket_create', mcp: 'ziggs_bucket_create' },
  title: 'Create a bucket',
  descriptions: {
    sdk: 'Create a bucket: a working set whose whole audience can read every item in it. You are always in it. Items given here go in exactly as bucket_insert puts them.',
  },
  annotation: 'write',
  needsAgentId: true,
  params: {
    name: { type: 'string', required: true },
    audience: AUDIENCE,
    items: { ...ITEMS, required: false },
    share: SHARE,
  },
  handler: (args, env) =>
    run('bucket_create', () =>
      client(env).create({
        name: String(args['name'] ?? ''),
        ...(args['audience'] !== undefined ? { audience: principals(args['audience'], 'audience') } : {}),
        ...(args['items'] !== undefined ? { items: items(args) } : {}),
        ...(args['share'] === true ? { share: true } : {}),
      }),
    ),
};

export const bucketListCapability: CapabilityDefinition = {
  key: 'bucket_list',
  names: { sdk: 'bucket_list', mcp: 'ziggs_bucket_list' },
  title: 'List buckets',
  descriptions: { sdk: 'List the buckets you are in: name, audience, revision and item count.' },
  annotation: 'read-only',
  needsAgentId: true,
  params: {},
  handler: (_args, env) => run('bucket_list', () => client(env).listMine()),
};

export const bucketReadCapability: CapabilityDefinition = {
  key: 'bucket_read',
  names: { sdk: 'bucket_read', mcp: 'ziggs_bucket_read' },
  title: 'Read a bucket',
  descriptions: {
    sdk: 'Read one bucket and a page of its items, newest first. Items are references; read each one with its own tool (message_read, open). Pass nextCursor as before for the next page.',
  },
  annotation: 'read-only',
  needsAgentId: true,
  params: {
    bucketId: BUCKET_ID,
    before: { type: 'string', description: 'Cursor from the previous page.' },
    limit: { type: 'number' },
  },
  handler: (args, env) =>
    run('bucket_read', async () => {
      const id = bucketId(args);
      const c = client(env);
      const [bucket, page] = await Promise.all([
        c.get(id),
        c.items(id, {
          ...(typeof args['before'] === 'string' ? { before: args['before'] } : {}),
          ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
        }),
      ]);
      return { bucket, ...page };
    }),
};

export const bucketInsertCapability: CapabilityDefinition = {
  key: 'bucket_insert',
  names: { sdk: 'bucket_insert', mcp: 'ziggs_bucket_insert' },
  title: 'Put items in a bucket',
  descriptions: {
    sdk: 'Put items in a bucket. Each goes in only if everyone in its audience can read it; the rest come back as misfits, naming who cannot read them when you can read them yourself. With share, an item some members cannot read is first shared with them as you, under the ordinary share rules.',
  },
  annotation: 'write',
  needsAgentId: true,
  params: { bucketId: BUCKET_ID, items: ITEMS, share: SHARE },
  handler: (args, env) =>
    run('bucket_insert', () =>
      client(env).insert(bucketId(args), items(args), args['share'] === true ? { share: true } : {}),
    ),
};

export const bucketRemoveCapability: CapabilityDefinition = {
  key: 'bucket_remove',
  names: { sdk: 'bucket_remove', mcp: 'ziggs_bucket_remove' },
  title: 'Remove bucket items',
  descriptions: { sdk: 'Take items out of a bucket. The items themselves are untouched; only the reference leaves.' },
  annotation: 'write',
  needsAgentId: true,
  params: { bucketId: BUCKET_ID, items: ITEMS },
  handler: (args, env) => run('bucket_remove', () => client(env).remove(bucketId(args), items(args))),
};


export const bucketDuplicateCapability: CapabilityDefinition = {
  key: 'bucket_duplicate',
  names: { sdk: 'bucket_duplicate', mcp: 'ziggs_bucket_duplicate' },
  title: 'Duplicate a bucket',
  descriptions: {
    sdk: "Copy items into a new bucket for another audience, for example the part you expose as someone's provider. The original stays whole. Items left out means all of them. Each goes in as bucket_insert puts it.",
  },
  annotation: 'write',
  needsAgentId: true,
  params: {
    bucketId: BUCKET_ID,
    name: { type: 'string', required: true },
    audience: { ...AUDIENCE, description: "Left out: this bucket's." },
    items: { ...ITEMS, required: false, description: 'Left out: all.' },
    share: SHARE,
  },
  handler: (args, env) =>
    run('bucket_duplicate', () =>
      client(env).duplicate(bucketId(args), {
        name: String(args['name'] ?? ''),
        ...(args['audience'] !== undefined ? { audience: principals(args['audience'], 'audience') } : {}),
        ...(args['items'] !== undefined ? { items: items(args) } : {}),
        ...(args['share'] === true ? { share: true } : {}),
      }),
    ),
};

export const bucketAddMembersCapability: CapabilityDefinition = {
  key: 'bucket_add_members',
  names: { sdk: 'bucket_add_members', mcp: 'ziggs_bucket_add_members' },
  title: 'Add to a bucket',
  descriptions: {
    sdk: "Add people, agents or workspaces to a bucket's audience. If one cannot read an item, nothing changes until you choose: onMisfit share gives them access first, under the ordinary share rules; split leaves this bucket as it is and starts a narrower one with them and only what everyone can read. Or name an agreementId instead of principalIds to bring its people in: now when it has started, else when it does. Your own open listing stays invited, so everyone who takes it or writes to you through it gets their own split of this bucket: after you publish, point the bucket that holds your context at your listing.",
  },
  annotation: 'write',
  needsAgentId: true,
  params: {
    bucketId: BUCKET_ID,
    principalIds: { type: 'array', description: 'Person, agent or workspace ids.', items: { type: 'string' } },
    agreementId: { type: 'string', description: 'Or a hire or your listing.' },
    onMisfit: { type: 'string', enum: ['share', 'split'], description: 'Left out: stop and list misfits.' },
  },
  handler: (args, env) =>
    run('bucket_add_members', () => {
      const choice = args['onMisfit'];
      if (choice !== undefined && choice !== 'share' && choice !== 'split') throw new Error('onMisfit is share or split');
      const agreementId = typeof args['agreementId'] === 'string' ? args['agreementId'].trim() : '';
      const named = args['principalIds'] !== undefined;
      if (agreementId && named) throw new Error('name principalIds or agreementId, not both');
      if (agreementId)
        return client(env).invite(bucketId(args), { agreementId, ...(choice ? { onMisfit: choice } : {}) });
      if (!named) throw new Error('principalIds or agreementId is required');
      return client(env).addMembers(
        bucketId(args),
        principals(args['principalIds'], 'principalIds') ?? [],
        choice ? { onMisfit: choice } : {},
      );
    }),
};

export const bucketJoinCapability: CapabilityDefinition = {
  key: 'bucket_join',
  names: { sdk: 'bucket_join', mcp: 'ziggs_bucket_join' },
  title: 'Join buckets',
  descriptions: {
    sdk: "Bring another bucket's people and items into this one. If someone then cannot read an item, nothing changes until you pass onMisfit share. The other bucket stays.",
  },
  annotation: 'write',
  needsAgentId: true,
  params: {
    bucketId: BUCKET_ID,
    from: { type: 'string', required: true },
    onMisfit: { type: 'string', enum: ['share'] },
  },
  handler: (args, env) =>
    run('bucket_join', () => {
      const from = args['from'];
      if (typeof from !== 'string' || !from.trim()) throw new Error('from is required');
      const choice = args['onMisfit'];
      if (choice !== undefined && choice !== 'share') throw new Error('onMisfit is share');
      return client(env).join(bucketId(args), { from: from.trim(), ...(choice ? { onMisfit: 'share' as const } : {}) });
    }),
};

export const bucketSendCapability: CapabilityDefinition = {
  key: 'bucket_send',
  names: { sdk: 'bucket_send', mcp: 'ziggs_bucket_send' },
  title: 'Send in a bucket',
  descriptions: {
    sdk: "Send a message inside a bucket. Its readers are the bucket's people; with replyTo, also readers of the answered message who have it in a bucket. A reply that reaches someone new to its thread also shares the earlier messages your side wrote there with them, and asks each other writer to share theirs. Name recipients among the readers. To reach anyone else, add them with bucket_add_members first. A request wakes the agents it is delivered to. With page, the message carries an HTML page: its thread shows as that page.",
  },
  annotation: 'destructive',
  needsAgentId: true,
  params: {
    bucketId: BUCKET_ID,
    text: { type: 'string', required: true },
    page: {
      type: 'string',
      description: "Read page_guide (MCP: ziggs_page_guide) before writing a page. A full HTML document (<!DOCTYPE html>), saved as a file that goes with the message. Without replyTo it starts a thread of its own, shown as the page; with replyTo that page's first message, it is its new version (the page's side only).",
    },
    pageName: { type: 'string', description: 'Short, stable name of the page.' },
    forms: { type: 'array', description: 'With page: the page\'s forms, fields and choices.', items: { type: 'object', required: ['name', 'fields'], properties: { name: { type: 'string' }, fields: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, label: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } }, freeText: { type: 'boolean' } } } } } } },
    formEntry: { type: 'object', description: 'Reply to the page version filled; goes to its poster.', properties: { form: { type: 'string', required: true }, fields: { type: 'object' } } },
    recipients: {
      type: 'array',
      items: { type: 'string' },
      description: 'Who is told, among the readers. Under work, name at least one person the work is with.',
    },
    intent: { type: 'string', enum: ['fyi', 'request'] },
    replyTo: { type: 'string', description: 'The message this answers. Not for a new page.' },
    operationId: { type: 'string', description: 'Reuse on retry.' },
    agreementId: {
      type: 'string',
      description: 'The work this is under. Defaults to the agreement your wake is under.',
    },
    taskId: { type: 'string', description: 'The task under agreementId this is about.' },
  },
  handler: (args, env) =>
    run('bucket_send', async () => {
      const text = args['text'];
      if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
      const intent = args['intent'] ?? 'fyi';
      if (intent !== 'fyi' && intent !== 'request') throw new Error('intent is fyi or request');
      const replyTo = args['replyTo'];
      if (replyTo !== undefined && (typeof replyTo !== 'string' || !replyTo.trim())) throw new Error('replyTo is a message id');
      const named = args['operationId'];
      const operationId = typeof named === 'string' && named.trim() ? named.trim() : `bucket-send-${globalThis.crypto.randomUUID()}`;
      const page = await pageOf(args, env, operationId);
      const sent = await client(env).sendMessage(bucketId(args), {
        operationId,
        content: { text },
        deliveries: { kind: 'explicit', principalIds: principals(args['recipients'], 'recipients') ?? [] },
        intent,
        ...(typeof replyTo === 'string' ? { relationships: { replyToMessageId: replyTo.trim() } } : {}),
        ...mandateOf(args, env),
        // The message carries the page. Without replyTo it starts a thread of
        // its own. Whoever reads the message opens the page: no share needed.
        ...(page ? { page } : {}),
        // Passed as given: forms without a page is refused by the server, with why.
        ...(Array.isArray(args['forms']) ? { forms: args['forms'] as PageForm[] } : {}),
        ...(args['formEntry'] && typeof args['formEntry'] === 'object' ? { formEntry: args['formEntry'] as FormEntry } : {}),
      });
      return page ? { ...sent, page: { artifactId: page.id, address: `/pages/${sent.message.rootMessageId}` } } : sent;
    }),
};

/**
 * The page a message carries: the HTML saved as a file, then linked by its
 * exact version. The file is saved under the same retry identity as the
 * message, so a retry links the same file.
 */
async function pageOf(
  args: Record<string, unknown>,
  env: Parameters<CapabilityDefinition['handler']>[1],
  operationId: string,
): Promise<{ kind: 'artifact'; id: string; sha256: string } | null> {
  const html = args['page'];
  if (html === undefined) return null;
  if (typeof html !== 'string' || !/^\s*(?:<!doctype\s+html|<html)(?:\s|>)/i.test(html)) {
    throw new Error('page is a full HTML document starting with <!DOCTYPE html>');
  }
  const name = typeof args['pageName'] === 'string' ? args['pageName'].trim() : '';
  if (!name) throw new Error('pageName is required with page');
  const creds = fullCreds(env);
  // The stored text is trimmed; the link names exactly what is stored.
  const text = html.trim();
  const { artifactId } = await new ArtifactsClient(creds.operatorKey, creds.agentId).writeStrict({
    text,
    name,
    contentType: 'document',
    visibility: 'address',
    serviceAgreementId: env.serviceAgreementId,
    idempotencyKey: `page-${operationId}`,
  });
  if (!artifactId) throw new Error('The page file was not saved');
  const { createHash } = await import('node:crypto');
  return { kind: 'artifact', id: artifactId, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

/**
 * The work a send is under. Work under a hire keeps its mandate: the server
 * refuses a run's send that drops it. Named in the call, else the agreement
 * the wake is under.
 */
function mandateOf(
  args: Record<string, unknown>,
  env: { serviceAgreementId?: string },
): { mandate?: { agreementId: string; taskId?: string } } {
  const named = typeof args['agreementId'] === 'string' ? args['agreementId'].trim() : '';
  const agreementId = named || env.serviceAgreementId;
  if (!agreementId) return {};
  const taskId = typeof args['taskId'] === 'string' && args['taskId'].trim() ? args['taskId'].trim() : undefined;
  return { mandate: { agreementId, ...(taskId ? { taskId } : {}) } };
}

export const bucketRemoveMemberCapability: CapabilityDefinition = {
  key: 'bucket_remove_member',
  names: { sdk: 'bucket_remove_member', mcp: 'ziggs_bucket_remove_member' },
  title: 'Remove from a bucket',
  descriptions: {
    sdk: "Take one person, agent or workspace out of a bucket's audience. The bucket's creator does this, and stays.",
  },
  annotation: 'destructive',
  needsAgentId: true,
  params: {
    bucketId: BUCKET_ID,
    principalId: { type: 'string', required: true },
  },
  handler: (args, env) =>
    run('bucket_remove_member', () => {
      const principalId = args['principalId'];
      if (typeof principalId !== 'string' || !principalId.trim()) throw new Error('principalId is required');
      return client(env).removeMember(bucketId(args), principalId.trim());
    }),
};

export const bucketRenameCapability: CapabilityDefinition = {
  key: 'bucket_rename',
  names: { sdk: 'bucket_rename', mcp: 'ziggs_bucket_rename' },
  title: 'Rename a bucket',
  descriptions: { sdk: "Rename a bucket. The bucket's creator does this." },
  annotation: 'write',
  needsAgentId: true,
  params: {
    bucketId: BUCKET_ID,
    name: { type: 'string', required: true },
  },
  handler: (args, env) =>
    run('bucket_rename', () => client(env).rename(bucketId(args), String(args['name'] ?? ''))),
};

export const bucketDeleteCapability: CapabilityDefinition = {
  key: 'bucket_delete',
  names: { sdk: 'bucket_delete', mcp: 'ziggs_bucket_delete' },
  title: 'Delete a bucket',
  descriptions: {
    sdk: "Delete a bucket. The items themselves are untouched; only the bucket and its pointers go. The bucket's creator does this.",
  },
  annotation: 'destructive',
  needsAgentId: true,
  params: { bucketId: BUCKET_ID },
  handler: (args, env) => run('bucket_delete', () => client(env).delete(bucketId(args))),
};

export const BUCKET_CAPABILITIES: CapabilityDefinition[] = [
  pageGuideCapability,
  bucketCreateCapability,
  bucketListCapability,
  bucketReadCapability,
  bucketInsertCapability,
  bucketRemoveCapability,
  bucketDuplicateCapability,
  bucketAddMembersCapability,
  bucketJoinCapability,
  bucketSendCapability,
  bucketRemoveMemberCapability,
  bucketRenameCapability,
  bucketDeleteCapability,
];

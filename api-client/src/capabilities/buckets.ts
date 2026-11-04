import {
  BucketsClient,
  BUCKET_ITEM_KINDS,
  type BucketItemKind,
  type BucketItemRef,
} from '../http/BucketsClient.js';
import { type CapabilityDefinition, type CapabilityParam, fullCreds, rethrowWithContext } from './types.js';

/**
 * The bucket operations as tools, one per route.
 *
 * A bucket is a working set whose whole audience can read every item in it.
 * The server checks that on insert, split and adding a member, and answers
 * what does not fit as `misfits`; nothing is changed for a misfit. A bucket
 * grants nothing: each item stays readable only through its own grants.
 */

const BUCKET_ID: CapabilityParam = {
  type: 'string',
  required: true,
  description: 'The bucket, by bucketId.',
};

const ITEMS: CapabilityParam = {
  type: 'array',
  required: true,
  description: `Items by reference, up to 100: {kind, id} with kind one of ${BUCKET_ITEM_KINDS.join(', ')}.`,
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
  description:
    'For an item some members cannot read, first share it with them as you, under the ordinary share rules. It goes in if that makes it readable to everyone.',
};

const AUDIENCE: CapabilityParam = {
  type: 'array',
  description: 'Who else it is for: person, agent or workspace ids. You are always in it.',
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
    sdk: 'Create a bucket: a working set whose whole audience can read every item in it. You hold admit on it and are always in its audience; everyone else you name gets write. Items given here go in exactly as bucket_insert puts them.',
  },
  annotation: 'write',
  needsAgentId: true,
  params: {
    name: { type: 'string', required: true, description: 'What the bucket is for, up to 120 characters.' },
    audience: AUDIENCE,
    items: { ...ITEMS, required: false, description: 'What to put in it now, as bucket_insert would.' },
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
    before: { type: 'string', description: 'nextCursor from the previous page.' },
    limit: { type: 'number', description: 'Items per page, up to 200. Default 50.' },
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

export const bucketMoveCapability: CapabilityDefinition = {
  key: 'bucket_move',
  names: { sdk: 'bucket_move', mcp: 'ziggs_bucket_move' },
  title: 'Move items to another bucket',
  descriptions: {
    sdk: "Move items out of a bucket into another one you can change. Each moves only if the other bucket's audience can all read it; misfits stay where they are.",
  },
  annotation: 'write',
  needsAgentId: true,
  params: {
    bucketId: BUCKET_ID,
    to: { type: 'string', required: true, description: 'The bucket to move into, by bucketId.' },
    items: ITEMS,
  },
  handler: (args, env) =>
    run('bucket_move', () => {
      const to = args['to'];
      if (typeof to !== 'string' || !to.trim()) throw new Error('to is the bucket to move into');
      return client(env).move(bucketId(args), { to: to.trim(), items: items(args) });
    }),
};

export const bucketRemoveCapability: CapabilityDefinition = {
  key: 'bucket_remove',
  names: { sdk: 'bucket_remove', mcp: 'ziggs_bucket_remove' },
  title: 'Take items out of a bucket',
  descriptions: { sdk: 'Take items out of a bucket. The items themselves are untouched; only the reference leaves.' },
  annotation: 'write',
  needsAgentId: true,
  params: { bucketId: BUCKET_ID, items: ITEMS },
  handler: (args, env) => run('bucket_remove', () => client(env).remove(bucketId(args), items(args))),
};

export const bucketSplitCapability: CapabilityDefinition = {
  key: 'bucket_split',
  names: { sdk: 'bucket_split', mcp: 'ziggs_bucket_split' },
  title: 'Split a bucket',
  descriptions: {
    sdk: "Move items out of a bucket into a new one. The new bucket's audience is this one's unless you name another; each item moves only if that audience can all read it, and misfits stay where they are.",
  },
  annotation: 'write',
  needsAgentId: true,
  params: {
    bucketId: BUCKET_ID,
    items: ITEMS,
    name: { type: 'string', required: true, description: 'Name of the new bucket.' },
    audience: { ...AUDIENCE, description: "Who the new bucket is for. Left out, this bucket's audience." },
  },
  handler: (args, env) =>
    run('bucket_split', () =>
      client(env).split(bucketId(args), {
        items: items(args),
        name: String(args['name'] ?? ''),
        ...(args['audience'] !== undefined ? { audience: principals(args['audience'], 'audience') } : {}),
      }),
    ),
};

export const bucketAddMembersCapability: CapabilityDefinition = {
  key: 'bucket_add_members',
  names: { sdk: 'bucket_add_members', mcp: 'ziggs_bucket_add_members' },
  title: 'Add to a bucket audience',
  descriptions: {
    sdk: "Add people, agents or workspaces to a bucket's audience. Needs admit. Refused with nothing changed when a newcomer cannot read an item; the refusal lists those items, to take out, split off, or ask access for first.",
  },
  annotation: 'write',
  needsAgentId: true,
  params: {
    bucketId: BUCKET_ID,
    principalIds: { type: 'array', required: true, description: 'Person, agent or workspace ids to add.', items: { type: 'string' } },
  },
  handler: (args, env) =>
    run('bucket_add_members', () =>
      client(env).addMembers(bucketId(args), principals(args['principalIds'], 'principalIds') ?? []),
    ),
};

export const bucketRemoveMemberCapability: CapabilityDefinition = {
  key: 'bucket_remove_member',
  names: { sdk: 'bucket_remove_member', mcp: 'ziggs_bucket_remove_member' },
  title: 'Remove someone from a bucket',
  descriptions: {
    sdk: "Take one person, agent or workspace out of a bucket's audience, with their grants on it. Needs admit. The creator stays.",
  },
  annotation: 'destructive',
  needsAgentId: true,
  params: {
    bucketId: BUCKET_ID,
    principalId: { type: 'string', required: true, description: 'Who to take out.' },
  },
  handler: (args, env) =>
    run('bucket_remove_member', () => {
      const principalId = args['principalId'];
      if (typeof principalId !== 'string' || !principalId.trim()) throw new Error('principalId is required');
      return client(env).removeMember(bucketId(args), principalId.trim());
    }),
};

export const BUCKET_CAPABILITIES: CapabilityDefinition[] = [
  bucketCreateCapability,
  bucketListCapability,
  bucketReadCapability,
  bucketInsertCapability,
  bucketRemoveCapability,
  bucketMoveCapability,
  bucketSplitCapability,
  bucketAddMembersCapability,
  bucketRemoveMemberCapability,
];

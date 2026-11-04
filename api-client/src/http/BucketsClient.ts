import type { MessageCommand, MessageCommandResult } from '@ziggs-ai/contracts';
import { getBackendUrl } from '../utils/urlUtils.js';
import { throwApiError } from '../shared/apiError.js';
import { buildOperatorHeaders, withoutExecution } from './operatorHeaders.js';

/** What a bucket can hold. Each item is a pointer, never a copy. */
export const BUCKET_ITEM_KINDS = ['message', 'artifact', 'task', 'agreement'] as const;
export type BucketItemKind = (typeof BUCKET_ITEM_KINDS)[number];

export interface BucketItemRef {
  kind: BucketItemKind;
  id: string;
}

/**
 * An item that does not fit where it was asked to go, or no longer fits where
 * it is. Other members are named only when the caller can read the item.
 */
export type BucketMisfit =
  | { item: BucketItemRef; reason: 'you-cannot-read' }
  | { item: BucketItemRef; reason: 'members-cannot-read'; memberIds: string[] };

/**
 * What to do when someone being added cannot read an item: share it with
 * them, or split it off into a bucket for the people already there.
 */
export type BucketMisfitChoice = 'share' | 'split';

export interface BucketView {
  bucketId: string;
  name: string;
  createdBy: string;
  /** Who it is for, as given: people, agents, workspaces. */
  audience: string[];
  /** Goes up when an item leaves or the audience changes. */
  revision: number;
  /** Items held; whether each still fits is computed when the items are read. */
  itemCount: number;
  createdAt: string | null;
}

/** One share made because the caller chose to share. */
export interface BucketShare {
  item: BucketItemRef;
  holderId: string;
  /** `pending` waits for the item owner's yes; the item stays out until then. */
  outcome: 'shared' | 'pending' | 'refused';
}

export interface BucketInsertResult {
  bucket: BucketView;
  inserted: BucketItemRef[];
  alreadyIn: BucketItemRef[];
  misfits: BucketMisfit[];
  shared: BucketShare[];
}

export interface BucketMoveResult {
  source: BucketView;
  bucket: BucketView;
  moved: BucketItemRef[];
  notIn: BucketItemRef[];
  misfits: BucketMisfit[];
}

export interface BucketAddMembersResult {
  bucket: BucketView;
  added: string[];
  shared: BucketShare[];
  /** Where the items someone could not read went, for the people already there. */
  split: { bucket: BucketView; moved: BucketItemRef[] } | null;
}

export interface BucketJoinResult {
  bucket: BucketView;
  added: string[];
  joined: BucketItemRef[];
  shared: BucketShare[];
}

/** One thread in a bucket, as the reader sees it. */
export interface BucketThread {
  rootMessageId: string;
  title: string;
  messageCount: number;
  lastAt: string | null;
  /** The reader wrote in it or it was delivered to them. */
  yours: boolean;
  /** The thread holding the message asked about as `current`. */
  current: boolean;
  /** The reader's own threads, other than the current one, come with their latest messages. */
  recent?: Array<{ messageId: string; from: string; text: string; at: string }>;
}

/** What is in a bucket as the reader can read it now: what a run starts from. */
export interface BucketContents {
  bucket: { bucketId: string; name: string; audience: string[]; revision: number };
  threads: BucketThread[];
  artifacts: Array<{ artifactId: string; name: string | null }>;
  tasks: Array<{ taskId: string; title: string; state: string }>;
  agreements: Array<{ agreementId: string; title: string; status: string }>;
  /** Items held that the reader cannot read here, as they ask now. */
  outOfReach: number;
}

/** A message sent inside a bucket: its readers are the bucket's people. */
export type BucketMessage = Omit<MessageCommand, 'audience'>;

export interface BucketItemPage {
  /** Items everyone it is for can read right now. */
  items: Array<BucketItemRef & { addedBy: string; addedAt: string | null }>;
  /** Items held that someone it is for can no longer read. */
  outOfReach: BucketMisfit[];
  nextCursor: string | null;
}

/**
 * The bucket operations (`/buckets`). A bucket is pointers to items and to who
 * it is for; it stores no permission. Whether everyone can read each item is
 * computed from the items' own grants whenever it is asked.
 *
 * Every message is sent through a bucket and the bucket points at it; no
 * message names its bucket. `listMine` with an item finds the buckets holding
 * it, the first being where a message was sent.
 *
 * Changing a bucket is not part of a run, so those calls never carry the
 * selected execution. Sending inside a bucket is: it carries the run, and the
 * run's own guards apply to it.
 */
export class BucketsClient {
  constructor(
    private readonly operatorKey: string,
    private readonly agentId?: string,
    private readonly baseUrl?: string,
  ) {
    if (!operatorKey) throw new Error('BucketsClient: operatorKey is required');
  }

  create(input: { name: string; audience?: string[]; items?: BucketItemRef[]; share?: boolean }): Promise<BucketInsertResult> {
    return this.request('POST', '/buckets', input, 'bucket create');
  }

  /** The buckets you are in; given an item, those holding it, in the order it went in. */
  listMine(item?: BucketItemRef): Promise<{ buckets: BucketView[] }> {
    const query = item ? `?${new URLSearchParams({ kind: item.kind, id: item.id })}` : '';
    return this.request('GET', `/buckets${query}`, undefined, 'bucket list');
  }

  /** Send a message inside a bucket, under the selected run when there is one. */
  sendMessage(bucketId: string, message: BucketMessage): Promise<MessageCommandResult> {
    return this.request('POST', `${this.path(bucketId)}/send`, message, 'bucket send', { inRun: true });
  }

  /**
   * What is in a bucket as you can read it now, under the selected run when
   * there is one: your threads with their latest messages, the rest by title.
   * `current` names the message being answered; its thread is marked.
   */
  contents(bucketId: string, opts: { current?: string } = {}): Promise<BucketContents> {
    const query = opts.current ? `?${new URLSearchParams({ current: opts.current })}` : '';
    return this.request('GET', `${this.path(bucketId)}/contents${query}`, undefined, 'bucket contents', { inRun: true });
  }

  /** Bring another bucket's people and items in. The other bucket stays. */
  join(bucketId: string, input: { from: string; onMisfit?: 'share' }): Promise<BucketJoinResult> {
    return this.request('POST', `${this.path(bucketId)}/join`, input, 'bucket join');
  }

  get(bucketId: string): Promise<BucketView> {
    return this.request('GET', this.path(bucketId), undefined, 'bucket read');
  }

  items(bucketId: string, opts: { before?: string; limit?: number } = {}): Promise<BucketItemPage> {
    const query = new URLSearchParams();
    if (opts.before) query.set('before', opts.before);
    if (opts.limit !== undefined) query.set('limit', String(opts.limit));
    const suffix = query.size ? `?${query}` : '';
    return this.request('GET', `${this.path(bucketId)}/items${suffix}`, undefined, 'bucket items');
  }

  insert(bucketId: string, items: BucketItemRef[], opts: { share?: boolean } = {}): Promise<BucketInsertResult> {
    return this.request(
      'POST',
      `${this.path(bucketId)}/insert`,
      { items, ...(opts.share ? { share: true } : {}) },
      'bucket insert',
    );
  }

  remove(bucketId: string, items: BucketItemRef[]): Promise<{
    bucket: BucketView; removed: BucketItemRef[]; notIn: BucketItemRef[];
  }> {
    return this.request('POST', `${this.path(bucketId)}/remove`, { items }, 'bucket remove');
  }

  duplicate(
    bucketId: string,
    input: { name: string; audience?: string[]; items?: BucketItemRef[]; share?: boolean },
  ): Promise<BucketInsertResult & { notIn: BucketItemRef[] }> {
    return this.request('POST', `${this.path(bucketId)}/duplicate`, input, 'bucket duplicate');
  }

  move(bucketId: string, input: { to: string; items: BucketItemRef[] }): Promise<BucketMoveResult> {
    return this.request('POST', `${this.path(bucketId)}/move`, input, 'bucket move');
  }

  split(bucketId: string, input: { items: BucketItemRef[]; name: string; audience?: string[] }): Promise<BucketMoveResult> {
    return this.request('POST', `${this.path(bucketId)}/split`, input, 'bucket split');
  }

  addMembers(
    bucketId: string,
    principalIds: string[],
    opts: { onMisfit?: BucketMisfitChoice } = {},
  ): Promise<BucketAddMembersResult> {
    return this.request(
      'POST',
      `${this.path(bucketId)}/members`,
      { principalIds, ...(opts.onMisfit ? { onMisfit: opts.onMisfit } : {}) },
      'bucket add members',
    );
  }

  removeMember(bucketId: string, principalId: string): Promise<{ bucket: BucketView; removed: boolean }> {
    return this.request(
      'DELETE',
      `${this.path(bucketId)}/members/${encodeURIComponent(principalId)}`,
      undefined,
      'bucket remove member',
    );
  }

  rename(bucketId: string, name: string): Promise<BucketView> {
    return this.request('PATCH', this.path(bucketId), { name }, 'bucket rename');
  }

  delete(bucketId: string): Promise<{ bucketId: string; deleted: boolean }> {
    return this.request('DELETE', this.path(bucketId), undefined, 'bucket delete');
  }

  private path(bucketId: string): string {
    return `/buckets/${encodeURIComponent(bucketId)}`;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    label: string,
    opts: { inRun?: boolean } = {},
  ): Promise<T> {
    const headers = buildOperatorHeaders(
      this.operatorKey,
      this.agentId,
      body === undefined ? undefined : { 'content-type': 'application/json' },
    );
    const res = await fetch(`${this.baseUrl ?? getBackendUrl()}${path}`, {
      method,
      headers: opts.inRun ? headers : withoutExecution(headers),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throwApiError(res, text, `${label} failed: ${res.status} ${res.statusText}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

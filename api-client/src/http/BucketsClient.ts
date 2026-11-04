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

/** What to do when someone being added cannot read an item. */
export type BucketMisfitChoice = 'share' | 'narrow';

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
  narrowed: BucketItemRef[];
}

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
 * Buckets are not part of a run, so these calls never carry the selected
 * execution: the server refuses bucket routes inside one.
 */
export class BucketsClient {
  constructor(
    private readonly operatorKey: string,
    private readonly agentId?: string,
  ) {
    if (!operatorKey) throw new Error('BucketsClient: operatorKey is required');
  }

  create(input: { name: string; audience?: string[]; items?: BucketItemRef[]; share?: boolean }): Promise<BucketInsertResult> {
    return this.send('POST', '/buckets', input, 'bucket create');
  }

  listMine(): Promise<{ buckets: BucketView[] }> {
    return this.send('GET', '/buckets', undefined, 'bucket list');
  }

  get(bucketId: string): Promise<BucketView> {
    return this.send('GET', this.path(bucketId), undefined, 'bucket read');
  }

  items(bucketId: string, opts: { before?: string; limit?: number } = {}): Promise<BucketItemPage> {
    const query = new URLSearchParams();
    if (opts.before) query.set('before', opts.before);
    if (opts.limit !== undefined) query.set('limit', String(opts.limit));
    const suffix = query.size ? `?${query}` : '';
    return this.send('GET', `${this.path(bucketId)}/items${suffix}`, undefined, 'bucket items');
  }

  insert(bucketId: string, items: BucketItemRef[], opts: { share?: boolean } = {}): Promise<BucketInsertResult> {
    return this.send(
      'POST',
      `${this.path(bucketId)}/insert`,
      { items, ...(opts.share ? { share: true } : {}) },
      'bucket insert',
    );
  }

  remove(bucketId: string, items: BucketItemRef[]): Promise<{
    bucket: BucketView; removed: BucketItemRef[]; notIn: BucketItemRef[];
  }> {
    return this.send('POST', `${this.path(bucketId)}/remove`, { items }, 'bucket remove');
  }

  duplicate(
    bucketId: string,
    input: { name: string; audience?: string[]; items?: BucketItemRef[]; share?: boolean },
  ): Promise<BucketInsertResult & { notIn: BucketItemRef[] }> {
    return this.send('POST', `${this.path(bucketId)}/duplicate`, input, 'bucket duplicate');
  }

  move(bucketId: string, input: { to: string; items: BucketItemRef[] }): Promise<BucketMoveResult> {
    return this.send('POST', `${this.path(bucketId)}/move`, input, 'bucket move');
  }

  split(bucketId: string, input: { items: BucketItemRef[]; name: string; audience?: string[] }): Promise<BucketMoveResult> {
    return this.send('POST', `${this.path(bucketId)}/split`, input, 'bucket split');
  }

  addMembers(
    bucketId: string,
    principalIds: string[],
    opts: { onMisfit?: BucketMisfitChoice } = {},
  ): Promise<BucketAddMembersResult> {
    return this.send(
      'POST',
      `${this.path(bucketId)}/members`,
      { principalIds, ...(opts.onMisfit ? { onMisfit: opts.onMisfit } : {}) },
      'bucket add members',
    );
  }

  removeMember(bucketId: string, principalId: string): Promise<{ bucket: BucketView; removed: boolean }> {
    return this.send(
      'DELETE',
      `${this.path(bucketId)}/members/${encodeURIComponent(principalId)}`,
      undefined,
      'bucket remove member',
    );
  }

  rename(bucketId: string, name: string): Promise<BucketView> {
    return this.send('PATCH', this.path(bucketId), { name }, 'bucket rename');
  }

  delete(bucketId: string): Promise<{ bucketId: string; deleted: boolean }> {
    return this.send('DELETE', this.path(bucketId), undefined, 'bucket delete');
  }

  private path(bucketId: string): string {
    return `/buckets/${encodeURIComponent(bucketId)}`;
  }

  private async send<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown, label: string): Promise<T> {
    const res = await fetch(`${getBackendUrl()}${path}`, {
      method,
      headers: withoutExecution(
        buildOperatorHeaders(this.operatorKey, this.agentId, body === undefined ? undefined : { 'content-type': 'application/json' }),
      ),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throwApiError(res, text, `${label} failed: ${res.status} ${res.statusText}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

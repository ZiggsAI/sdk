import { getBackendUrl } from '../utils/urlUtils.js';
import { throwApiError } from '../shared/apiError.js';
import { buildOperatorHeaders, withoutExecution } from './operatorHeaders.js';

/** What a bucket can hold. Each item is a reference, never a copy. */
export const BUCKET_ITEM_KINDS = ['message', 'artifact', 'task', 'agreement'] as const;
export type BucketItemKind = (typeof BUCKET_ITEM_KINDS)[number];

export interface BucketItemRef {
  kind: BucketItemKind;
  id: string;
}

/**
 * Why an item cannot be where it was asked to go. Other members are named only
 * when the caller can read the item itself.
 */
export type BucketMisfit =
  | { item: BucketItemRef; reason: 'you-cannot-read' }
  | { item: BucketItemRef; reason: 'members-cannot-read'; memberIds: string[] };

export interface BucketView {
  bucketId: string;
  name: string;
  createdBy: string;
  /** Who it is for, as given: people, agents, workspaces. */
  audience: string[];
  /** Goes up when an item leaves or the audience changes. */
  revision: number;
  itemCount: number;
  createdAt: string | null;
}

/** One share an insert made because it was asked to. */
export interface BucketShare {
  item: BucketItemRef;
  memberId: string;
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

export interface BucketItemPage {
  items: Array<BucketItemRef & { addedBy: string; addedAt: string | null }>;
  nextCursor: string | null;
}

/**
 * The bucket operations (`/buckets`). A bucket is a working set whose whole
 * audience can read every item in it; the server checks that on every insert,
 * split and member add, and a bucket grants nothing about its items.
 *
 * Buckets are not part of a run yet, so these calls never carry the selected
 * execution: the server refuses bucket routes inside one until runs work in
 * buckets. Nothing leaks through that: an item enters a bucket only when every
 * member can already read it.
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
    return this.send('GET', `/buckets/${encodeURIComponent(bucketId)}`, undefined, 'bucket read');
  }

  items(bucketId: string, opts: { before?: string; limit?: number } = {}): Promise<BucketItemPage> {
    const query = new URLSearchParams();
    if (opts.before) query.set('before', opts.before);
    if (opts.limit !== undefined) query.set('limit', String(opts.limit));
    const suffix = query.size ? `?${query}` : '';
    return this.send('GET', `/buckets/${encodeURIComponent(bucketId)}/items${suffix}`, undefined, 'bucket items');
  }

  insert(bucketId: string, items: BucketItemRef[], opts: { share?: boolean } = {}): Promise<BucketInsertResult> {
    return this.send(
      'POST',
      `/buckets/${encodeURIComponent(bucketId)}/insert`,
      { items, ...(opts.share ? { share: true } : {}) },
      'bucket insert',
    );
  }

  move(bucketId: string, input: { to: string; items: BucketItemRef[] }): Promise<BucketMoveResult> {
    return this.send('POST', `/buckets/${encodeURIComponent(bucketId)}/move`, input, 'bucket move');
  }

  remove(bucketId: string, items: BucketItemRef[]): Promise<{
    bucket: BucketView; removed: BucketItemRef[]; notIn: BucketItemRef[];
  }> {
    return this.send('POST', `/buckets/${encodeURIComponent(bucketId)}/remove`, { items }, 'bucket remove');
  }

  split(bucketId: string, input: { items: BucketItemRef[]; name: string; audience?: string[] }): Promise<BucketMoveResult> {
    return this.send('POST', `/buckets/${encodeURIComponent(bucketId)}/split`, input, 'bucket split');
  }

  addMembers(bucketId: string, principalIds: string[]): Promise<{ bucket: BucketView; added: string[] }> {
    return this.send('POST', `/buckets/${encodeURIComponent(bucketId)}/members`, { principalIds }, 'bucket add members');
  }

  removeMember(bucketId: string, principalId: string): Promise<{ bucket: BucketView; removed: boolean }> {
    return this.send(
      'DELETE',
      `/buckets/${encodeURIComponent(bucketId)}/members/${encodeURIComponent(principalId)}`,
      undefined,
      'bucket remove member',
    );
  }

  private async send<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, label: string): Promise<T> {
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

import {
  BUCKET_ITEM_KINDS,
  type BucketAddMembersResult,
  type BucketContents,
  type BucketInsertResult,
  type BucketItemKind,
  type BucketItemPage,
  type BucketItemRef,
  type BucketMisfit,
  type BucketShare,
  type BucketThread,
  type BucketView,
  type MessageCommand,
  type MessageCommandResult,
} from '@ziggs-ai/contracts';
import { getBackendUrl } from '../utils/urlUtils.js';
import { throwApiError } from '../shared/apiError.js';
import { buildOperatorHeaders, withoutExecution } from './operatorHeaders.js';

export { BUCKET_ITEM_KINDS };
export type {
  BucketAddMembersResult,
  BucketContents,
  BucketInsertResult,
  BucketItemKind,
  BucketItemPage,
  BucketItemRef,
  BucketMisfit,
  BucketShare,
  BucketThread,
  BucketView,
};

/**
 * What to do when someone being added cannot read an item: share it with
 * them, or split: start a narrower bucket with them and only what everyone
 * can read, leaving this one as it is.
 */
export type BucketMisfitChoice = 'share' | 'split';

export interface BucketJoinResult {
  bucket: BucketView;
  added: string[];
  joined: BucketItemRef[];
  shared: BucketShare[];
}

/**
 * A message sent inside a bucket: its readers are the bucket's people, and for
 * a reply that names the message it answers, those who read that message and
 * have it in a bucket of theirs. Work goes in only with its other side here.
 */
export type BucketMessage = Omit<MessageCommand, 'audience'>;

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
    // Under the selected run: the server reads the people named from its work.
    return this.request('POST', '/buckets', input, 'bucket create', { inRun: true });
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
      { inRun: true },
    );
  }

  /**
   * Bring an agreement's people into a bucket: now when it has started, else
   * invited until it does. An open listing stays invited: everyone who takes
   * it, or writes to its agent as a stranger, gets their own split of this
   * bucket.
   */
  invite(
    bucketId: string,
    input: { agreementId: string; onMisfit?: BucketMisfitChoice },
  ): Promise<BucketAddMembersResult & { invited: boolean }> {
    return this.request('POST', `${this.path(bucketId)}/invites`, input, 'bucket invite', { inRun: true });
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

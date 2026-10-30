import type { WriteSource } from '../capabilities/sources.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { throwApiError } from '../shared/apiError.js';
import { buildOperatorHeaders } from './operatorHeaders.js';

/** What became of one hello. `expired` is derived by the server, not stored. */
export type IntroductionStatus =
  | 'open'
  | 'redeemed'
  | 'declined'
  | 'revoked'
  | 'expired';

/**
 * Where a redeem ended. `joined`: your agent is in the thing the token names
 * (your own token, a teammate's, or someone you are already linked to).
 * `claimed` / `bid` / `accepted`: the listing, request or proposal it names.
 * `link_pending`: a link both people still approve.
 */
export type IntroductionOutcome =
  | 'joined'
  | 'claimed'
  | 'bid'
  | 'accepted'
  | 'link_pending';

export interface IntroductionFrom {
  orgId: string;
  agentId: string | null;
  agentCreatedAt?: string | null;
  claimedLabel: {
    text: string;
    selfChosen: boolean;
    verified: boolean;
  };
  /**
   * Same text as claimedLabel.text. Not identity. Remove after 2026-10-07;
   * readers must use claimedLabel.
   */
  label?: string;
}

export interface IntroductionView {
  token: string;
  status: IntroductionStatus;
  outcome: IntroductionOutcome | null;
  notice?: string;
  from: IntroductionFrom;
  venue: string | null;
  venueRef: string | null;
  note: string | null;
  /** What the token is about. The public view gives kind and title only. */
  about?: {
    kind: 'agreement' | 'task' | 'chat' | 'workspace';
    id?: string;
    title: string | null;
    shape: 'listing' | 'request' | 'proposal' | null;
  } | null;
  /** How many people the token serves, and how many are left. */
  redeems?: { allowed: number; left: number };
  /** Ziggs emailed it, and only the person signed in with that address redeems it. */
  addressed?: boolean;
  agreementId: string | null;
  redeemedBy: { agentId: string | null; orgId: string | null } | null;
  /** The minter's list only: each redeemer and where they ended. */
  redemptions?: Array<{
    agentId: string | null;
    orgId: string | null;
    outcome: IntroductionOutcome;
    agreementId: string | null;
    at: string;
  }>;
  /** Returned to a redeemer only: the room its agent is now in. */
  chatId?: string | null;
  expiresAt: string;
  /** The public page the string points at. This is what you hand over. */
  url: string;
  /**
   * Returned to a redeemer only: the two ids the meeting is now worth, and what
   * each is for. `agentId` is where messages go; `principal` is who can be a
   * party to an agreement. Passing one where the other belongs is refused as if
   * the agent did not exist, which is the wall this field exists to remove.
   */
  counterparty?: {
    principal: string;
    agentId: string | null;
    claimedLabel: {
      text: string;
      selfChosen: boolean;
      verified: boolean;
    };
    /** Same text as claimedLabel.text. Remove after 2026-10-07. */
    label?: string;
    nextStep: string;
  };
}

export interface MintIntroductionInput {
  venue?: string;
  venueRef?: string;
  note?: string;
  /** What the token is about: a listing, request or proposal (agreement), a task, or a chat you hold. */
  about?: { kind: 'agreement' | 'task' | 'chat'; id: string };
  /** How many people it serves, 1 to 25. Your own sessions never use one up. */
  redeems?: number;
  /** What this text drew on. See {@link WriteSource}. */
  sources?: WriteSource[];
}

/**
 * Introduction tokens — the one object to exchange when you meet an
 * agent somewhere Ziggs does not own.
 *
 * The token carries no authority, which is why minting one is free: it widens
 * nobody's reach. Redeeming one stages a link proposal the two humans sign.
 */
export class IntroductionsClient {
  private readonly operatorKey: string;
  private readonly agentId?: string;
  private readonly baseUrl: string;

  constructor(operatorKey: string, agentId?: string, baseUrl?: string) {
    if (!operatorKey) {
      throw new Error('IntroductionsClient: operatorKey is required');
    }
    this.operatorKey = operatorKey;
    this.agentId = agentId;
    this.baseUrl = baseUrl || getBackendUrl();
  }

  async mint(input: MintIntroductionInput = {}): Promise<IntroductionView> {
    return this.call('POST', '/introductions', input, 'mint');
  }

  async redeem(token: string): Promise<IntroductionView> {
    return this.call(
      'POST',
      `/introductions/${encodeURIComponent(token)}/redeem`,
      {},
      'redeem',
    );
  }

  async decline(token: string): Promise<IntroductionView> {
    return this.call(
      'POST',
      `/introductions/${encodeURIComponent(token)}/decline`,
      {},
      'decline',
    );
  }

  async revoke(token: string): Promise<IntroductionView> {
    return this.call(
      'DELETE',
      `/introductions/${encodeURIComponent(token)}`,
      undefined,
      'revoke',
    );
  }

  async listMine(limit?: number): Promise<IntroductionView[]> {
    const query = limit != null ? `?limit=${encodeURIComponent(String(limit))}` : '';
    return this.call('GET', `/introductions${query}`, undefined, 'listMine');
  }

  private async call<T>(
    method: string,
    path: string,
    body: unknown,
    label: string,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...buildOperatorHeaders(this.operatorKey, this.agentId),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throwApiError(
        res,
        text,
        `IntroductionsClient.${label} failed: ${res.status}`,
      );
    }
    return JSON.parse(text) as T;
  }
}

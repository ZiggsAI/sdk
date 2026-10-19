import { getBackendUrl } from '../utils/urlUtils.js';
import { buildOperatorHeaders } from './operatorHeaders.js';
import { GrantsClient } from './GrantsClient.js';
import type { GrantView } from './grants.js';
import { throwApiError } from '../shared/apiError.js';

function randomIdempotencyKey(prefix = 'op'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}


/** Thrown by PaymentsClient with the HTTP status and raw body attached. */
export interface PaymentsError extends Error {
  status?: number;
  body?: string;
}

/** The wallet stores `pez`. A person or an assistant reads points. */
function shownPointCurrency(currency: unknown): string {
  return typeof currency === 'string' && currency && currency !== 'pez' ? currency : 'points';
}

export interface WalletBalance {
  walletId: string | null;
  /** Always `points` on a read. The wallet row stores a different code. */
  currency: string;
  /** Hundredths of a point. */
  balance: number;
  /** Hundredths of a point, total minus holds. */
  availableBalance: number;
  unit: 'hundredths of a point';
}

// ---------------------------------------------------------------------------
// canonical result shapes. Every tool surface (agent-sdk, ziggs-mcp,
// scripts) reads these instead of re-casting `unknown` per surface. Envelope
// shapes mirror the wire (e.g. issueGrant returns `{ grant }`) so existing
// script callers keep working; flattening for LLM tools happens once, in the
// shared capability layer.
// ---------------------------------------------------------------------------

/**
 * A resolved wallet reference (GET /payments/wallets/resolve).
 *
 * The wire's shape, not a guess at it. This was all-optional with no `orgId`,
 * so a caller could not tell a wallet that has no org from one whose org the
 * client forgot to declare — and every field being optional meant TypeScript
 * agreed with any misreading of the response.
 */
import type { WalletRef } from '@ziggs-ai/contracts';
export type { WalletRef };

/**
 * A payment grant as this rail answers it.
 *
 * `parentGrantId` is `string | null`, which is what the wire sends — it was
 * `string | undefined` here, so a root grant's explicit `null` did not match
 * the declared type and `parentGrantId === undefined` was a test for "is this
 * a root grant" that never passed.
 */
export interface PaymentGrantView {
  grantId?: string;
  holderId?: string;
  parentGrantId?: string | null;
  caveats?: unknown[];
  expiresAt?: string | null;
  [key: string]: unknown;
}

export interface PaymentGrantEnvelope {
  grant?: PaymentGrantView;
  [key: string]: unknown;
}

export interface RevokeGrantResult {
  revoked?: unknown;
  [key: string]: unknown;
}

/**
 * the one payments client for every surface (agent-sdk, ziggs-mcp,
 * scripts). Consolidates the former agent-sdk private ZiggsPayClient. Wallet
 * ops ride the operator key; agent-impersonated calls send X-Agent-Id and are
 * policy-gated server-side. Points move only when an agreement or a task
 * settles, and the server does that; there is no standalone movement verb on
 * this client. Wallet-rail grant mutations (issue / attenuate / revoke) live
 * here; grant *listing* is the unified GET /grants.
 */
export class PaymentsClient {
  private readonly operatorKey: string;
  private readonly agentId?: string;
  private readonly baseUrl: string;
  private readonly laneId?: string;

  /**
   * @param laneId the wake's lane (a chat id, or `agrn-<agreementId>`), sent as
   *   X-Ziggs-Lane. It tells the backend which hire this wake is in, and the
   *   backend reads off it WHO the spend is for. An agent that serves several
   *   hirers holds all of their grants at once and the holder is the same agent
   *   in every one, so without a lane, spend authority one customer gave is
   *   spendable while the agent works for another. ConnectionsClient and
   *   ArtifactsClient send the same header for the same reason.
   *
   *   Omitting it cannot widen anything — a stated lane can only cause a
   *   refusal — but it does leave the spend unfenced, so a caller that knows
   *   its lane should pass it.
   */
  constructor(
    operatorKey: string,
    agentId?: string,
    baseUrl?: string,
    laneId?: string,
  ) {
    if (!operatorKey) throw new Error('PaymentsClient: operatorKey is required');
    this.operatorKey = operatorKey;
    this.agentId = agentId;
    this.baseUrl = baseUrl || getBackendUrl();
    this.laneId = laneId;
  }

  async balance(): Promise<WalletBalance> {
    const w = (await this._get('/payments/wallet')) as Record<string, unknown>;
    const wallet = w['wallet'] as Record<string, unknown> | undefined;
    return {
      walletId: (wallet?.['walletId'] as string) || null,
      currency: shownPointCurrency(wallet?.['currency']),
      balance: (w['balance'] as number) ?? 0,
      availableBalance: (w['availableBalance'] as number) ?? 0,
      unit: 'hundredths of a point',
    };
  }

  async resolve({ userId, agentId }: { userId?: string; agentId?: string } = {}): Promise<WalletRef | null> {
    if (!userId && !agentId) throw new Error('resolve: provide userId or agentId');
    const params = new URLSearchParams();
    if (userId) params.set('userId', userId);
    if (agentId) params.set('agentId', agentId);
    const res = (await this._get(`/payments/wallets/resolve?${params}`)) as Record<string, unknown>;
    return (res['wallet'] as WalletRef) || null;
  }

  async history(params: { limit?: number; offset?: number; type?: string } = {}): Promise<unknown> {
    const q = new URLSearchParams();
    if (params.limit != null) q.set('limit', String(params.limit));
    if (params.offset != null) q.set('offset', String(params.offset));
    if (params.type) q.set('type', params.type);
    return this._get('/payments/history' + (q.toString() ? `?${q}` : ''));
  }

  async issueGrant({ holderId, caveats }: { holderId: string; caveats?: unknown }): Promise<PaymentGrantEnvelope> {
    return (await this._post('/payments/grants', { holderId, caveats })) as PaymentGrantEnvelope;
  }

  async revokeGrant(grantId: string): Promise<RevokeGrantResult> {
    return (await this._request(
      'DELETE',
      `/payments/grants/${grantId}`,
      undefined,
    )) as RevokeGrantResult;
  }

  /**
   * Live wallet grants the acting agent holds, via the unified GET /grants
   * (retired GET /payments/grants), following the cursor to completion.
   */
  async listGrants(): Promise<GrantView[]> {
    const grants = new GrantsClient(
      this.operatorKey,
      this.agentId,
      this.baseUrl,
      this.laneId,
    );
    return grants.listAllGrants({ scopeKind: 'wallet', health: 'active' });
  }

  async faucet({
    amount,
    description = 'Faucet',
    idempotencyKey,
  }: { amount?: number; description?: string; idempotencyKey?: string } = {}): Promise<unknown> {
    return this._post('/payments/wallet/fund', {
      amount,
      idempotencyKey: idempotencyKey || randomIdempotencyKey('faucet'),
      description,
    });
  }

  private async _request(method: string, path: string, body: unknown): Promise<unknown> {
    const init: RequestInit = {
      method,
      headers: buildOperatorHeaders(
        this.operatorKey,
        this.agentId,
        body !== undefined ? { 'content-type': 'application/json' } : {},
        this.laneId,
      ),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${this.baseUrl}${path}`, init);
    const text = await response.text();
    if (!response.ok) {
      // ApiError; PaymentsError remains the duck type for `.status`.
      throwApiError(response, text, `HTTP ${response.status}`);
    }
    return text ? JSON.parse(text) : null;
  }

  private _get(path: string): Promise<unknown> {
    return this._request('GET', path, undefined);
  }

  private _post(path: string, body: unknown): Promise<unknown> {
    return this._request('POST', path, body ?? {});
  }
}

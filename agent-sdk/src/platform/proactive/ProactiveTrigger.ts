import { publishOffer, pullOffers, claimOpenAgreement, type Creds } from '@ziggs-ai/api-client';
import type { PublishOfferPayload, PullOffersOptions } from '@ziggs-ai/api-client';
import { runtimeLog } from '../../shared/runtimeLog.js';

interface TickContext {
  agentId: string;
  marketplace: {
    publishOffer: (payload: PublishOfferPayload) => Promise<unknown>;
    pullOffers: (options?: PullOffersOptions) => Promise<unknown[]>;
    /**
     * Claim any open broadcast. One verb: the backend routes on which side of
     * the row is open, and a caller cannot work that out for itself — reading
     * the agreement first is party-scoped, and a claimer is by definition not
     * yet a party.
     */
    claimAgreement: (agreementId: string) => Promise<unknown>;
  };
}

interface ProactiveTriggerOptions {
  interval: number;
  creds: Creds;
  onTick: (ctx: TickContext) => Promise<void>;
  onError?: (err: unknown) => void;
  runImmediately?: boolean;
}

export class ProactiveTrigger {
  private interval: number;
  private creds: Creds;
  private onTick: (ctx: TickContext) => Promise<void>;
  private onError: (err: unknown) => void;
  private runImmediately: boolean;
  private _running: boolean;
  private _timer: ReturnType<typeof setTimeout> | null;

  constructor({ interval, creds, onTick, onError, runImmediately = false }: ProactiveTriggerOptions) {
    if (!interval || typeof interval !== 'number' || interval < 1000) throw new Error('ProactiveTrigger: interval must be a number >= 1000ms');
    if (!creds?.operatorKey || !creds?.agentId) throw new Error('ProactiveTrigger: creds.operatorKey and creds.agentId are required');
    if (typeof onTick !== 'function') throw new Error('ProactiveTrigger: onTick must be a function');
    this.interval = interval;
    this.creds = creds;
    this.onTick = onTick;
    this.onError = onError ?? ((err) => runtimeLog.error('ProactiveTrigger', `tick error: ${String(err)}`));
    this.runImmediately = runImmediately;
    this._running = false;
    this._timer = null;
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    runtimeLog.debug(
      'ProactiveTrigger',
      `started (agentId=${this.creds.agentId}, interval=${this.interval}ms)`,
    );
    if (this.runImmediately) this._tick();
    else this._schedule();
  }

  stop(): void {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    runtimeLog.debug('ProactiveTrigger', `stopped (agentId=${this.creds.agentId})`);
  }

  private _schedule(): void {
    if (!this._running) return;
    this._timer = setTimeout(() => this._tick(), this.interval);
  }

  private async _tick(): Promise<void> {
    if (!this._running) return;
    try { await this.onTick(this._buildContext()); } catch (err) { this.onError(err); }
    this._schedule();
  }

  private _buildContext(): TickContext {
    const creds = this.creds;
    return {
      agentId: creds.agentId,
      marketplace: {
        publishOffer: (payload) => publishOffer(payload, creds),
        pullOffers: (options) => pullOffers(options, creds),
        claimAgreement: (agreementId) => claimOpenAgreement(agreementId, creds),
      },
    };
  }
}

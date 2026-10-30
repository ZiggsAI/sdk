import { runtimeLog } from '../shared/runtimeLog.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import { buildOperatorHeaders, withoutExecution } from './operatorHeaders.js';

export class TelemetryClient {
  private readonly operatorKey: string;
  private readonly agentId?: string;
  private _queue: unknown[];
  private _flushing: boolean;

  /**
   * @param operatorKey Agent-scoped or fleet operator key.
   * @param agentId Required for fleet keys (sent as X-Agent-Id). Omit for agent-scoped keys.
   */
  constructor(operatorKey: string, agentId?: string) {
    if (!operatorKey) throw new Error('TelemetryClient: operatorKey is required');
    this.operatorKey = operatorKey;
    this.agentId = agentId;
    this._queue = [];
    this._flushing = false;
  }

  async send(payload: unknown): Promise<void> {
    this._queue.push(payload);
    if (!this._flushing) this._flush();
  }

  private async _flush(): Promise<void> {
    this._flushing = true;
    while (this._queue.length > 0) {
      const batch = this._queue.splice(0, 10);
      await Promise.allSettled(batch.map((p) => this._post(p)));
    }
    this._flushing = false;
  }

  private async _post(payload: unknown): Promise<void> {
    const url = `${getBackendUrl()}/agents/monitoring/ingest`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: withoutExecution(
          buildOperatorHeaders(this.operatorKey, this.agentId, {
            'content-type': 'application/json',
          }),
        ),
        body: JSON.stringify({ payload }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        runtimeLog.warn(
          'TelemetryClient',
          `⚠️ ingest failed agent=${this.agentId} ${res.status} ${res.statusText} body=${body.slice(0, 200)}`,
        );
      }
    } catch (err) {
      runtimeLog.warn('TelemetryClient', `⚠️ ingest error agent=${this.agentId} message=${(err as Error).message}`);
    }
  }
}

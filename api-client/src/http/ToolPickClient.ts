import { buildCredsHeaders } from './operatorHeaders.js';
import { getBackendUrl } from '../utils/urlUtils.js';
import type { Creds } from '../types.js';

/** One catalog row as the picker reads it. */
export interface ToolPickOption {
  name: string;
  line: string;
}

/**
 * - `pick`         one tool does the need: `tool` names it.
 * - `nothing_fits` no tool does it.
 * - `unsure` / `off` no answer worth giving: show the list.
 */
export interface ToolPickAnswer {
  how: 'pick' | 'nothing_fits' | 'unsure' | 'off';
  tool?: string;
  confidence?: number;
}

/** Null means "no answer": the surface shows the list it always has. */
export type PickTool = (need: string, options: ToolPickOption[]) => Promise<ToolPickAnswer | null>;

/** A listing is always the fallback, so waiting long for a pick buys nothing. */
const TIMEOUT_MS = 6000;

/**
 * The backend picker: `POST /internal/tool-pick` with this connection's key.
 * The model call and its key live on the backend, since this server also runs
 * on a caller's own machine. Any failure is null, including the 404 from a
 * backend that predates the route.
 */
export function backendToolPick(creds: Creds): PickTool {
  return async (need, options) => {
    if (!creds.operatorKey) return null;
    try {
      const res = await fetch(`${getBackendUrl()}/internal/tool-pick`, {
        method: 'POST',
        headers: buildCredsHeaders(creds),
        body: JSON.stringify({ need, options }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      const data = (await res.json().catch(() => null)) as ToolPickAnswer | null;
      if (!data || typeof data.how !== 'string') return null;
      return data;
    } catch {
      return null;
    }
  };
}


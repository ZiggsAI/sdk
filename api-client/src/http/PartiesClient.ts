import { getBackendUrl } from '../utils/urlUtils.js';
import { throwApiError } from '../shared/apiError.js';
import { buildOperatorHeaders } from './operatorHeaders.js';

/** What a workspace keeps about a person who is not on Ziggs yet. */
export interface PartyNotesView {
  partyId: string;
  notes: string | null;
}

/**
 * A person who is not on Ziggs yet, as your workspace keeps them: someone it
 * reaches by email or Slack. Only the workspace that vouches for them writes
 * or reads what it knows about them.
 */
export class PartiesClient {
  private readonly operatorKey: string;
  private readonly agentId?: string;
  private readonly baseUrl: string;

  constructor(operatorKey: string, agentId?: string, baseUrl?: string) {
    if (!operatorKey) {
      throw new Error('PartiesClient: operatorKey is required');
    }
    this.operatorKey = operatorKey;
    this.agentId = agentId;
    this.baseUrl = baseUrl || getBackendUrl();
  }

  /** Replace the notes; an empty string clears them. */
  async setNotes(partyId: string, notes: string): Promise<PartyNotesView> {
    const res = await fetch(
      `${this.baseUrl}/parties/${encodeURIComponent(partyId)}/notes`,
      {
        method: 'PUT',
        headers: {
          ...buildOperatorHeaders(this.operatorKey, this.agentId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ notes }),
      },
    );
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throwApiError(res, text, `PartiesClient.setNotes failed: ${res.status}`);
    }
    return JSON.parse(text) as PartyNotesView;
  }
}

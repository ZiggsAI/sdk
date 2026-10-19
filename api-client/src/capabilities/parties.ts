import { PartiesClient } from '../http/PartiesClient.js';
import { type CapabilityDefinition, fullCreds } from './types.js';

/**
 * What your workspace knows about a person who is not on Ziggs yet.
 *
 * The room snapshot names them in `users` with `claimed: false`, and carries
 * these notes for your workspace's readers, so the next session that wakes
 * knows who they are without asking again.
 */
export const partyNoteCapability: CapabilityDefinition = {
  key: 'party_note',
  names: { sdk: 'party_note', mcp: 'ziggs_party_note' },
  title: 'Note who a person not on Ziggs yet is',
  descriptions: {
    sdk: 'Replace what your workspace knows about a person who is not on Ziggs yet: who they are, how you met, what they asked for (PUT /parties/{partyId}/notes). partyId is their userId in the room snapshot, on the entry with claimed: false. The notes show in the snapshot of every room they are in, to your workspace only. An empty string clears them; at most 2000 characters. Write what you learned, not what they said verbatim.',
  },
  annotation: 'write',
  params: {
    partyId: {
      type: 'string',
      required: true,
      description:
        'The person: their userId in the room snapshot, where claimed is false.',
    },
    notes: {
      type: 'string',
      required: true,
      description:
        'The whole note, replacing the previous one. Empty clears it. At most 2000 characters.',
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const creds = fullCreds(env);
    const client = new PartiesClient(creds.operatorKey, creds.agentId);
    const saved = await client.setNotes(
      args['partyId'] as string,
      args['notes'] as string,
    );
    return {
      party: saved,
      message: saved.notes
        ? 'Saved. It shows in the snapshot of every room they are in, to your workspace only.'
        : 'Cleared.',
    };
  },
};

export const PARTY_CAPABILITIES: CapabilityDefinition[] = [partyNoteCapability];

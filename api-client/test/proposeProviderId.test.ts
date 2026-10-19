import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AGREEMENT_PROPOSE_PROVIDER_ID_DESCRIPTION } from '../src/capabilities/proposeProviderId.js';

describe('AGREEMENT_PROPOSE_PROVIDER_ID_DESCRIPTION (ZIG-1274)', () => {
  it('states the direct-proposal rule before broadcast nuances', () => {
    const desc = AGREEMENT_PROPOSE_PROVIDER_ID_DESCRIPTION;
    assert.match(desc, /^REQUIRED on a direct proposal/i);
    assert.match(desc, /your own id \(you are offering to work\)/);
    assert.match(desc, /proposedTo id \(you are commissioning the recipient\)/);
    const requiredAt = desc.search(/REQUIRED on a direct proposal/i);
    const broadcastAt = desc.search(/Broadcast/i);
    assert.ok(requiredAt >= 0 && broadcastAt > requiredAt);
    assert.match(desc, /person or the deploy publishes a standing listing/i);
    assert.doesNotMatch(desc, /your own id for a standing offer/);
  });
});

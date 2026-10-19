import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOpaquePresentationRef,
  isPersonaRef,
  isRoomPresentationRef,
} from '../src/types.js';

describe('presentation ref helpers (ZIG-1137)', () => {
  it('detects persona refs', () => {
    assert.equal(isPersonaRef('psn_abc'), true);
    assert.equal(isPersonaRef('rpb_abc'), false);
    assert.equal(isPersonaRef('agent-1'), false);
    assert.equal(isPersonaRef(null), false);
  });

  it('detects room presentation refs', () => {
    assert.equal(isRoomPresentationRef('rpb_face'), true);
    assert.equal(isRoomPresentationRef('psn_face'), false);
    assert.equal(isRoomPresentationRef(''), false);
  });

  it('groups opaque presentation refs', () => {
    assert.equal(isOpaquePresentationRef('psn_x'), true);
    assert.equal(isOpaquePresentationRef('rpb_y'), true);
    assert.equal(isOpaquePresentationRef('user-1'), false);
  });
});

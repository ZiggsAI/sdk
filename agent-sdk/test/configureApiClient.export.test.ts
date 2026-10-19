import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  configureApiClient,
  getBackendUrl,
  type ApiClientConfig,
} from '../src/index.js';

describe('ZIG-1204 configureApiClient re-export', () => {
  it('lets an agent-sdk-only consumer point HTTP at a non-default backend', () => {
    const cfg: ApiClientConfig = { httpUrl: 'https://api.example.test' };
    configureApiClient(cfg);
    assert.equal(getBackendUrl(), 'https://api.example.test');
  });
});

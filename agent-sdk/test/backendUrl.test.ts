import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configureApiClient } from '@ziggs-ai/api-client';
import { resolveBackendUrl } from '../src/shared/backendUrl.js';

// ZIG-2058 — one reading of the backend address. The per-user connect path
// fell back to localhost when only configureApiClient was set.
describe('resolveBackendUrl', () => {
  const saved = {
    ZIGGS_BACKEND_URL: process.env.ZIGGS_BACKEND_URL,
    BACKEND_URL: process.env.BACKEND_URL,
  };
  beforeEach(() => {
    delete process.env.ZIGGS_BACKEND_URL;
    delete process.env.BACKEND_URL;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    configureApiClient({ httpUrl: undefined });
  });

  test('uses configureApiClient when nothing else is set, never localhost', () => {
    configureApiClient({ httpUrl: 'https://api.partner.example/' });
    assert.equal(resolveBackendUrl(), 'https://api.partner.example');
  });

  test('explicit config beats the runner overrides, which beat the client config', () => {
    configureApiClient({ httpUrl: 'https://api.partner.example' });
    process.env.BACKEND_URL = 'http://backend.local:3000/';
    assert.equal(resolveBackendUrl(), 'http://backend.local:3000');
    process.env.ZIGGS_BACKEND_URL = 'http://ziggs.local:3000';
    assert.equal(resolveBackendUrl(), 'http://ziggs.local:3000');
    assert.equal(resolveBackendUrl('https://explicit.example/'), 'https://explicit.example');
  });
});

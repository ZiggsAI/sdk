import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getBackendUrl } from '../src/utils/urlUtils.js';
import { apiClientConfig, configureApiClient } from '../src/config.js';

describe('urlUtils', () => {
  const savedHttp = apiClientConfig().httpUrl;

  afterEach(() => {
    configureApiClient({ httpUrl: savedHttp ?? '' });
  });

  it('defaults the backend URL when nothing is configured', () => {
    configureApiClient({ httpUrl: '' });
    assert.match(getBackendUrl(), /^https:\/\//);
  });

  it('prefixes bare host with https', () => {
    configureApiClient({ httpUrl: 'example.com' });
    assert.equal(getBackendUrl(), 'https://example.com');
  });

  it('preserves explicit http URL', () => {
    configureApiClient({ httpUrl: 'http://127.0.0.1:3000' });
    assert.equal(getBackendUrl(), 'http://127.0.0.1:3000');
  });
});

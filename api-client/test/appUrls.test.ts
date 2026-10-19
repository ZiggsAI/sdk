import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveWebAppOrigin,
  agreementAppUrl,
  connectInviteAppUrl,
  connectionsSettingsAppUrl,
} from '../src/utils/appUrls.js';

it('normalizes the origin and encodes opaque path and query identifiers', () => {
  const origin = resolveWebAppOrigin(
    ' ; https://app.example///;https://other.example',
  );
  assert.equal(
    agreementAppUrl(origin, 'a/b?c'),
    'https://app.example/app/agreements/a%2Fb%3Fc',
  );
  assert.equal(
    connectInviteAppUrl(origin, 'a/b'),
    'https://app.example/connect/a%2Fb',
  );
  assert.equal(
    connectionsSettingsAppUrl(origin, 'a&b'),
    'https://app.example/app/access?request=a%26b',
  );
});
it('resolves SDK links from backend origins without mistaking localhost in a remote hostname', () => {
  assert.equal(
    resolveWebAppOrigin(undefined, 'http://localhost:3000'),
    'http://localhost:1234',
  );
  assert.equal(
    resolveWebAppOrigin(undefined, 'https://api.ziggsai.com'),
    'https://ziggsai.com',
  );
  assert.equal(
    resolveWebAppOrigin(undefined, 'https://localhost.example.com'),
    'https://localhost.example.com',
  );
});

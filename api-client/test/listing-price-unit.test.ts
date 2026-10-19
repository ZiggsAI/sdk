import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toListingRow } from '../src/capabilities/marketplace.js';

test('a marketplace row names the price unit and does not say pez or cents (ZIG-2120)', () => {
  const row = toListingRow(
    { agreementId: 'agr_1', money: { price: 500 }, terms: { billing: 'per_task', description: 'review' } },
    'offer',
  );
  assert.equal(row.price, 500);
  assert.equal(row.priceUnit, 'hundredths of a point');
  assert.equal(JSON.stringify(row).includes('pez'), false);
  assert.equal(JSON.stringify(row).includes('cents'), false);
});

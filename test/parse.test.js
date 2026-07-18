'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extract } = require('../lib/parse');

test('spreadsheet headers beat dense boolean columns', async () => {
  const csv = [
    'Product,Price USD - 5g,Price USD - 100g,Stock Note,Hot Sell',
    'Anavar,350,1450,,Yes',
    '1-Test C (DHB),,1100,,No',
    'Cabergoline,,,"$1,800 per gram",No',
  ].join('\n');

  const result = await extract(Buffer.from(csv), 'prices.csv');

  assert.deepEqual(result.rows, [
    { name: 'Anavar (5g)', price_cents: 35000 },
    { name: 'Anavar (100g)', price_cents: 145000 },
    { name: '1-Test C (DHB) (100g)', price_cents: 110000 },
    { name: 'Cabergoline (gram)', price_cents: 180000 },
  ]);
  assert.equal(result.rows.some((row) => /^(?:yes|no)$/i.test(row.name)), false);
});

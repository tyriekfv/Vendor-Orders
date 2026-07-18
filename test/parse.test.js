'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { extract } = require('../lib/parse');

test('spreadsheet headers beat dense boolean columns', async () => {
  const csv = [
    'Product,Price USD - 5g,Price USD - 100g,Stock Note,Hot Sell',
    'Anavar,,1450,,Yes',
    '1-Test C (DHB),,1100,,No',
    'Sildenafil,590,,,No',
  ].join('\n');

  const result = await extract(Buffer.from(csv), 'prices.csv');

  assert.deepEqual(result.rows, [
    { name: 'Anavar', price_cents: 145000 },
    { name: '1-Test C (DHB)', price_cents: 110000 },
    { name: 'Sildenafil', price_cents: 59000 },
  ]);
  assert.equal(result.rows.some((row) => /^(?:yes|no)$/i.test(row.name)), false);
});

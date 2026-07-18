'use strict';
// Vendor Order Tool — local server. All data stays in ./data/orders.db on this machine.
// Start with `npm start`, then open http://localhost:4321

const express = require('express');
const multer = require('multer');
const path = require('node:path');
const { db } = require('./lib/db');
const { extract } = require('./lib/parse');
const { matchItem, parseQuickOrder } = require('./lib/match');
const { buildQuote } = require('./lib/pricing');

const PORT = process.env.PORT || 4321;
const app = express();

// Optional password gate: set APP_PASSWORD to require HTTP Basic auth on
// everything (any username). Essential if the app is reachable beyond
// localhost — e.g. through a reverse proxy or Cloudflare tunnel.
const APP_PASSWORD = process.env.APP_PASSWORD;
if (APP_PASSWORD) {
  const crypto = require('node:crypto');
  const expected = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  app.use((req, res, next) => {
    const [scheme, cred] = String(req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && cred) {
      const pass = Buffer.from(cred, 'base64').toString().split(':').slice(1).join(':');
      const given = crypto.createHash('sha256').update(pass).digest();
      if (crypto.timingSafeEqual(given, expected)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Vendor Orders", charset="UTF-8"');
    res.status(401).send('Authentication required');
  });
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const asyncRoute = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(400).json({ error: err.message });
  });
};

// ---------- helpers ----------

function getVendor(id) {
  const v = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  if (!v) throw new Error(`Vendor ${id} not found`);
  return v;
}

function vendorItems(vendorId) {
  return db.prepare('SELECT * FROM items WHERE vendor_id = ? ORDER BY name').all(vendorId);
}

function num(v, fallback = null) {
  if (v === '' || v == null) return fallback;
  const n = Number(v);
  if (!isFinite(n) || n < 0) throw new Error(`Invalid number: ${v}`);
  return n;
}

function centsOrNull(v) {
  const n = num(v, null);
  return n == null ? null : Math.round(n * 100);
}

function normalizeTiers(tiers) {
  if (!Array.isArray(tiers)) return '[]';
  const clean = tiers
    .map((t) => ({ min_qty: Math.max(2, Math.round(num(t.min_qty, 0))), price_cents: Math.round(num(t.price_cents, 0)) }))
    .filter((t) => t.min_qty >= 2 && t.price_cents > 0)
    .sort((a, b) => a.min_qty - b.min_qty);
  return JSON.stringify(clean);
}

// Resolve request lines ({item_id, qty}) to actual item rows.
function resolveLines(vendorId, lines) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('Order has no lines');
  const stmt = db.prepare('SELECT * FROM items WHERE id = ? AND vendor_id = ?');
  return lines.map((l) => {
    const item = stmt.get(l.item_id, vendorId);
    if (!item) throw new Error(`Item ${l.item_id} not found for this vendor`);
    const qty = Math.max(1, Math.round(num(l.qty, 1)));
    return { item, qty };
  });
}

// ---------- vendors ----------

app.get('/api/vendors', (req, res) => {
  const rows = db
    .prepare(
      `SELECT v.*, (SELECT COUNT(*) FROM items i WHERE i.vendor_id = v.id) AS item_count
       FROM vendors v ORDER BY v.name`
    )
    .all();
  res.json(rows);
});

app.post('/api/vendors', asyncRoute((req, res) => {
  const { name } = req.body;
  if (!name || !String(name).trim()) throw new Error('Vendor name is required');
  const info = db
    .prepare(
      `INSERT INTO vendors (name, tax_rate, shipping_cents, free_ship_over_cents, min_order_cents, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(name).trim(),
      num(req.body.tax_rate, 0),
      centsOrNull(req.body.shipping) ?? 0,
      centsOrNull(req.body.free_ship_over),
      centsOrNull(req.body.min_order),
      String(req.body.notes || '')
    );
  res.json(getVendor(info.lastInsertRowid));
}));

app.get('/api/vendors/:id', asyncRoute((req, res) => {
  const vendor = getVendor(req.params.id);
  res.json({ ...vendor, items: vendorItems(vendor.id) });
}));

app.put('/api/vendors/:id', asyncRoute((req, res) => {
  const v = getVendor(req.params.id);
  db.prepare(
    `UPDATE vendors SET name = ?, tax_rate = ?, shipping_cents = ?, free_ship_over_cents = ?,
     min_order_cents = ?, notes = ? WHERE id = ?`
  ).run(
    String(req.body.name ?? v.name).trim(),
    num(req.body.tax_rate, v.tax_rate),
    centsOrNull(req.body.shipping) ?? v.shipping_cents,
    req.body.free_ship_over === undefined ? v.free_ship_over_cents : centsOrNull(req.body.free_ship_over),
    req.body.min_order === undefined ? v.min_order_cents : centsOrNull(req.body.min_order),
    String(req.body.notes ?? v.notes),
    v.id
  );
  res.json(getVendor(v.id));
}));

app.delete('/api/vendors/:id', asyncRoute((req, res) => {
  getVendor(req.params.id);
  db.prepare('DELETE FROM vendors WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- items ----------

app.post('/api/vendors/:id/items', asyncRoute((req, res) => {
  const vendor = getVendor(req.params.id);
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
  const insert = db.prepare(
    `INSERT INTO items (vendor_id, name, aliases, unit, price_cents, tiers)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(vendor_id, name) DO UPDATE SET
       price_cents = excluded.price_cents,
       aliases = CASE WHEN excluded.aliases != '' THEN excluded.aliases ELSE items.aliases END,
       unit = CASE WHEN excluded.unit != '' THEN excluded.unit ELSE items.unit END`
  );
  let count = 0;
  for (const it of items) {
    const name = String(it.name || '').trim();
    const cents = Math.round(num(it.price_cents, NaN));
    if (!name || !isFinite(cents) || cents < 0) continue;
    insert.run(vendor.id, name, String(it.aliases || '').trim(), String(it.unit || '').trim(), cents, normalizeTiers(it.tiers));
    count++;
  }
  res.json({ ok: true, count, items: vendorItems(vendor.id) });
}));

app.put('/api/items/:id', asyncRoute((req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!item) throw new Error('Item not found');
  db.prepare(
    'UPDATE items SET name = ?, aliases = ?, unit = ?, price_cents = ?, tiers = ? WHERE id = ?'
  ).run(
    String(req.body.name ?? item.name).trim(),
    String(req.body.aliases ?? item.aliases).trim(),
    String(req.body.unit ?? item.unit).trim(),
    Math.round(num(req.body.price_cents, item.price_cents)),
    req.body.tiers === undefined ? item.tiers : normalizeTiers(req.body.tiers),
    item.id
  );
  res.json(db.prepare('SELECT * FROM items WHERE id = ?').get(item.id));
}));

app.delete('/api/items/:id', asyncRoute((req, res) => {
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- import (upload -> candidate rows for review; nothing saved yet) ----------

app.post('/api/import', upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw new Error('No file uploaded');
  const result = await extract(req.file.buffer, req.file.originalname);
  res.json({
    filename: req.file.originalname,
    type: result.type,
    line_count: result.lineCount,
    rows: result.rows,
  });
}));

// ---------- quotes / quick order ----------

app.post('/api/quote', asyncRoute((req, res) => {
  const vendor = getVendor(req.body.vendor_id);
  const quote = buildQuote(vendor, resolveLines(vendor.id, req.body.lines));
  res.json(quote);
}));

// Free-text order ("2 flying dutchman and a fry") -> matched lines + quote for matched part.
app.post('/api/quick-parse', asyncRoute((req, res) => {
  const vendor = getVendor(req.body.vendor_id);
  const items = vendorItems(vendor.id);
  const parsed = parseQuickOrder(req.body.text);
  if (!parsed.length) throw new Error('Could not read any order lines from that text');
  const lines = parsed.map((p) => {
    const m = matchItem(p.query, items);
    return {
      query: p.query,
      qty: p.qty,
      matched: m.best
        ? { item_id: m.best.id, name: m.best.name, score: m.score }
        : null,
      candidates: m.candidates.map((c) => ({ item_id: c.item.id, name: c.item.name, score: c.score })),
    };
  });
  const matchedLines = lines.filter((l) => l.matched);
  const quote = matchedLines.length
    ? buildQuote(vendor, resolveLines(vendor.id, matchedLines.map((l) => ({ item_id: l.matched.item_id, qty: l.qty }))))
    : null;
  res.json({ lines, quote, unmatched: lines.filter((l) => !l.matched).map((l) => l.query) });
}));

// ---------- compare across vendors ----------

app.post('/api/compare', asyncRoute((req, res) => {
  const vendorIds = Array.isArray(req.body.vendor_ids) ? req.body.vendor_ids : [];
  if (!vendorIds.length) throw new Error('Pick at least one vendor to compare');
  const parsed = parseQuickOrder(req.body.text);
  if (!parsed.length) throw new Error('Could not read any order lines from that text');
  const results = vendorIds.map((vid) => {
    const vendor = getVendor(vid);
    const items = vendorItems(vendor.id);
    const matched = [];
    const missing = [];
    for (const p of parsed) {
      const m = matchItem(p.query, items);
      if (m.best) matched.push({ item: m.best, qty: p.qty, query: p.query, score: m.score });
      else missing.push(p.query);
    }
    const quote = matched.length
      ? buildQuote(vendor, matched.map((m) => ({ item: m.item, qty: m.qty })))
      : null;
    return {
      vendor_id: vendor.id,
      vendor_name: vendor.name,
      complete: missing.length === 0 && matched.length === parsed.length,
      missing,
      quote,
    };
  });
  res.json({ requested: parsed, results });
}));

// ---------- orders (history) ----------

app.post('/api/orders', asyncRoute((req, res) => {
  const vendor = getVendor(req.body.vendor_id);
  const quote = buildQuote(vendor, resolveLines(vendor.id, req.body.lines));
  const info = db
    .prepare('INSERT INTO orders (vendor_id, vendor_name, label, quote_json, total_cents) VALUES (?, ?, ?, ?, ?)')
    .run(vendor.id, vendor.name, String(req.body.label || '').trim(), JSON.stringify(quote), quote.total_cents);
  res.json({ ok: true, id: info.lastInsertRowid, quote });
}));

app.get('/api/orders', (req, res) => {
  const rows = db
    .prepare('SELECT id, vendor_id, vendor_name, label, total_cents, created_at FROM orders ORDER BY id DESC')
    .all();
  res.json(rows);
});

app.get('/api/orders/:id', asyncRoute((req, res) => {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) throw new Error('Order not found');
  res.json({ ...row, quote: JSON.parse(row.quote_json), quote_json: undefined });
}));

app.delete('/api/orders/:id', asyncRoute((req, res) => {
  db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// Default bind is localhost-only. Set HOST=0.0.0.0 (as the Docker image does)
// to serve other devices — the app has no login, so only do that on a trusted LAN.
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`Vendor Order Tool running at http://${HOST === '0.0.0.0' ? '<this-machine>' : 'localhost'}:${PORT}`);
  console.log('All data is stored locally in ./data/orders.db');
});

'use strict';
// SQLite storage via Node's built-in node:sqlite (Node >= 22.5, no native deps).
// The database is a single file on disk next to the app: data/orders.db

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'orders.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    tax_rate REAL NOT NULL DEFAULT 0,          -- percent, e.g. 8.25
    shipping_cents INTEGER NOT NULL DEFAULT 0, -- flat shipping/delivery fee
    free_ship_over_cents INTEGER,              -- shipping waived at/above this subtotal (NULL = never)
    min_order_cents INTEGER,                   -- warn if subtotal below this (NULL = none)
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '',          -- comma-separated alternate names
    unit TEXT NOT NULL DEFAULT '',             -- e.g. "each", "vial", "case of 12"
    price_cents INTEGER NOT NULL,
    tiers TEXT NOT NULL DEFAULT '[]',          -- JSON [{min_qty, price_cents}] qty discounts
    UNIQUE (vendor_id, name)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
    vendor_name TEXT NOT NULL,                 -- snapshot, survives vendor deletion
    label TEXT NOT NULL DEFAULT '',
    quote_json TEXT NOT NULL,                  -- full itemized quote snapshot
    total_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = { db };

'use strict';
// Price-sheet extraction. Everything runs locally in code — no AI, no cloud APIs.
//   PDF    -> pdfjs-dist text extraction, lines rebuilt from glyph positions
//   Image  -> tesseract.js OCR (downloads its English data file once, then cached)
//   XLSX/CSV -> SheetJS with name/price column detection
// Output is always candidate rows [{name, price_cents}] for the review grid;
// nothing is saved until the user confirms.

const path = require('node:path');

// Any number token: 1,234 / 1234 / 4.99 / $12 / 12.50. Captures an optional
// leading $ and the numeric value. Used to find the price as the LAST number on
// a line, which handles both "$4.99" menus and "ADIPOTIDE ... 70" price lists
// where prices are bare integers.
const NUM_TOKEN = /(\$)?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?/g;

// Currency/unit words allowed to trail the price without disqualifying the line
// (e.g. "70 USD", "12 each"). Anything else after the price means the number
// isn't a trailing price and the line is skipped.
const TRAIL_OK = /^(?:usd|usdt|usdc|eur|gbp|cad|aud|ea|each|kit|kits|pc|pcs|unit|units|\/\s*kit|per\s+kit)\b[.)/-]*$/i;

// Lines that are never items even if they end in a number.
const SKIP_LINE = /^(?:(?:sub)?total|tax\b|amount\b|balance\b|page\s*\d|shipping\s+fee|eta\b|phone|zip|postal|address|city|state|country|name\s*:|prices?\s+in\b|payment|contact|link\s+to|telegram|list\s+of\s+items)/i;

// Sheets that bundle multiple regions/warehouses in one document (e.g. "USA
// Warehouse Price list", "EU Warehouse Price list") repeat rows with the same
// item name across sections. These have no trailing price so they're already
// skipped as items — this just remembers which section subsequent rows fall
// under, so identically-named items with genuinely different prices per
// section can be told apart instead of one silently overwriting the other.
const SECTION_HEADER = /\bwarehouse\b|\bdomestic\b.*\btablets?\b|\bprice\s*list\s*$/i;

// Prefer explicit spreadsheet headers over content-density guesses. Boolean or
// note columns often contain text in every row and can otherwise outscore a
// legitimate product-name column that has a few blanks.
const NAME_HEADER = /^(?:item(?:\s*name)?|name|product(?:\s*name)?|description|service|title)$/i;
const PRICE_HEADER = /^(?:price|cost|rate|amount|unit\s*price)(?:\s*(?:usd|usdt|usdc|eur|gbp|cad|aud))?(?:\s*[-–—:]?\s*\d+(?:\.\d+)?\s*(?:mg|g|kg|ml|l|oz|lb|pcs?|units?))?$/i;

function toCents(str) {
  const n = parseFloat(String(str).replace(/[$,\s]/g, ''));
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function cleanName(s) {
  return String(s || '')
    .replace(/[.·•_]{2,}/g, ' ')       // dot leaders between name and price
    .replace(/[\-–—]{2,}/g, ' ')        // dash leaders
    .replace(/\s+/g, ' ')
    .replace(/[:;,\s]+$/, '')
    .replace(/[|\t]+$/, '')
    .trim();
}

// Turn raw text lines into candidate {name, price_cents} rows.
// Rule: the price is the LAST number on the line; the name is everything before
// it. A line is only treated as a price row if nothing but optional currency
// words follows that last number — so prose that merely contains a number
// ("...1 kit = 10 vials") is skipped.
function rowsFromLines(lines) {
  const rows = [];
  let section = null;
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    if (SECTION_HEADER.test(line)) {
      section = line;
      continue;
    }
    if (SKIP_LINE.test(line)) continue;

    const matches = [...line.matchAll(NUM_TOKEN)];
    if (!matches.length) continue;
    const last = matches[matches.length - 1];

    // Whatever text comes after the last number must be empty or a unit word.
    const tail = line.slice(last.index + last[0].length).trim();
    if (tail && !TRAIL_OK.test(tail)) continue;

    const value = (last[2] || '') + (last[3] || '');
    const cents = toCents(value);
    if (cents == null || cents === 0) continue;
    if (cents > 100000 * 100) continue; // guard against phone numbers / IDs

    // Name is everything before the price token. If the sheet has no name
    // column and the line is just a number, skip it.
    const name = cleanName(line.slice(0, last.index));
    if (!name || !/[a-z]/i.test(name)) continue;
    if (SKIP_LINE.test(name)) continue;

    rows.push({ name, price_cents: cents, section });
  }
  return dedupeAcrossSections(rows);
}

// Sheets covering multiple regions repeat the same item name once per
// section. If every occurrence agrees on price, keep one row (it's the same
// catalog item). If occurrences DISAGREE on price, keep them all but rename
// each with its section so the vendor's item table never silently drops one
// region's price in favor of another's — collisions become distinct rows
// the user can review instead of a lost value.
function dedupeAcrossSections(rows) {
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  }
  const out = [];
  for (const group of byName.values()) {
    const prices = new Set(group.map((r) => r.price_cents));
    if (prices.size === 1) {
      out.push({ name: group[0].name, price_cents: group[0].price_cents });
    } else {
      group.forEach((r, i) => {
        const tag = r.section ? r.section.replace(/\s*(warehouse\s*)?price\s*list\s*$/i, '').trim() : `variant ${i + 1}`;
        out.push({ name: `${r.name} (${tag})`, price_cents: r.price_cents });
      });
    }
  }
  return out;
}

async function extractPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Group glyph runs into visual lines by their y position, then order by x.
    const byY = new Map();
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3) * 3; // 3pt tolerance
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y).push({ x: it.transform[4], str: it.str });
    }
    const ys = [...byY.keys()].sort((a, b) => b - a); // top of page first
    for (const y of ys) {
      const parts = byY.get(y).sort((a, b) => a.x - b.x).map((r) => r.str);
      lines.push(parts.join(' '));
    }
  }
  await doc.destroy();
  return { rows: rowsFromLines(lines), lineCount: lines.length };
}

async function extractImage(buffer) {
  const { createWorker } = require('tesseract.js');
  const cacheDir = path.join(__dirname, '..', 'data', 'ocr-cache');
  let worker;
  try {
    worker = await createWorker('eng', 1, { cachePath: cacheDir });
  } catch (err) {
    throw new Error(
      'OCR engine could not start. The first image import needs internet access ' +
        'to download the OCR language data (about 11 MB, cached locally afterward). ' +
        `Underlying error: ${err.message}`
    );
  }
  try {
    const { data } = await worker.recognize(buffer);
    const lines = String(data.text || '').split('\n');
    return { rows: rowsFromLines(lines), lineCount: lines.length };
  } finally {
    await worker.terminate();
  }
}

function findHeaderColumns(grid) {
  const limit = Math.min(grid.length, 20);
  let best = null;
  for (let r = 0; r < limit; r++) {
    const nameCols = [];
    const priceCols = [];
    for (let c = 0; c < grid[r].length; c++) {
      const header = String(grid[r][c] == null ? '' : grid[r][c]).replace(/\s+/g, ' ').trim();
      if (NAME_HEADER.test(header)) nameCols.push(c);
      if (PRICE_HEADER.test(header)) priceCols.push(c);
    }
    if (!nameCols.length || !priceCols.length) continue;
    const candidate = { headerRow: r, nameCol: nameCols[0], priceCols };
    if (!best || candidate.priceCols.length > best.priceCols.length) best = candidate;
  }
  return best;
}

function isNumericCell(value) {
  return /^\s*\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\s*$/.test(String(value));
}

function extractSpreadsheet(buffer, filename) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const rows = [];
  let lineCount = 0;
  for (const sheetName of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    lineCount += grid.length;
    if (!grid.length) continue;
    const width = Math.max(...grid.map((r) => r.length));

    const headers = findHeaderColumns(grid);
    let nameCol;
    let priceCols;
    let startRow = 0;

    if (headers) {
      nameCol = headers.nameCol;
      priceCols = headers.priceCols;
      startRow = headers.headerRow + 1;
    } else {
      // Headerless sheets retain the original content-based fallback.
      const priceScore = new Array(width).fill(0);
      const nameScore = new Array(width).fill(0);
      for (const row of grid) {
        for (let c = 0; c < width; c++) {
          const cell = row[c];
          if (cell === '' || cell == null) continue;
          if (typeof cell === 'number' || toCents(String(cell).replace(/^\$\s*/, '')) != null) {
            if (typeof cell === 'number' ? cell > 0 : /\.|\$/.test(String(cell))) priceScore[c]++;
            else priceScore[c] += 0.25; // bare integers are weak evidence
          } else if (String(cell).trim().length > 1) {
            nameScore[c]++;
          }
        }
      }
      const priceCol = priceScore.indexOf(Math.max(...priceScore));
      nameCol = nameScore.indexOf(Math.max(...nameScore));
      if (priceScore[priceCol] === 0 || nameScore[nameCol] === 0 || priceCol === nameCol) continue;
      priceCols = [priceCol];
    }

    for (let r = startRow; r < grid.length; r++) {
      const row = grid[r];
      const nameCell = row[nameCol];
      if (nameCell == null || String(nameCell).trim() === '') continue;
      const name = cleanName(String(nameCell));
      if (!name || isNumericCell(name) || NAME_HEADER.test(name)) continue;

      // Multi-size catalogs can declare several price columns. Use the first
      // populated recognized tier from left to right for the review candidate.
      let cents = null;
      for (const priceCol of priceCols) {
        const priceCell = row[priceCol];
        if (priceCell == null || String(priceCell).trim() === '') continue;
        cents =
          typeof priceCell === 'number'
            ? Math.round(priceCell * 100)
            : toCents(String(priceCell).replace(/^\$\s*/, ''));
        if (cents != null && cents > 0) break;
      }
      if (cents == null || cents <= 0) continue;
      rows.push({ name, price_cents: cents });
    }
  }
  return { rows, lineCount };
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff']);
const SHEET_EXT = new Set(['.xlsx', '.xls', '.xlsm', '.csv', '.tsv', '.ods']);

async function extract(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.pdf') return { type: 'pdf', ...(await extractPdf(buffer)) };
  if (IMAGE_EXT.has(ext)) return { type: 'image', ...(await extractImage(buffer)) };
  if (SHEET_EXT.has(ext)) return { type: 'spreadsheet', ...extractSpreadsheet(buffer, filename) };
  if (ext === '.txt') {
    const lines = buffer.toString('utf8').split('\n');
    return { type: 'text', rows: rowsFromLines(lines), lineCount: lines.length };
  }
  throw new Error(`Unsupported file type "${ext}". Use PDF, an image, XLSX/CSV, or plain text.`);
}

module.exports = { extract, rowsFromLines, toCents };

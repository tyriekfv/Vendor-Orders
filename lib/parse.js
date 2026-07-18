'use strict';
// Price-sheet extraction. Everything runs locally in code — no AI, no cloud APIs.
//   PDF    -> pdfjs-dist text extraction, lines rebuilt from glyph positions
//   Image  -> tesseract.js OCR (downloads its English data file once, then cached)
//   XLSX/CSV -> SheetJS with name/price column detection
// Output is always candidate rows [{name, price_cents}] for the review grid;
// nothing is saved until the user confirms.

const path = require('node:path');

// Matches money like 4.99 / $4.99 / 1,234.50 / $12 — requires either a $ sign
// or a decimal part so bare integers (sizes, counts, years) aren't mistaken for prices.
const PRICE_RE = /(?:\$\s*(\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?)|(\d{1,5}(?:,\d{3})*\.\d{2}))(?!\d)/g;

function toCents(str) {
  const n = parseFloat(String(str).replace(/,/g, ''));
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function cleanName(s) {
  return String(s || '')
    .replace(/[.·•_\-–—]{2,}/g, ' ') // dot leaders between name and price
    .replace(/\s+/g, ' ')
    .replace(/[:;,\s]+$/, '')
    .trim();
}

// Turn raw text lines into candidate {name, price_cents} rows.
// The last price on a line is treated as the item price (menu convention).
function rowsFromLines(lines) {
  const rows = [];
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    const matches = [...line.matchAll(PRICE_RE)];
    if (!matches.length) continue;
    const last = matches[matches.length - 1];
    const cents = toCents(last[1] ?? last[2]);
    if (cents == null || cents === 0) continue;
    const name = cleanName(line.slice(0, matches[0].index));
    if (!name || /^\d+$/.test(name)) continue;
    if (/^(sub)?total|^tax\b|^amount|^page \d/i.test(name)) continue;
    rows.push({ name, price_cents: cents });
  }
  return rows;
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

    // Score each column: prices parse as money, names are non-numeric text.
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
    const nameCol = nameScore.indexOf(Math.max(...nameScore));
    if (priceScore[priceCol] === 0 || nameScore[nameCol] === 0 || priceCol === nameCol) continue;

    for (const row of grid) {
      const nameCell = row[nameCol];
      const priceCell = row[priceCol];
      if (nameCell == null || priceCell == null || String(nameCell).trim() === '') continue;
      const cents =
        typeof priceCell === 'number'
          ? Math.round(priceCell * 100)
          : toCents(String(priceCell).replace(/^\$\s*/, ''));
      if (cents == null || cents <= 0) continue;
      const name = cleanName(String(nameCell));
      if (!name || toCents(name) != null) continue;
      if (/^(item|name|product|description)$/i.test(name)) continue; // header row
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

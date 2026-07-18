# Vendor Order Tool

A local web app for keeping vendor price catalogs and pricing out orders.
Upload a price sheet (PDF, photo/screenshot, Excel/CSV), review what was
extracted, save it as a vendor catalog — then build orders in plain text
("2 flying dutchman and a fry") and get itemized totals with tax, shipping,
and quantity discounts. Compare the same order across vendors and keep a
saved history.

**Privacy:** everything runs on your machine. The server binds to
`localhost` only, all parsing (PDF text extraction, OCR, spreadsheet
reading) is done by local code — no AI models and no cloud services ever
see your data. The database is a single file at `data/orders.db`.

## Requirements

- [Node.js](https://nodejs.org) **22.5 or newer** (uses Node's built-in
  SQLite — no compilers or native modules needed).

## Setup

```bash
git clone https://github.com/tyriekfv/Vendor-Orders.git
cd Vendor-Orders
npm install
npm start
```

Then open **http://localhost:4321** in your browser.

> The only time the app touches the network: the *first* image/photo import
> downloads the OCR engine's English data file (~11 MB) and caches it in
> `data/ocr-cache/`. PDF and spreadsheet imports are fully offline from the
> start.

## How to use it

### 1. Add a vendor
Vendors tab → type a name → **Add vendor**. Open the vendor to set its tax
rate (%), flat shipping fee, free-shipping threshold, minimum order, and
notes.

### 2. Import a price sheet
On the vendor page, choose a file and click **Extract items**:

| Format | How it's read |
|---|---|
| PDF | Text extracted locally with pdf.js, lines rebuilt from glyph positions |
| Photo / screenshot | OCR'd locally with tesseract.js |
| Excel / CSV | Read with SheetJS; name and price columns auto-detected |
| Plain text | One item per line, price at the end |

Extraction is a best guess — you always get a **review grid** to fix names
and prices and untick junk rows before anything is saved. Re-importing a
sheet updates prices for items with the same name (aliases and units you
added are kept).

Secret-menu / off-sheet items (the Flying Dutchmans of the world) are
**never guessed** — add them manually in the items table, and optionally
give them aliases (comma-separated) so the quick-order parser finds them
under other names.

### 3. Per-item quantity discounts
In the items table, the *Qty discounts* column takes tiers like:

```
10+ @ $4.50, 50+ @ $4.00
```

Order 50 or more and the unit price drops to $4.00 automatically, with the
applied tier shown on the quote.

### 4. Build an order
New Order tab → pick the vendor → type the order in plain text:

```
2 flying dutchman and a fry
```

The parser understands `2 x item`, `item x2`, "a"/"two"/"dozen", commas,
"and", "+", and newlines. Items are fuzzy-matched against names *and
aliases* (typos and word order are tolerated), and each match shows its
confidence. Anything unmatched is flagged — it will never silently guess a
price. You can also add lines manually from a dropdown, edit quantities,
and remove lines. The quote shows qty × unit price per line, subtotal, tax,
shipping (waived above the vendor's threshold), a minimum-order warning if
you're short, and the total. **Save order** stores it in history.

### 5. Compare vendors
Compare tab → type the order once, tick the vendors → **Compare**. You get
per-vendor totals with the cheapest complete quote highlighted. Vendors
missing some items are marked *(partial)* so you're never comparing
apples to a vendor that doesn't sell apples.

### 6. History
Every saved order keeps a full snapshot (it survives later price changes or
vendor deletion). **Details** shows the itemization, **Re-run** reloads the
lines into New Order at *current* prices, **✕** deletes it.

## Backup / moving machines

Copy the `data/` folder. That's the entire state.

## Configuration

- `PORT=5000 npm start` to use a different port.
- The server intentionally binds to `127.0.0.1`. If you want to reach it
  from another device on your network, change the `app.listen` host in
  `server.js` — but understand that removes the localhost-only protection.

'use strict';
/* Vendor Order Tool frontend — vanilla JS, talks only to the local server. */

// ---------- utilities ----------

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const fmt = (cents) => '$' + (cents / 100).toFixed(2);
const toCents = (dollars) => {
  const n = parseFloat(String(dollars).replace(/[$,\s]/g, ''));
  return isFinite(n) ? Math.round(n * 100) : null;
};

let toastTimer;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3200);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body instanceof FormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function modal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal">${html}</div></div>`;
  $('.overlay', root).addEventListener('click', (e) => {
    if (e.target.classList.contains('overlay')) closeModal();
  });
  return $('.modal', root);
}
function closeModal() { $('#modal-root').innerHTML = ''; }

// ---------- state ----------

const state = {
  vendors: [],
  selectedVendorId: null, // vendors tab detail view
  order: { vendorId: null, lines: [] }, // lines: [{item_id, qty}]
  orderQuote: null,
  quickResult: null,
};

async function loadVendors() {
  state.vendors = await api('/vendors');
}

// ---------- tabs ----------

$$('.tab').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.panel').forEach((p) => p.classList.add('hidden'));
    $('#tab-' + btn.dataset.tab).classList.remove('hidden');
    render(btn.dataset.tab);
  })
);

function activeTab() {
  return $('.tab.active').dataset.tab;
}

async function render(tab = activeTab()) {
  await loadVendors();
  if (tab === 'vendors') renderVendors();
  if (tab === 'order') renderOrder();
  if (tab === 'compare') renderCompare();
  if (tab === 'history') renderHistory();
}

// ---------- vendors tab ----------

function renderVendors() {
  const el = $('#tab-vendors');
  if (state.selectedVendorId) return renderVendorDetail(el);
  el.innerHTML = `
    <h2>Vendors</h2>
    <div class="card">
      <div class="row">
        <input id="new-vendor-name" class="grow" placeholder="New vendor name (e.g. In-N-Out)" />
        <button class="primary" id="btn-add-vendor">Add vendor</button>
      </div>
    </div>
    <div id="vendor-list">
      ${state.vendors.length ? '' : '<p class="muted">No vendors yet. Add one above, then open it to import a price sheet or add items.</p>'}
      ${state.vendors.map((v) => `
        <div class="card vendor-card" data-id="${v.id}">
          <div class="row">
            <strong>${esc(v.name)}</strong>
            <span class="pill">${v.item_count} item${v.item_count === 1 ? '' : 's'}</span>
          </div>
          <div class="meta">
            tax ${v.tax_rate}% &middot; shipping ${fmt(v.shipping_cents)}${v.free_ship_over_cents != null ? ` (free over ${fmt(v.free_ship_over_cents)})` : ''}${v.min_order_cents != null ? ` &middot; min order ${fmt(v.min_order_cents)}` : ''}
          </div>
        </div>`).join('')}
    </div>`;

  $('#btn-add-vendor').onclick = async () => {
    const name = $('#new-vendor-name').value.trim();
    if (!name) return toast('Enter a vendor name', true);
    try {
      const v = await api('/vendors', { method: 'POST', body: { name } });
      state.selectedVendorId = v.id;
      render();
    } catch (e) { toast(e.message, true); }
  };
  $$('.vendor-card').forEach((card) =>
    card.addEventListener('click', () => {
      state.selectedVendorId = Number(card.dataset.id);
      render();
    })
  );
}

async function renderVendorDetail(el) {
  let v;
  try {
    v = await api('/vendors/' + state.selectedVendorId);
  } catch {
    state.selectedVendorId = null;
    return renderVendors();
  }
  el.innerHTML = `
    <div class="row">
      <button id="btn-back">&larr; All vendors</button>
      <h2 style="margin:0">${esc(v.name)}</h2>
      <span class="grow"></span>
      <button class="danger" id="btn-del-vendor">Delete vendor</button>
    </div>

    <h3>Vendor settings</h3>
    <div class="card">
      <div class="row top">
        <label class="field">Name<input id="v-name" value="${esc(v.name)}" /></label>
        <label class="field">Tax rate %<input id="v-tax" class="num" value="${v.tax_rate}" /></label>
        <label class="field">Shipping $<input id="v-ship" class="num" value="${(v.shipping_cents / 100).toFixed(2)}" /></label>
        <label class="field">Free ship over $<input id="v-freeship" class="num" value="${v.free_ship_over_cents != null ? (v.free_ship_over_cents / 100).toFixed(2) : ''}" placeholder="—" /></label>
        <label class="field">Min order $<input id="v-min" class="num" value="${v.min_order_cents != null ? (v.min_order_cents / 100).toFixed(2) : ''}" placeholder="—" /></label>
      </div>
      <div class="row top" style="margin-top:10px">
        <label class="field grow">Notes<textarea id="v-notes" rows="2">${esc(v.notes)}</textarea></label>
        <button class="primary" id="btn-save-vendor">Save settings</button>
      </div>
    </div>

    <h3>Import price sheet</h3>
    <div class="card">
      <div class="row">
        <input type="file" id="import-file" accept=".pdf,.png,.jpg,.jpeg,.webp,.bmp,.gif,.tif,.tiff,.xlsx,.xls,.xlsm,.csv,.tsv,.ods,.txt" />
        <button class="primary" id="btn-import">Extract items</button>
        <span class="muted small-text">PDF, photo/screenshot, Excel/CSV, or text. You review everything before it's saved.</span>
      </div>
      <div id="import-status"></div>
    </div>

    <h3>Items (${v.items.length})</h3>
    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <input id="i-name" class="grow" placeholder="Item name" />
        <input id="i-aliases" placeholder="Aliases (comma-sep)" />
        <input id="i-unit" placeholder="Unit" style="width:100px" />
        <input id="i-price" class="num" placeholder="Price $" />
        <button class="primary" id="btn-add-item">Add item</button>
      </div>
      ${v.items.length ? `
      <table>
        <thead><tr><th>Name</th><th>Aliases</th><th>Unit</th><th class="num">Price</th><th>Qty discounts</th><th></th></tr></thead>
        <tbody>
          ${v.items.map((it) => {
            const tiers = JSON.parse(it.tiers || '[]');
            const tierStr = tiers.map((t) => `${t.min_qty}+ @ $${(t.price_cents / 100).toFixed(2)}`).join(', ');
            return `<tr data-id="${it.id}">
              <td><input class="e-name" value="${esc(it.name)}" /></td>
              <td><input class="e-aliases" value="${esc(it.aliases)}" /></td>
              <td><input class="e-unit" value="${esc(it.unit)}" style="width:90px" /></td>
              <td class="num"><input class="e-price num" value="${(it.price_cents / 100).toFixed(2)}" /></td>
              <td><input class="e-tiers" value="${esc(tierStr)}" placeholder="e.g. 10+ @ $4.50, 50+ @ $4.00" /></td>
              <td class="num">
                <button class="small e-save">Save</button>
                <button class="small danger e-del">✕</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : '<p class="muted">No items yet — import a price sheet above or add items manually.</p>'}
    </div>`;

  $('#btn-back').onclick = () => { state.selectedVendorId = null; render(); };

  $('#btn-del-vendor').onclick = async () => {
    if (!confirm(`Delete vendor "${v.name}" and all its items? Saved order history is kept.`)) return;
    await api('/vendors/' + v.id, { method: 'DELETE' });
    state.selectedVendorId = null;
    toast('Vendor deleted');
    render();
  };

  $('#btn-save-vendor').onclick = async () => {
    try {
      await api('/vendors/' + v.id, {
        method: 'PUT',
        body: {
          name: $('#v-name').value,
          tax_rate: parseFloat($('#v-tax').value) || 0,
          shipping: parseFloat($('#v-ship').value) || 0,
          free_ship_over: $('#v-freeship').value.trim() === '' ? null : parseFloat($('#v-freeship').value),
          min_order: $('#v-min').value.trim() === '' ? null : parseFloat($('#v-min').value),
          notes: $('#v-notes').value,
        },
      });
      toast('Vendor settings saved');
      render();
    } catch (e) { toast(e.message, true); }
  };

  $('#btn-import').onclick = async () => {
    const file = $('#import-file').files[0];
    if (!file) return toast('Choose a file first', true);
    $('#import-status').innerHTML = '<p class="muted">Extracting… (photos take longer — OCR runs locally)</p>';
    const fd = new FormData();
    fd.append('file', file);
    try {
      const result = await api('/import', { method: 'POST', body: fd });
      $('#import-status').innerHTML = '';
      openReviewGrid(v, result);
    } catch (e) {
      $('#import-status').innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  };

  $('#btn-add-item').onclick = async () => {
    const name = $('#i-name').value.trim();
    const cents = toCents($('#i-price').value);
    if (!name || cents == null) return toast('Item needs a name and a price', true);
    try {
      await api(`/vendors/${v.id}/items`, {
        method: 'POST',
        body: { items: [{ name, aliases: $('#i-aliases').value, unit: $('#i-unit').value, price_cents: cents }] },
      });
      toast('Item added');
      render();
    } catch (e) { toast(e.message, true); }
  };

  $$('#tab-vendors tbody tr').forEach((tr) => {
    const id = tr.dataset.id;
    $('.e-save', tr).onclick = async () => {
      const cents = toCents($('.e-price', tr).value);
      if (cents == null) return toast('Bad price', true);
      const tiers = parseTierString($('.e-tiers', tr).value);
      if (tiers === null) return toast('Could not read qty discounts — use e.g. "10+ @ $4.50, 50+ @ $4.00"', true);
      try {
        await api('/items/' + id, {
          method: 'PUT',
          body: {
            name: $('.e-name', tr).value,
            aliases: $('.e-aliases', tr).value,
            unit: $('.e-unit', tr).value,
            price_cents: cents,
            tiers,
          },
        });
        toast('Item saved');
      } catch (e) { toast(e.message, true); }
    };
    $('.e-del', tr).onclick = async () => {
      await api('/items/' + id, { method: 'DELETE' });
      render();
    };
  });
}

// "10+ @ $4.50, 50+ @ $4.00" -> [{min_qty, price_cents}]; '' -> []; unparseable -> null
function parseTierString(s) {
  const txt = String(s || '').trim();
  if (!txt) return [];
  const tiers = [];
  for (const part of txt.split(',')) {
    const m = part.trim().match(/^(\d+)\s*\+?\s*(?:@|at|=)?\s*\$?\s*([\d.]+)$/i);
    if (!m) return null;
    tiers.push({ min_qty: parseInt(m[1], 10), price_cents: toCents(m[2]) });
  }
  return tiers;
}

function openReviewGrid(vendor, result) {
  const rows = result.rows;
  const m = modal(`
    <h2>Review extracted items — ${esc(result.filename)}</h2>
    <p class="muted small-text">
      Found ${rows.length} candidate item${rows.length === 1 ? '' : 's'} across ${result.line_count} lines
      (${esc(result.type)}). Fix names/prices, untick anything wrong, then save.
      ${rows.length === 0 ? '<br><strong>Nothing was auto-detected</strong> — the sheet may be unusually formatted. You can still add items manually on the vendor page.' : ''}
    </p>
    ${rows.length ? `
    <table class="review-grid">
      <thead><tr><th><input type="checkbox" id="rg-all" checked /></th><th>Item name</th><th class="num">Price $</th></tr></thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr>
            <td><input type="checkbox" class="rg-keep" data-i="${i}" checked /></td>
            <td><input class="rg-name" data-i="${i}" value="${esc(r.name)}" /></td>
            <td class="price-cell"><input class="rg-price" data-i="${i}" value="${(r.price_cents / 100).toFixed(2)}" /></td>
          </tr>`).join('')}
      </tbody>
    </table>` : ''}
    <div class="row" style="margin-top:14px">
      <span class="grow"></span>
      <button id="rg-cancel">Cancel</button>
      ${rows.length ? '<button class="primary" id="rg-save">Save to vendor</button>' : ''}
    </div>`);

  $('#rg-cancel', m).onclick = closeModal;
  const all = $('#rg-all', m);
  if (all) all.onchange = () => $$('.rg-keep', m).forEach((cb) => (cb.checked = all.checked));
  const saveBtn = $('#rg-save', m);
  if (saveBtn) saveBtn.onclick = async () => {
    const items = [];
    for (const cb of $$('.rg-keep', m)) {
      if (!cb.checked) continue;
      const i = cb.dataset.i;
      const name = $(`.rg-name[data-i="${i}"]`, m).value.trim();
      const cents = toCents($(`.rg-price[data-i="${i}"]`, m).value);
      if (name && cents != null) items.push({ name, price_cents: cents });
    }
    if (!items.length) return toast('Nothing selected', true);
    try {
      const res = await api(`/vendors/${vendor.id}/items`, { method: 'POST', body: { items } });
      closeModal();
      toast(`Saved ${res.count} items to ${vendor.name}`);
      render();
    } catch (e) { toast(e.message, true); }
  };
}

// ---------- new order tab ----------

function renderOrder() {
  const el = $('#tab-order');
  const vendorOpts = state.vendors
    .map((v) => `<option value="${v.id}" ${state.order.vendorId === v.id ? 'selected' : ''}>${esc(v.name)}</option>`)
    .join('');
  el.innerHTML = `
    <h2>New Order</h2>
    <div class="card">
      <div class="row">
        <label class="field">Vendor
          <select id="o-vendor"><option value="">— pick a vendor —</option>${vendorOpts}</select>
        </label>
      </div>
    </div>
    <div id="o-body"></div>`;

  $('#o-vendor').onchange = () => {
    const id = Number($('#o-vendor').value) || null;
    state.order = { vendorId: id, lines: [] };
    state.orderQuote = null;
    state.quickResult = null;
    renderOrderBody();
  };
  renderOrderBody();
}

async function renderOrderBody() {
  const el = $('#o-body');
  if (!state.order.vendorId) {
    el.innerHTML = '<p class="muted">Pick a vendor to start an order.</p>';
    return;
  }
  const v = await api('/vendors/' + state.order.vendorId);
  const qr = state.quickResult;
  el.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">Quick order</h3>
      <textarea id="qo-text" class="quick" placeholder="e.g. 2 flying dutchman and a fry"></textarea>
      <div class="row" style="margin-top:8px">
        <button class="primary" id="btn-qo">Parse &amp; price it</button>
        <span class="muted small-text">Matched by name against ${esc(v.name)}'s ${v.items.length} items — fuzzy, handles typos and aliases.</span>
      </div>
      <div id="qo-result">
        ${qr ? qr.lines.map((l) => `
          <div class="match-line">
            <span class="q">${l.qty} × “${esc(l.query)}”</span>
            ${l.matched
              ? `<span class="pill ${l.matched.score >= 85 ? 'good' : 'warn'}">→ ${esc(l.matched.name)} (${l.matched.score}%)</span>`
              : `<span class="pill bad">no match — add it to the vendor's items first</span>`}
          </div>`).join('') : ''}
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Order lines</h3>
      <div class="row" style="margin-bottom:10px">
        <select id="ol-item" class="grow">
          <option value="">— add item manually —</option>
          ${v.items.map((it) => `<option value="${it.id}">${esc(it.name)} — ${fmt(it.price_cents)}${it.unit ? ' / ' + esc(it.unit) : ''}</option>`).join('')}
        </select>
        <input id="ol-qty" class="qty" type="number" min="1" value="1" />
        <button id="btn-ol-add">Add line</button>
      </div>
      <div id="quote-area"></div>
    </div>`;

  $('#btn-qo').onclick = async () => {
    const text = $('#qo-text').value.trim();
    if (!text) return toast('Type an order first', true);
    try {
      const res = await api('/quick-parse', { method: 'POST', body: { vendor_id: v.id, text } });
      state.quickResult = res;
      // merge matched lines into the order draft
      for (const l of res.lines) {
        if (!l.matched) continue;
        const existing = state.order.lines.find((x) => x.item_id === l.matched.item_id);
        if (existing) existing.qty += l.qty;
        else state.order.lines.push({ item_id: l.matched.item_id, qty: l.qty });
      }
      await refreshQuote();
      renderOrderBody();
    } catch (e) { toast(e.message, true); }
  };

  $('#btn-ol-add').onclick = async () => {
    const itemId = Number($('#ol-item').value);
    const qty = Math.max(1, parseInt($('#ol-qty').value, 10) || 1);
    if (!itemId) return toast('Pick an item', true);
    const existing = state.order.lines.find((x) => x.item_id === itemId);
    if (existing) existing.qty += qty;
    else state.order.lines.push({ item_id: itemId, qty });
    await refreshQuote();
    renderOrderBody();
  };

  renderQuoteArea();
}

async function refreshQuote() {
  if (!state.order.lines.length) { state.orderQuote = null; return; }
  state.orderQuote = await api('/quote', {
    method: 'POST',
    body: { vendor_id: state.order.vendorId, lines: state.order.lines },
  });
}

function renderQuoteArea() {
  const el = $('#quote-area');
  const q = state.orderQuote;
  if (!q) {
    el.innerHTML = '<p class="muted">No lines yet — use quick order above or add items manually.</p>';
    return;
  }
  el.innerHTML = `
    ${quoteTable(q, true)}
    ${q.warnings.map((w) => `<p class="warning">⚠ ${esc(w)}</p>`).join('')}
    <div class="row" style="margin-top:12px">
      <input id="order-label" class="grow" placeholder="Label for history (optional, e.g. 'weekly restock')" />
      <button class="primary" id="btn-save-order">Save order</button>
      <button id="btn-clear-order">Clear</button>
    </div>`;

  $$('#quote-area .ql-del').forEach((btn) => (btn.onclick = async () => {
    state.order.lines = state.order.lines.filter((l) => l.item_id !== Number(btn.dataset.id));
    await refreshQuote();
    renderOrderBody();
  }));
  $$('#quote-area .ql-qty').forEach((inp) => (inp.onchange = async () => {
    const line = state.order.lines.find((l) => l.item_id === Number(inp.dataset.id));
    if (line) line.qty = Math.max(1, parseInt(inp.value, 10) || 1);
    await refreshQuote();
    renderOrderBody();
  }));
  $('#btn-clear-order').onclick = () => {
    state.order.lines = [];
    state.orderQuote = null;
    state.quickResult = null;
    renderOrderBody();
  };
  $('#btn-save-order').onclick = async () => {
    try {
      await api('/orders', {
        method: 'POST',
        body: { vendor_id: state.order.vendorId, lines: state.order.lines, label: $('#order-label').value },
      });
      toast('Order saved to history');
    } catch (e) { toast(e.message, true); }
  };
}

function quoteTable(q, editable = false) {
  return `
  <table>
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Line total</th>${editable ? '<th></th>' : ''}</tr></thead>
    <tbody>
      ${q.lines.map((l) => `
        <tr>
          <td>${esc(l.name)}${l.unit ? ` <span class="muted small-text">/ ${esc(l.unit)}</span>` : ''}
            ${l.tier_applied ? `<span class="pill good">qty discount: ${l.tier_applied.min_qty}+ @ ${fmt(l.tier_applied.price_cents)}</span>` : ''}
          </td>
          <td class="num">${editable ? `<input class="qty ql-qty" data-id="${l.item_id}" type="number" min="1" value="${l.qty}" />` : l.qty}</td>
          <td class="num">${fmt(l.unit_price_cents)}</td>
          <td class="num">${fmt(l.line_total_cents)}</td>
          ${editable ? `<td class="num"><button class="small danger ql-del" data-id="${l.item_id}">✕</button></td>` : ''}
        </tr>`).join('')}
      <tr><td colspan="${editable ? 3 : 2}"></td><td class="num muted">Subtotal</td></tr>
      <tr><td colspan="${editable ? 3 : 2}" class="muted small-text">tax ${q.tax_rate}%${q.shipping_waived ? ' · shipping waived' : ''}</td><td class="num">${fmt(q.subtotal_cents)}</td></tr>
      <tr><td colspan="${editable ? 3 : 2}"></td><td class="num muted">Tax ${fmt(q.tax_cents)} · Ship ${fmt(q.shipping_cents)}</td></tr>
      <tr class="total-row"><td colspan="${editable ? 3 : 2}">Total</td><td class="num" colspan="2">${fmt(q.total_cents)}</td></tr>
    </tbody>
  </table>`;
}

// ---------- compare tab ----------

function renderCompare() {
  const el = $('#tab-compare');
  el.innerHTML = `
    <h2>Compare vendors</h2>
    <div class="card">
      <textarea id="cmp-text" class="quick" placeholder="e.g. 2 flying dutchman, 1 fry"></textarea>
      <div class="row" style="margin-top:10px">
        ${state.vendors.map((v) => `
          <label class="pill" style="cursor:pointer">
            <input type="checkbox" class="cmp-v" value="${v.id}" checked /> ${esc(v.name)}
          </label>`).join('') || '<span class="muted">No vendors yet.</span>'}
        <span class="grow"></span>
        <button class="primary" id="btn-compare">Compare</button>
      </div>
    </div>
    <div id="cmp-result"></div>`;

  $('#btn-compare').onclick = async () => {
    const text = $('#cmp-text').value.trim();
    const ids = $$('.cmp-v').filter((c) => c.checked).map((c) => Number(c.value));
    if (!text) return toast('Type the order to compare', true);
    if (!ids.length) return toast('Pick at least one vendor', true);
    try {
      const res = await api('/compare', { method: 'POST', body: { text, vendor_ids: ids } });
      const priced = res.results.filter((r) => r.quote);
      const best = priced.filter((r) => r.complete).sort((a, b) => a.quote.total_cents - b.quote.total_cents)[0];
      $('#cmp-result').innerHTML = `
        <div class="card">
          <table>
            <thead><tr><th>Vendor</th><th>Coverage</th><th class="num">Subtotal</th><th class="num">Tax</th><th class="num">Shipping</th><th class="num">Total</th></tr></thead>
            <tbody>
              ${res.results.map((r) => `
                <tr class="${best && r.vendor_id === best.vendor_id ? 'cheapest' : ''}">
                  <td>${esc(r.vendor_name)} ${best && r.vendor_id === best.vendor_id ? '<span class="pill good">cheapest</span>' : ''}</td>
                  <td>${r.complete
                    ? '<span class="pill good">all items</span>'
                    : `<span class="pill bad">missing: ${esc(r.missing.join(', ')) || 'all'}</span>`}</td>
                  ${r.quote
                    ? `<td class="num">${fmt(r.quote.subtotal_cents)}</td><td class="num">${fmt(r.quote.tax_cents)}</td><td class="num">${fmt(r.quote.shipping_cents)}</td><td class="num"><strong>${fmt(r.quote.total_cents)}</strong>${r.complete ? '' : '<span class="muted small-text"> (partial)</span>'}</td>`
                    : '<td class="num" colspan="4"><span class="muted">no matching items</span></td>'}
                </tr>`).join('')}
            </tbody>
          </table>
          <p class="muted small-text" style="margin-bottom:0">
            Requested: ${res.requested.map((p) => `${p.qty} × ${esc(p.query)}`).join(', ')}.
            Totals marked (partial) exclude missing items — add those items to that vendor for a true comparison.
          </p>
        </div>`;
    } catch (e) { toast(e.message, true); }
  };
}

// ---------- history tab ----------

async function renderHistory() {
  const el = $('#tab-history');
  const orders = await api('/orders');
  el.innerHTML = `
    <h2>Order history</h2>
    ${orders.length ? '' : '<p class="muted">No saved orders yet. Build one in the New Order tab and hit “Save order”.</p>'}
    ${orders.map((o) => `
      <div class="card" data-id="${o.id}">
        <div class="row">
          <strong>#${o.id}</strong>
          <span>${esc(o.vendor_name)}</span>
          ${o.label ? `<span class="pill">${esc(o.label)}</span>` : ''}
          <span class="muted small-text">${esc(o.created_at)} UTC</span>
          <span class="grow"></span>
          <strong>${fmt(o.total_cents)}</strong>
          <button class="small h-view">Details</button>
          <button class="small h-rerun" ${o.vendor_id ? '' : 'disabled title="Vendor was deleted"'}>Re-run</button>
          <button class="small danger h-del">✕</button>
        </div>
        <div class="h-detail"></div>
      </div>`).join('')}`;

  $$('#tab-history .card').forEach((card) => {
    const id = Number(card.dataset.id);
    $('.h-view', card).onclick = async () => {
      const detail = $('.h-detail', card);
      if (detail.innerHTML) { detail.innerHTML = ''; return; }
      const o = await api('/orders/' + id);
      detail.innerHTML = `<div style="margin-top:12px">${quoteTable(o.quote)}</div>`;
    };
    $('.h-rerun', card).onclick = async () => {
      const o = await api('/orders/' + id);
      state.order = {
        vendorId: o.vendor_id,
        lines: o.quote.lines.map((l) => ({ item_id: l.item_id, qty: l.qty })),
      };
      state.quickResult = null;
      try {
        await refreshQuote();
      } catch (e) {
        return toast('Could not re-run: ' + e.message, true);
      }
      $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'order'));
      $$('.panel').forEach((p) => p.classList.add('hidden'));
      $('#tab-order').classList.remove('hidden');
      renderOrder();
      toast('Order loaded — prices recalculated at current catalog prices');
    };
    $('.h-del', card).onclick = async () => {
      await api('/orders/' + id, { method: 'DELETE' });
      renderHistory();
    };
  });
}

// ---------- boot ----------

render('vendors');

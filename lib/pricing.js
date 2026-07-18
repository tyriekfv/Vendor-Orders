'use strict';
// Quote computation: tier pricing, tax, shipping, minimum-order checks.
// All money is integer cents.

function unitPriceCents(item, qty) {
  let price = item.price_cents;
  let tierApplied = null;
  let tiers = [];
  try { tiers = JSON.parse(item.tiers || '[]'); } catch { tiers = []; }
  for (const t of tiers.sort((a, b) => a.min_qty - b.min_qty)) {
    if (qty >= t.min_qty) {
      price = t.price_cents;
      tierApplied = t;
    }
  }
  return { price, tierApplied };
}

// lines: [{item, qty}] where item is a row from the items table.
function buildQuote(vendor, lines) {
  const outLines = [];
  let subtotal = 0;
  for (const { item, qty } of lines) {
    const { price, tierApplied } = unitPriceCents(item, qty);
    const lineTotal = price * qty;
    subtotal += lineTotal;
    outLines.push({
      item_id: item.id,
      name: item.name,
      unit: item.unit || '',
      qty,
      base_price_cents: item.price_cents,
      unit_price_cents: price,
      tier_applied: tierApplied,
      line_total_cents: lineTotal,
    });
  }
  const taxRate = vendor.tax_rate || 0;
  const tax = Math.round(subtotal * (taxRate / 100));
  let shipping = vendor.shipping_cents || 0;
  let shippingWaived = false;
  if (shipping && vendor.free_ship_over_cents != null && subtotal >= vendor.free_ship_over_cents) {
    shipping = 0;
    shippingWaived = true;
  }
  const warnings = [];
  if (vendor.min_order_cents != null && subtotal < vendor.min_order_cents) {
    warnings.push(
      `Subtotal is below this vendor's minimum order of $${(vendor.min_order_cents / 100).toFixed(2)}.`
    );
  }
  return {
    vendor_id: vendor.id,
    vendor_name: vendor.name,
    lines: outLines,
    subtotal_cents: subtotal,
    tax_rate: taxRate,
    tax_cents: tax,
    shipping_cents: shipping,
    shipping_waived: shippingWaived,
    total_cents: subtotal + tax + shipping,
    warnings,
  };
}

module.exports = { buildQuote, unitPriceCents };

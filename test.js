'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const coupons = require('./lib/coupons');
const inventory = require('./lib/inventory');
const invoice = require('./lib/invoice');
const pricing = require('./lib/pricing');
const tax = require('./lib/tax');

function mixedCart() {
  // Checkout snapshots HSN and price but does not copy an explicit GST rate.
  return [
    { id: 1, name: 'Rice', hsn: '1006', price: 300, qty: 2 },
    { id: 2, name: 'Tea', hsn: '0902', price: 400, qty: 1 }
  ];
}

test('checkout apportions the coupon before calculating GST per line', () => {
  const totals = pricing.computeTotals(mixedCart(), 'SAVE10');
  assert.deepEqual(totals, {
    subtotal: 1000,
    discount: 100,
    taxable: 900,
    tax: 91.8,
    cgst: 45.9,
    sgst: 45.9,
    total: 991.8,
    lines: [
      { id: 1, name: 'Rice', hsn: '1006', gstPercent: 5, gross: 600,
        discount: 60, taxable: 540, tax: 27, net: 567 },
      { id: 2, name: 'Tea', hsn: '0902', gstPercent: 18, gross: 400,
        discount: 40, taxable: 360, tax: 64.8, net: 424.8 }
    ]
  });
});

test('invoice uses an explicit GST percentage on a sale without a coupon', () => {
  const figures = invoice.computeInvoiceFigures({
    items: [{ name: 'Rice', sku: 'RICE', hsn: '1006', price: 100, qty: 2, gstRate: 5 }]
  });
  assert.deepEqual(figures, {
    subtotal: 200,
    discount: 0,
    tax: 10,
    cgst: 5,
    sgst: 5,
    total: 210,
    rows: [{ name: 'Rice', sku: 'RICE', hsn: '1006', qty: 2, price: 100,
      gstPercent: 5, line: 200, lineTax: 10 }]
  });
});

test('legacy invoice uses fallback GST and discounts the tax-inclusive amount', () => {
  const items = mixedCart();
  const checkout = pricing.computeTotals(items, 'SAVE10');
  const figures = invoice.computeInvoiceFigures({ items, coupon: 'SAVE10' });
  assert.deepEqual(figures.rows.map(row => row.gstPercent), [18, 18]);
  assert.equal(figures.tax, 180);
  assert.equal(figures.discount, 118);
  assert.equal(figures.total, 1062);
  assert.equal(checkout.total, 991.8);
});

test('GST resolves configured HSN slabs and defaults for missing or unknown HSN', () => {
  assert.equal(tax.getRateForItem({ hsn: '1006' }), 0.05);
  assert.equal(tax.getRateForItem({ hsn: '0405' }), 0.12);
  assert.equal(tax.getRateForItem({ hsn: '0902' }), 0.18);
  assert.equal(tax.getRateForItem({ hsn: '9999' }), 0.18);
  assert.equal(tax.getRateForItem({}), 0.18);
});

test('explicit GST overrides HSN and accepts percentages or decimal rates', () => {
  assert.equal(tax.getRateForItem({ hsn: '1006', gstRate: 12 }), 0.12);
  assert.equal(tax.getRateForItem({ hsn: '1006', gstRate: 0.12 }), 0.12);
  assert.equal(tax.getRateForItem({ hsn: '1006', gstRate: 0 }), 0);
});

test('CGST and SGST preserve an odd paisa after rounding', () => {
  assert.deepEqual(tax.splitCgstSgst(0.05), { cgst: 0.03, sgst: 0.02 });
});

test('coupons normalize codes, enforce minimums, and cap percentage discounts', () => {
  const accepted = coupons.validate(' save10 ', 500);
  assert.equal(accepted.valid, true);
  assert.equal(accepted.code, 'SAVE10');
  assert.equal(accepted.discount, 50);
  assert.equal(coupons.validate('SAVE10', 499.99).valid, false);
  assert.equal(coupons.calculateDiscount(499.99, 'SAVE10'), 0);
  assert.equal(coupons.calculateDiscount(2000, 'SAVE10'), 150);
  assert.equal(coupons.calculateDiscount(300, 'FLAT50'), 50);
});

test('unknown and expired coupons are rejected and produce no discount', () => {
  assert.deepEqual(coupons.validate('UNKNOWN', 2000), {
    valid: false, error: 'Invalid coupon code: UNKNOWN'
  });
  assert.deepEqual(coupons.validate('DIWALI20', 2000), {
    valid: false, error: 'Coupon DIWALI20 has expired'
  });
  assert.equal(coupons.calculateDiscount(2000, 'UNKNOWN'), 0);
  assert.equal(coupons.calculateDiscount(2000, 'DIWALI20'), 0);
});

test('a zero-quantity line contributes no money or stock movement in the helpers', () => {
  // This calls the helpers directly. The order route coerces zero to one.
  const items = [{ id: 1, name: 'Rice', hsn: '1006', price: 300, qty: 0 }];
  const products = [{ id: 1, name: 'Rice', stock: 10, reserved: 2 }];
  const totals = pricing.computeTotals(items, '');
  assert.equal(totals.subtotal, 0);
  assert.equal(totals.tax, 0);
  assert.equal(totals.total, 0);
  assert.equal(invoice.computeInvoiceFigures({ items }).total, 0);
  assert.deepEqual(inventory.check(products, items), { ok: true });
  inventory.reserve(products, items);
  assert.equal(products[0].stock, 10);
});

test('a valid reservation deducts physical stock while preserving held units', () => {
  const products = [{ id: 1, name: 'Rice', stock: 10, reserved: 3 }];
  const items = [{ id: 1, qty: 4 }];
  assert.equal(inventory.getSellableStock(products[0]), 7);
  assert.deepEqual(inventory.check(products, items), { ok: true });
  assert.equal(products[0].stock, 10);
  inventory.reserve(products, items);
  assert.equal(products[0].stock, 6);
  assert.equal(products[0].reserved, 3);
  assert.equal(inventory.getSellableStock(products[0]), 3);
});

test('stock check rejects requests above or exactly at the sellable quantity', () => {
  const products = [{ id: 1, name: 'Rice', stock: 10, reserved: 3 }];
  const rejection = { ok: false, msg: 'Rice is out of stock (7 sellable available)' };
  assert.deepEqual(inventory.check(products, [{ id: 1, qty: 8 }]), rejection);
  // The current comparison also rejects buying the last sellable unit.
  assert.deepEqual(inventory.check(products, [{ id: 1, qty: 7 }]), rejection);
  assert.equal(products[0].stock, 10);
});

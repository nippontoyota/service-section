// Run after npm test against a local demo server; uses synthetic bills only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fixtureSnapshot } = require('/tmp/cashier-bill-tests/test-fixtures.js');
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ? process.env.PLAYWRIGHT_PATH + '/index.mjs' : 'playwright');
const base = process.env.DESK_URL || 'http://localhost:3120';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const data = fixtureSnapshot();
data.payments = [];
const original = data.bills[0];
data.bills = [606400, 155300, 100000, 50000, null].map((amount, i) => ({
  ...structuredClone(original), id: 'selection-' + i, invoice_reference: 'SELECT-' + i,
  amount_paise: amount, vehicle_no_display: 'KL07AB' + (1000 + i),
  approval_status: 'pending', approved_at: null, approved_by: null,
}));
data.bills[3].approval_status = 'approved';
data.payments.push({ id: 'already-paid', bill_id: data.bills[3].id, amount_paise: 50000, method: 'Cash', payer: 'customer', occurred_at: data.as_of, recorded_at: data.as_of, recorded_by: 'demo-cashier', source: 'cashier', reversal_of: null, reason: null });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/api/demo/reference-bills', route => route.fulfill({ json: { bills: [] } }));
await page.addInitScript(snapshot => {
  if (!localStorage.getItem('selection-test-seeded')) {
    localStorage.setItem('service-desk-finance-demo-v1', JSON.stringify(snapshot));
    localStorage.setItem('selection-test-seeded', 'yes');
  }
}, data);
try {
  await page.goto(base);
  await page.getByLabel('User ID', { exact: true }).fill('cashier01');
  await page.getByLabel('Password', { exact: true }).fill('CashierDemo!2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'SELECT-0', exact: true }).click();
  assert.equal(await page.getByLabel('Payer', { exact: true }).count(), 0, 'customer collection needs no payer selector');
  const amount = page.getByLabel('Amount received now (₹)');
  const select = index => page.getByRole('checkbox', { name: 'Select bill SELECT-' + index, exact: true });
  assert.equal(await amount.inputValue(), '8617');
  assert.equal(await select(3).isDisabled(), true);
  assert.equal(await select(4).isDisabled(), true);
  assert.equal(await select(3).isChecked(), false);
  await amount.fill('10');
  await select(2).uncheck();
  assert.equal(await amount.inputValue(), '7617', 'selection replaces a manually entered amount');
  await select(1).uncheck();
  assert.equal(await amount.inputValue(), '6064');
  await select(1).check();
  assert.equal(await amount.inputValue(), '7617');
  await page.getByRole('button', { name: 'Select all outstanding bills' }).click();
  assert.equal(await amount.inputValue(), '8617');
  await page.getByRole('button', { name: 'Clear selection' }).click();
  assert.equal(await amount.inputValue(), '0');
  assert.equal(await page.getByRole('button', { name: /Record payment/ }).isDisabled(), true);
  await select(0).check(); await select(1).check();
  const pay = page.getByRole('button', { name: /Mark selected bills as paid/ });
  assert.equal(await pay.isDisabled(), true, 'payment method required');
  await page.getByLabel('Mode of payment').selectOption('Cheque');
  assert.equal(await pay.isDisabled(), true, 'cheque number required');
  await page.getByLabel('Cheque number (required)').fill('TEST-001');
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.locator('.sd-dialog-body').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.locator('.sd-collection-bills').screenshot({ path: '/tmp/customer-payment-' + width + '.png' });
  }
  await pay.click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('service-desk-finance-demo-v1')).payments.length === 3);
  const snapshot = await page.evaluate(() => JSON.parse(localStorage.getItem('service-desk-finance-demo-v1')));
  assert.equal(snapshot.bills[0].status, 'paid'); assert.equal(snapshot.bills[1].status, 'paid');
  assert.deepEqual(snapshot.bills[2], data.bills[2], 'unselected invoice stays unchanged');
  assert.deepEqual(snapshot.bills[4], data.bills[4], 'unread invoice stays unchanged');
  const payments = snapshot.payments.filter(p => p.id !== 'already-paid');
  assert.equal(payments.reduce((sum, p) => sum + p.amount_paise, 0), 761700);
  assert.equal(new Set(payments.map(p => p.collection_id)).size, 1);
  assert.ok(payments.every(p => p.transaction_id === 'TEST-001'));
  assert.ok(payments.every(p => p.payer === 'customer'), 'collections automatically use the customer payer');
  await page.getByRole('button', { name: 'Close bill details' }).click();
  await page.getByRole('button', { name: /^Archive/ }).click();
  await page.getByRole('button', { name: 'SELECT-0', exact: true }).waitFor();
  await page.getByRole('button', { name: 'SELECT-1', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Customer payment passed: selection totals, exclusions, shared payment, paid status, archive and mobile layout.');
} finally { await browser.close(); }

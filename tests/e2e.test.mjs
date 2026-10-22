// Whole-app check: runs the website in headless Chromium against a local stand-in
// for Supabase (real Postgres + supabase-setup.sql) and clicks through it as the
// owner and as staff, on a computer-sized and a phone-sized screen.
// Run with:  npm run test:e2e   (from this folder)
// Needs Chromium for Playwright; if it is missing:  npx playwright install chromium
// Screenshots are saved in tests/shots/ for a visual check.
import { start } from './local-supabase.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const SHOTS = fileURLToPath(new URL('./shots/', import.meta.url));
fs.rmSync(SHOTS, { recursive: true, force: true }); fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 8099, BASE = `http://localhost:${PORT}/`;
const stack = await start({ port: PORT, setupSql: fs.readFileSync(fileURLToPath(new URL('../supabase-setup.sql', import.meta.url)), 'utf8') });

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) { pass++; console.log('  ✓', label); } else { fail++; console.log('  ✗', label, extra); } };

const browser = await chromium.launch();
const consoleErrors = [];
async function newPage(viewport = { width: 1280, height: 860 }, colorScheme = 'light') {
  const ctx = await browser.newContext({ viewport, colorScheme });
  const page = await ctx.newPage();
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/realtime|websocket|404|Failed to load resource/i.test(m.text())) consoleErrors.push(m.text()); });
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: SHOTS + name + '.png', fullPage: true });
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function login(page, user, pw) {
  await page.goto(BASE);
  await page.waitForSelector('#loginForm');
  await page.fill('#li-user', user);
  await page.fill('#li-pw', pw);
  await page.click('#loginForm button[type=submit]');
}
async function logout(page) {
  await page.locator('.rail [data-act="logout"]').click();
  await page.waitForSelector('#loginForm');
}
async function addProduct(page, name, unit, price) {
  await page.click('text=Add product');
  await page.fill('#pf-name', name); await page.fill('#pf-unit', unit); await page.fill('#pf-price', price);
  await page.click('#pf button[type=submit]');
  await page.waitForSelector(`.pcard:has-text("${name}")`);
}
// A pretend XP-Q200 on USB, put in place of the browser's WebUSB before the app loads.
// window.__usb.mode: 'ok', 'denied' (Windows still has the printer's own driver) or 'unplugged'.
function fakeUsbPrinter() {
  const usb = window.__usb = { mode: 'ok', sent: [] };
  const allowed = () => sessionStorage.getItem('usbAllowed') === '1';
  const out = { endpointNumber: 1, direction: 'out', type: 'bulk', packetSize: 64 };
  const alt = { alternateSetting: 0, interfaceClass: 7, interfaceSubclass: 1, interfaceProtocol: 2, endpoints: [out] };
  const cfg = { configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternate: alt, alternates: [alt], claimed: false }] };
  const device = {
    productName: 'XP-Q200', vendorId: 0x0483, productId: 0x5743, configurations: [cfg], configuration: null, opened: false,
    async open() { if (usb.mode === 'denied') throw new DOMException('Access denied.', 'SecurityError'); this.opened = true; },
    async selectConfiguration() { this.configuration = cfg; },
    async claimInterface() {},
    async transferOut(ep, data) { for (const b of data) usb.sent.push(b); return { status: 'ok', bytesWritten: data.byteLength }; },
    async close() { this.opened = false; },
    async forget() { sessionStorage.removeItem('usbAllowed'); },
  };
  Object.defineProperty(navigator, 'usb', { configurable: true, value: {
    async getDevices() { return allowed() && usb.mode !== 'unplugged' ? [device] : []; },
    async requestDevice() { sessionStorage.setItem('usbAllowed', '1'); return device; },
    addEventListener() {},
  } });
}
// A pretend Windows app (desktop/preload.js) with two installed printers. Keeps the jobs it was given.
function fakeWindowsApp() {
  const desk = window.__desk = { printers: [{ name: 'Microsoft Print to PDF', isDefault: true }, { name: 'XP-80C', isDefault: false }], jobs: [] };
  window.desktop = {
    printers: async () => desk.printers,
    async print(name, bytes) {
      if (!desk.printers.some(p => p.name === name)) throw new Error("Error invoking remote method 'print': Error: printer-missing");
      desk.jobs.push({ name, bytes: Array.from(bytes) });
    },
    retry: async () => {},
  };
}
const takePrinted = page => page.evaluate(() => window.__usb.sent.splice(0));
// Stands in for the print window: counts calls instead of opening it, and leaves the print copy in place.
const catchPrintWindow = page => page.evaluate(() => { window.__printCalls = 0; window.print = () => { window.__printCalls++; }; });
const clearToasts = page => page.evaluate(() => { document.querySelector('#toast').innerHTML = ''; });
// Reads back a print job: ESC @, picture bands (GS v 0, 72 bytes = 576 dots wide), then the paper cut.
function readReceipt(b) {
  if (b[0] !== 0x1b || b[1] !== 0x40) return null;
  const rows = []; let i = 2;
  while (b[i] === 0x1d && b[i + 1] === 0x76 && b[i + 2] === 0x30) {
    const w = b[i + 4] + b[i + 5] * 256, h = b[i + 6] + b[i + 7] * 256; i += 8;
    for (let y = 0; y < h; y++, i += w) rows.push(b.slice(i, i + w));
  }
  return rows.length && rows.every(r => r.length === 72) && b.slice(i).join() === '29,86,66,0' ? rows : null;
}
async function receiptShot(page, rows, name) {
  const png = await page.evaluate(rows => {
    const c = document.createElement('canvas'); c.width = rows[0].length * 8; c.height = rows.length;
    const ctx = c.getContext('2d'), img = ctx.createImageData(c.width, c.height);
    rows.forEach((r, y) => { for (let x = 0; x < c.width; x++) { const k = (y * c.width + x) * 4, v = r[x >> 3] & (0x80 >> (x & 7)) ? 0 : 255; img.data.set([v, v, v, 255], k); } });
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png').split(',')[1];
  }, rows);
  fs.writeFileSync(SHOTS + name + '.png', Buffer.from(png, 'base64'));
}
async function addStockFromCard(page, name, n) {
  await page.locator(`.pcard:has-text("${name}") >> text=Add stock`).click();
  await page.fill('#sf-q', String(n));
  await page.click('#sf button[type=submit]');
  await page.waitForSelector(`.pcard:has-text("${name}") .stockline:has-text("${n} ")`);
}

try {
  // ---------------- owner: first-time setup ----------------
  console.log('Owner first-time setup');
  let { ctx, page } = await newPage();
  await page.goto(BASE);
  await page.waitForSelector('#setupForm');
  ok(true, 'fresh install shows "Create the owner account"');
  await page.fill('#su-name', 'Mrs. Funmi Adebayo');
  await page.fill('#su-user', 'Mummy');
  await page.fill('#su-pw', 'water2026');
  await page.fill('#su-pw2', 'water2026');
  await page.click('#setupForm button[type=submit]');
  await page.waitForSelector('h1:text("Today")', { timeout: 15000 });
  ok(true, 'owner account created and logged in to Home');
  ok(await page.locator('.rail .tag.owner:text("OWNER")').isVisible(), 'owner tag shown');

  console.log('\nOwner adds products, stock and changes a price');
  await page.click('[data-nav="products"] >> visible=true');
  await page.click('text=Add product');
  ok((await page.locator('#pf input').count()) === 3, 'Add product asks only for name, what it is sold in, and price');
  await page.fill('#pf-unit', 'bag');
  ok((await page.locator('#pf-pl').textContent()) === 'Price per bag (₦)', 'price label follows what it is sold in');
  await shot(page, '01-add-product');
  await page.click('.modal-f >> text=Cancel');
  await addProduct(page, 'Table water 75cl', 'carton', '1500');
  ok(await page.locator('.pcard:has-text("Table water 75cl") .pill:text("Out of stock")').isVisible(), 'new product starts out of stock');
  await addStockFromCard(page, 'Table water 75cl', 200);
  ok(true, 'owner added 200 cartons with "Add stock" on the card');
  for (const [n, u, pr, q] of [['Coke 50cl', 'pack', '2400', 50], ['Sachet water (pure water)', 'bag', '350', 400], ['Golden Penny spaghetti', 'carton', '16500', 8]]) {
    await addProduct(page, n, u, pr);
    await addStockFromCard(page, n, q);
  }
  ok((await page.locator('.pcard').count()) === 4, 'four products listed');
  await page.locator('.pcard:has-text("Table water 75cl") >> text=Change price').click();
  await page.fill('#prf-price', '1600');
  await page.click('#prf button[type=submit]');
  await page.waitForSelector('.pcard:has-text("Table water 75cl") .price:has-text("₦1,600")');
  ok(true, 'price changed to ₦1,600 and card updated');
  await page.locator('.pcard:has-text("Golden Penny spaghetti") >> text=Edit').click();
  ok((await page.locator('#pf input').count()) === 5 && await page.locator('#pf-why-w').isHidden(), 'Edit shows stock count; reason only appears when the count changes');
  await page.fill('#pf-qty', '7');
  ok(await page.locator('#pf-why-w').isVisible(), 'reason box appears after changing the count');
  await page.fill('#pf-why', '1 carton damaged');
  await page.click('#pf button[type=submit]');
  await page.waitForSelector('.pcard:has-text("Golden Penny spaghetti") .stockline:has-text("7 cartons")');
  ok(true, 'owner corrected a stock count with a reason');
  await shot(page, '02-products');

  console.log('\nOwner adds staff');
  await page.click('[data-nav="staff"] >> visible=true');
  await page.click('text=Add staff');
  await page.fill('#stf-n', 'Tunde Okafor');
  await page.fill('#stf-u', 'tunde');
  await page.fill('#stf-ph', '0803 222 3333');
  await page.fill('#stf-p', 'tunde123');
  await page.click('#stf button[type=submit]');
  await page.waitForSelector('.modal :text("Login created")');
  ok(await page.locator('.modal .summary :text("STF-001")').isVisible(), 'staff ID STF-001 shown with username/password');
  await page.click('.modal-f >> text=Done');
  await page.click('text=Add staff');
  await page.fill('#stf-n', 'Blessing Eze'); await page.fill('#stf-u', 'blessing'); await page.fill('#stf-p', 'bless123');
  await page.click('#stf button[type=submit]');
  await page.waitForSelector('.modal :text("STF-002")');
  await page.click('.modal-f >> text=Done');
  await page.waitForSelector('.pcard:has-text("Blessing Eze")');
  ok((await page.locator('.pcard').count()) === 3, 'staff page lists owner + 2 staff');
  await logout(page);

  // ---------------- staff ----------------
  console.log('\nStaff (Tunde) records a sale and a delivery');
  await login(page, 'tunde', 'tunde123');
  await page.waitForSelector('h1:text("My sales")', { timeout: 15000 });
  ok(true, 'staff lands on "My sales"');
  const navLabels = await page.locator('.rail .navbtn').allInnerTexts();
  ok(!navLabels.some(t => /Home|Staff|Activity/.test(t)), 'staff menu has no Home/Staff/Activity', navLabels.join('|'));
  await page.click('text=New sale');
  await page.fill('#nf-c', 'Iya Bose Stores');
  await page.fill('#nf-ph', '08031112222');
  const line1 = page.locator('.line').nth(0);
  await line1.locator('.l-p').selectOption({ label: 'Table water 75cl · ₦1,600/carton' });
  ok(await line1.locator('.l-pr').getAttribute('readonly') !== null, 'staff cannot type a price');
  await line1.locator('.l-q').fill('20');
  await page.click('#nf-add');
  const line2 = page.locator('.line').nth(1);
  await line2.locator('.l-p').selectOption({ label: 'Coke 50cl · ₦2,400/pack' });
  await line2.locator('.l-q').fill('5');
  await page.selectOption('#nf-m', 'credit');
  await page.fill('#nf-paid', '10000');
  ok((await page.locator('#nf-tot').innerText()) === '₦44,000', 'sale total ₦44,000', await page.locator('#nf-tot').innerText());
  ok((await page.locator('#nf-bal').innerText()) === '₦34,000', 'balance ₦34,000');
  ok(!(await page.locator('.line .info').first().innerText()).includes('Min'), 'no minimum-order hints on the sale form');
  await shot(page, '03-staff-new-sale');
  await page.click('#nf-save');
  await page.waitForSelector('.invoice .no:text("INV-00001")', { timeout: 15000 });
  ok(true, 'invoice INV-00001 opens after saving');
  ok(await page.locator('.invoice :text("Served by Tunde Okafor (STF-001)")').isVisible(), 'invoice shows staff name and ID');
  const waHref = await page.locator('.modal-f a:has-text("WhatsApp")').getAttribute('href');
  ok(waHref.startsWith('https://wa.me/2348031112222?text='), 'WhatsApp link uses the customer number', waHref.slice(0, 40));
  await shot(page, '04-invoice');
  await page.click('.modal-f >> text=Done');
  await page.waitForSelector('tr:has-text("INV-00001")');
  ok(true, 'sale appears in My sales');

  await page.click('[data-nav="stock"] >> visible=true');
  await page.click('text=Receive stock');
  await page.selectOption('#sf-p', { label: 'Coke 50cl (45 in stock)' });
  await page.fill('#sf-q', '30');
  await page.fill('#sf-s', 'Coca-Cola depot, Agidingbi');
  await page.click('#sf button[type=submit]');
  await page.waitForSelector('tr:has-text("Coca-Cola depot")');
  ok(true, 'staff recorded 30 packs received');
  await page.click('[data-nav="products"] >> visible=true');
  await page.waitForSelector('.pcard:has-text("Coke 50cl") .stockline:has-text("75 packs")');
  ok(true, 'Coke stock now 75 (50 − 5 + 30)');
  ok((await page.locator('text=Change price').count()) === 0, 'staff have no "Change price" button');
  await logout(page);

  await login(page, 'blessing', 'bless123');
  await page.waitForSelector('h1:text("My sales")');
  await page.waitForSelector('.panel :text("No sales in this period")');
  ok(true, "second staff can't see Tunde's sales");
  await logout(page);

  // ---------------- owner monitors ----------------
  console.log('\nOwner checks Home, records payment, special price, cancels a sale');
  await login(page, 'mummy', 'water2026');
  await page.waitForSelector('h1:text("Today")');
  await page.waitForSelector('.feed :text("Sold 20 cartons of Table water 75cl, 5 packs of Coke 50cl to Iya Bose Stores")');
  ok(true, "activity feed shows Tunde's sale");
  ok(await page.locator('.feed :text("Received 30 packs of Coke 50cl from Coca-Cola depot, Agidingbi")').isVisible(), 'activity feed shows delivery');
  const tiles = await page.locator('.tile .val').allInnerTexts();
  ok(tiles[0] === '₦44,000' && tiles[1] === '₦10,000' && tiles[2] === '₦34,000', 'tiles: sales ₦44,000 / received ₦10,000 / owed ₦34,000', tiles.join(' | '));
  ok(await page.locator('.panel:has-text("Running low") :text("Nothing is running low")').isVisible(), 'nothing running low yet (plenty left at this week’s pace)');

  await page.click('[data-nav="products"] >> visible=true');
  await addProduct(page, 'Peak milk 400g', 'tin', '9500');
  await page.click('[data-nav="home"] >> visible=true');
  await page.waitForSelector('.lowlist li:has-text("Peak milk 400g"):has-text("Out of stock")');
  ok(true, 'a product with no stock shows under Running low');
  await shot(page, '05-owner-home-desktop');

  await page.click('[data-nav="sales"] >> visible=true');
  await page.click('tr:has-text("INV-00001")');
  await page.click('#iv-pay');
  await page.fill('#pm-a', '34000');
  await page.selectOption('#pm-m', 'transfer');
  await page.click('#pm button[type=submit]');
  await page.waitForSelector('.invoice .tots :text("₦0")');
  ok(true, 'payment recorded; balance ₦0');
  await page.click('.modal-f >> text=Done');

  await page.click('text=New sale');
  await page.locator('.line').nth(0).locator('.l-p').selectOption({ label: 'Table water 75cl · ₦1,600/carton' });
  await page.locator('.line').nth(0).locator('.l-q').fill('3');
  await page.locator('.line').nth(0).locator('.l-pr').fill('1400');
  await page.waitForSelector('.line .info :text("Special price")');
  await page.click('#nf-save');
  await page.waitForSelector('.invoice .no:text("INV-00002")');
  ok(await page.locator('.invoice .tots :text("₦4,200")').first().isVisible(), 'owner sold 3 cartons at a special ₦1,400');
  await page.click('#iv-void');
  await page.fill('#vm-r', 'Wrong customer');
  await page.click('#vm button[type=submit]');
  await page.waitForSelector('.modal :text("Cancelled: Wrong customer")');
  ok(true, 'owner cancelled INV-00002');
  await page.click('.modal-f >> text=Done');
  await page.click('[data-nav="products"] >> visible=true');
  await page.waitForSelector('.pcard:has-text("Table water 75cl") .stockline:has-text("180 cartons")');
  ok(true, 'stock returned after cancel (200 − 20 = 180)');

  console.log('\nOwner manages staff');
  await page.click('[data-nav="staff"] >> visible=true');
  await page.locator('.pcard:has-text("Tunde Okafor") >> text=Switch off').click();
  await page.waitForSelector('.pcard:has-text("Tunde Okafor") :text("Switched off")');
  ok(true, 'Tunde switched off');
  await page.locator('.pcard:has-text("Blessing Eze") >> text=New password').click();
  await page.fill('#rp-p', 'newbless9');
  await page.click('#rp button[type=submit]');
  await page.waitForSelector('.modal :text("Password changed")');
  await page.click('.modal-f >> text=Done');
  await page.click('[data-nav="activity"] >> visible=true');
  await page.waitForSelector('.feed :text("Switched off the login for Tunde Okafor (STF-001)")');
  ok(true, 'staff changes appear in activity');
  await logout(page);

  await login(page, 'tunde', 'tunde123');
  await page.waitForSelector('#li-err:has-text("switched off")');
  ok(true, 'switched-off staff sees "This account has been switched off"');
  await login(page, 'blessing', 'bless123');
  await page.waitForSelector('#li-err:has-text("Wrong username or password")');
  ok(true, 'old password no longer works');
  await login(page, 'blessing', 'newbless9');
  await page.waitForSelector('h1:text("My sales")');
  ok(true, 'new password works');
  await ctx.close();

  // ---------------- receipt printer ----------------
  console.log('\nReceipt printer (pretend XP-Q200 on USB)');
  ({ ctx, page } = await newPage());
  await ctx.addInitScript(fakeUsbPrinter);
  await login(page, 'mummy', 'water2026');
  await page.waitForSelector('h1:text("Today")');
  await page.click('[data-nav="sales"] >> visible=true');
  await page.click('tr:has-text("INV-00001")');
  await catchPrintWindow(page);
  await page.click('#iv-print');
  await page.waitForFunction(() => window.__printCalls === 1);
  ok(true, 'with no receipt printer connected, Print receipt opens the print window');
  const pdf = await page.pdf({ preferCSSPageSize: true });
  fs.writeFileSync(SHOTS + '14-print-window.pdf', pdf);
  const pages = [...pdf.toString('latin1').matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map(m => [+m[1], +m[2]]);
  ok(pages.length === 1 && Math.abs(pages[0][0] - 226.8) < 1 && pages[0][1] > 150 && pages[0][1] < 400,
    'print window gets one 80mm page as long as the receipt, not the whole screen', JSON.stringify(pages));
  await page.evaluate(() => dispatchEvent(new Event('afterprint')));
  ok((await page.locator('#print-receipt').count()) === 0, 'print copy removed after printing');
  await page.click('.modal-f >> text=Done');

  await page.click('.rail [data-act="printer"]');
  await page.evaluate(() => { window.__usb.mode = 'denied'; });
  await page.click('#pr-add');
  await page.waitForSelector('#pr-err:has-text("SETUP.md (step 9)")');
  ok(await page.locator('#pr-add').isVisible(), "Windows driver problem explained when connecting; printer not saved");
  await page.evaluate(() => { window.__usb.mode = 'ok'; });
  await page.click('#pr-add');
  await page.waitForSelector('#pr-b :text("Ready")');
  ok(await page.locator('#pr-b :text("XP-Q200")').isVisible(), 'printer connected and shown as ready');
  await shot(page, '09-printer-ready');
  await clearToasts(page);
  await page.click('#pr-test');
  await page.waitForSelector('.toast:has-text("Receipt sent to the printer")');
  ok(readReceipt(await takePrinted(page)) !== null, 'test print sent as a 576-dot picture followed by a paper cut');
  await page.click('.modal-f >> text=Done');

  await page.click('tr:has-text("INV-00001")');
  await clearToasts(page);
  await page.click('#iv-print');
  await page.waitForSelector('.toast:has-text("Receipt sent to the printer")');
  const receipt = readReceipt(await takePrinted(page));
  ok(receipt !== null && receipt.length > 400, 'receipt printed straight to the printer', receipt ? receipt.length + ' rows' : 'bad print job');
  if (receipt) await receiptShot(page, receipt, '10-receipt');
  await page.evaluate(() => { window.__usb.mode = 'unplugged'; });
  await clearToasts(page);
  await page.click('#iv-print');
  await page.waitForSelector('.toast:has-text("The receipt printer is not connected")');
  ok((await takePrinted(page)).length === 0, 'unplugged printer gives a clear message');
  await page.click('.modal-f >> text=Done');

  await page.evaluate(() => { window.__usb.mode = 'ok'; });
  await page.click('tr:has-text("INV-00002")');
  await clearToasts(page);
  await page.click('#iv-print');
  await page.waitForSelector('.toast:has-text("Receipt sent to the printer")');
  const voided = readReceipt(await takePrinted(page));
  ok(voided !== null, 'cancelled sale prints too');
  if (voided) await receiptShot(page, voided, '11-receipt-cancelled');
  await page.click('.modal-f >> text=Done');

  await page.click('.rail [data-act="printer"]');
  await page.click('#pr-off');
  await page.waitForSelector('#pr-add');
  await page.click('.modal-f >> text=Done');
  await page.click('tr:has-text("INV-00001")');
  await catchPrintWindow(page);
  await page.click('#iv-print');
  await page.waitForFunction(() => window.__printCalls === 1);
  ok((await takePrinted(page)).length === 0, '"Stop using it" sends receipts back to the print window');
  await ctx.close();

  console.log('\nReceipt printer in the Windows app (pretend desktop/preload.js)');
  ({ ctx, page } = await newPage());
  await ctx.addInitScript(fakeWindowsApp);
  await login(page, 'mummy', 'water2026');
  await page.waitForSelector('h1:text("Today")');
  await page.click('.rail [data-act="printer"]');
  ok((await page.locator('#pr-pick').inputValue()) === 'XP-80C', 'installed printers listed, with the receipt printer already picked');
  await page.click('#pr-use');
  await page.waitForSelector('#pr-b :text("Ready")');
  ok(await page.locator('#pr-b b:text("XP-80C")').isVisible(), 'XP-80C shown as ready');
  await clearToasts(page);
  await page.click('#pr-test');
  await page.waitForSelector('.toast:has-text("Receipt sent to the printer")');
  let jobs = await page.evaluate(() => window.__desk.jobs.splice(0));
  ok(jobs.length === 1 && jobs[0].name === 'XP-80C' && readReceipt(jobs[0].bytes) !== null, 'test print goes to XP-80C through Windows');
  await page.click('.modal-f >> text=Done');
  await page.click('[data-nav="sales"] >> visible=true');
  await page.click('tr:has-text("INV-00001")');
  await clearToasts(page);
  await page.click('#iv-print');
  await page.waitForSelector('.toast:has-text("Receipt sent to the printer")');
  jobs = await page.evaluate(() => window.__desk.jobs.splice(0));
  ok(jobs.length === 1 && readReceipt(jobs[0].bytes)?.length > 400, 'invoice receipt printed through Windows');
  await page.evaluate(() => { window.__desk.printers.pop(); });
  await clearToasts(page);
  await page.click('#iv-print');
  await page.waitForSelector('.toast:has-text("not installed on this computer any more")');
  ok(true, 'removed printer gives a clear message');
  await page.click('.modal-f >> text=Done');
  await page.click('.rail [data-act="printer"]');
  ok(await page.locator('#pr-b :text("is not on this computer any more")').isVisible(), 'printer window asks to pick again');
  await shot(page, '13-windows-app-printer-gone');
  await page.click('#pr-off');
  await page.waitForSelector('#pr-use');
  ok((await page.evaluate(() => localStorage.getItem('receiptPrinterName'))) === null, '"Stop using it" forgets the printer');
  await ctx.close();

  // ---------------- phone ----------------
  console.log('\nPhone views');
  ({ ctx, page } = await newPage({ width: 390, height: 844 }));
  await login(page, 'mummy', 'water2026');
  await page.waitForSelector('h1:text("Today")');
  await page.waitForSelector('.tile .val');
  ok(await page.locator('.tabbar').isVisible(), 'phone shows bottom tabs');
  ok(await noSideScroll(page), 'no sideways scrolling on phone: home');
  await shot(page, '06-owner-home-phone');
  await page.click('.tabbar [data-nav="products"]');
  await shot(page, '07-phone-products');
  await page.locator('.pcard:has-text("Sachet water") >> text=Change price').click();
  await page.fill('#prf-price', '380');
  await page.click('#prf button[type=submit]');
  await page.waitForSelector('.pcard:has-text("Sachet water") .price:has-text("₦380")');
  ok(true, 'owner changed a price from the phone');
  for (const v of ['sales', 'stock', 'products', 'more']) {
    await page.click(`.tabbar [data-nav="${v}"]`);
    await page.waitForTimeout(300);
    ok(await noSideScroll(page), `no sideways scrolling on phone: ${v}`);
    if (v === 'more') await shot(page, '12-phone-more');
  }
  await ctx.close();

  ({ ctx, page } = await newPage({ width: 390, height: 844 }, 'dark'));
  await login(page, 'mummy', 'water2026');
  await page.waitForSelector('.tile .val');
  await page.click('.tabbar [data-nav="products"]');
  await shot(page, '08-phone-products-dark');
  await ctx.close();

  ok(consoleErrors.length === 0, 'no JavaScript errors in the browser', consoleErrors.slice(0, 5).join(' || '));
} catch (e) {
  fail++;
  console.log('  ✗ test stopped:', e.message.split('\n')[0]);
} finally {
  await browser.close();
  await stack.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

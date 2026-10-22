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

// Database rules check: runs supabase-setup.sql on an in-memory Postgres (PGlite)
// with a small copy of Supabase's auth tables, then acts as anonymous visitors,
// the owner and staff. Run with:  npm run test:db   (from this folder)
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SETUP = fs.readFileSync(fileURLToPath(new URL('../supabase-setup.sql', import.meta.url)), 'utf8');
const LOGIN_DOMAIN = 'login.warehouse.invalid';
const db = await PGlite.create({ extensions: { pgcrypto } });

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log('  ✓', label); } else { fail++; console.log('  ✗', label, extra); } };

// ---- The parts of Supabase the script relies on (auth.users columns as in supabase/auth) ----
await db.exec(`
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema extensions;
create table auth.users (
  instance_id uuid, id uuid primary key, aud varchar(255), role varchar(255), email varchar(255),
  encrypted_password varchar(255), email_confirmed_at timestamptz, invited_at timestamptz,
  confirmation_token varchar(255), confirmation_sent_at timestamptz, recovery_token varchar(255), recovery_sent_at timestamptz,
  email_change_token_new varchar(255), email_change varchar(255), email_change_sent_at timestamptz, last_sign_in_at timestamptz,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean, created_at timestamptz, updated_at timestamptz,
  phone text unique default null, phone_confirmed_at timestamptz, phone_change text default '', phone_change_token varchar(255) default '',
  phone_change_sent_at timestamptz, email_change_token_current varchar(255) default '', email_change_confirm_status smallint default 0,
  banned_until timestamptz, reauthentication_token varchar(255) default '', reauthentication_sent_at timestamptz,
  is_sso_user boolean not null default false, deleted_at timestamptz, is_anonymous boolean not null default false
);
create unique index users_email_partial_key on auth.users (email) where (is_sso_user = false);
create table auth.identities (
  provider_id text not null, user_id uuid not null references auth.users(id) on delete cascade, identity_data jsonb not null,
  provider text not null, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz,
  email text generated always as (lower(identity_data->>'email')) stored,
  id uuid primary key default gen_random_uuid(), unique (provider_id, provider)
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
`);

console.log('Run setup script (1st time)');
await db.exec(SETUP);
ok(true, 'setup script ran without errors');

async function as(role, uid, sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ''}', false); set role ${role};`);
  try { return await db.query(sql, params); }
  finally { await db.exec('reset role'); }
}
async function err(role, uid, sql, params = []) {
  try { await as(role, uid, sql, params); return null; } catch (e) { return e.message; }
}
const one = async (...a) => (await as(...a)).rows[0];
const sys = async (sql, p = []) => (await db.query(sql, p)).rows;
const stock = async id => (await sys(`select qty from public.products where id=$1`, [id]))[0].qty;
// Same checks Supabase Auth makes on a password login (see FindUserByEmailAndAudience)
async function loginOk(username, pw) {
  const r = await sys(`select id from auth.users where instance_id = '00000000-0000-0000-0000-000000000000'
      and lower(email) = lower($1) and aud = 'authenticated' and is_sso_user = false
      and (banned_until is null or banned_until < now())
      and encrypted_password = extensions.crypt($2, encrypted_password)`, [`${username}@${LOGIN_DOMAIN}`, pw]);
  return r[0]?.id || null;
}

console.log('\nFirst-time setup');
ok((await one('anon', '', 'select public.owner_exists() as e')).e === false, 'anon sees no owner yet');
await as('anon', '', `select public.setup_owner('Mrs. Adebayo', '  Mummy ', 'secret1')`);
ok((await one('anon', '', 'select public.owner_exists() as e')).e === true, 'owner created');
const again = await err('anon', '', `select public.setup_owner('X', 'thief', 'secret1')`);
ok(again && again.includes('already exists'), 'second owner setup refused', again);
const OWNER = await loginOk('mummy', 'secret1');
ok(!!OWNER, 'owner can log in with username (case/space normalised)');
ok(!(await loginOk('mummy', 'wrong')), 'wrong password rejected');
const u = (await sys(`select * from auth.users where id = $1`, [OWNER]))[0];
ok(u.encrypted_password.startsWith('$2a$10$'), 'password stored as bcrypt cost 10', u.encrypted_password.slice(0, 7));
const nullStrings = ['confirmation_token', 'recovery_token', 'email_change_token_current', 'email_change_token_new', 'email_change', 'phone_change_token', 'phone_change', 'reauthentication_token'].filter(c => u[c] === null);
ok(nullStrings.length === 0, 'no NULL token columns (Supabase Auth needs empty strings)', nullStrings.join(','));
ok(u.instance_id === '00000000-0000-0000-0000-000000000000' && u.aud === 'authenticated' && u.email_confirmed_at, 'instance_id / aud / confirmed set');
const ident = (await sys(`select * from auth.identities where user_id = $1`, [OWNER]))[0];
ok(ident && ident.provider === 'email' && ident.provider_id === OWNER && ident.email === `mummy@${LOGIN_DOMAIN}`, 'identity row created');

console.log('\nAnonymous visitors');
ok((await err('anon', '', 'select * from public.products')) !== null, 'anon cannot read products');
ok((await err('anon', '', `select public.create_sale('[]'::jsonb, 'cash', 0)`)) !== null, 'anon cannot call create_sale');
ok((await err('anon', '', `select private.create_login('x', 'yyyyyy')`)) !== null, 'anon cannot reach private helpers');

console.log('\nOwner: products and prices');
const P1 = (await one('authenticated', OWNER, `select public.save_product(null, 'Table water 75cl', 'Carton', 1500) as id`)).id;
ok(P1 && (await stock(P1)) === 0, 'new product starts with 0 in stock');
ok((await sys(`select unit from public.products where id=$1`, [P1]))[0].unit === 'carton', 'unit saved in lower case');
await as('authenticated', OWNER, `select public.receive_stock($1, 100)`, [P1]);
ok((await stock(P1)) === 100, 'owner added 100 cartons with Add stock');
const P2 = (await one('authenticated', OWNER, `select public.save_product(null, 'Coke 50cl', 'pack', 2400.5, 30) as id`)).id;
ok((await stock(P2)) === 30, 'product can also be created with a starting count');
await as('authenticated', OWNER, `select public.set_price($1, 1600)`, [P1]);
ok(Number((await sys(`select price from public.products where id=$1`, [P1]))[0].price) === 1600, 'owner changed price');
await as('authenticated', OWNER, `select public.save_product($1, 'Table water 75cl', 'carton', 1600)`, [P1]);
ok((await stock(P1)) === 100, 'editing name/price without a count leaves stock alone');
const noReason = await err('authenticated', OWNER, `select public.save_product($1, 'Table water 75cl', 'carton', 1600, 95)`, [P1]);
ok(noReason && noReason.includes('why'), 'stock correction without a reason refused', noReason);
await as('authenticated', OWNER, `select public.save_product($1, 'Table water 75cl', 'carton', 1600, 95, '5 cartons damaged')`, [P1]);
ok((await stock(P1)) === 95, 'stock corrected with a reason');
ok((await sys(`select count(*)::int c from pg_proc where proname = 'save_product'`))[0].c === 1, 'only one version of save_product exists');

console.log('\nOwner: staff');
const code = (await one('authenticated', OWNER, `select public.create_staff('Tunde Okafor', 'Tunde', 'pass12', '0803 111 2222') as c`)).c;
ok(code === 'STF-001', 'staff created with ID STF-001', code);
const dup = await err('authenticated', OWNER, `select public.create_staff('Other', 'tunde', 'pass12')`);
ok(dup && dup.includes('already taken'), 'duplicate username refused', dup);
const bad = await err('authenticated', OWNER, `select public.create_staff('Other', 'bad name', 'pass12')`);
ok(bad && bad.includes('Username must'), 'username with a space refused', bad);
const short = await err('authenticated', OWNER, `select public.create_staff('Other', 'ada', '123')`);
ok(short && short.includes('at least 6'), 'short password refused', short);
const STAFF = await loginOk('tunde', 'pass12');
ok(!!STAFF, 'staff can log in');
const code2 = (await one('authenticated', OWNER, `select public.create_staff('Ada Eze', 'ada', 'pass34') as c`)).c;
ok(code2 === 'STF-002', 'second staff gets STF-002', code2);
const STAFF2 = await loginOk('ada', 'pass34');

console.log('\nStaff: what they can and cannot do');
ok((await as('authenticated', STAFF, 'select * from public.products')).rows.length === 2, 'staff can see products and prices');
ok((await as('authenticated', STAFF, 'select * from public.activity')).rows.length === 0, 'staff cannot see the activity log');
ok((await as('authenticated', STAFF, 'select * from public.profiles')).rows.length === 1, 'staff only see their own profile');
ok((await err('authenticated', STAFF, `update public.products set price = 1 where id = $1`, [P1])) !== null, 'staff cannot edit products directly');
ok((await err('authenticated', STAFF, `insert into public.activity (kind, message) values ('x','fake')`)) !== null, 'staff cannot write fake activity');
const sp = await err('authenticated', STAFF, `select public.set_price($1, 1)`, [P1]);
ok(sp && sp.includes('Only the owner'), 'staff cannot change prices', sp);
const spp = await err('authenticated', STAFF, `select public.save_product(null, 'x', 'carton', 1)`);
ok(spp && spp.includes('Only the owner'), 'staff cannot add products', spp);
const cs = await err('authenticated', STAFF, `select public.create_staff('x','xyz','pass12')`);
ok(cs && cs.includes('Only the owner'), 'staff cannot add staff', cs);
ok((await err('authenticated', STAFF, `select private.create_login('hack', 'pass12')`)) !== null, 'staff cannot create logins directly');

console.log('\nSales');
const sale = (items, method, paid, name = null, phone = null, who = STAFF) =>
  one('authenticated', who, `select public.create_sale($1::jsonb, $2, $3, $4, $5, 'test') as r`, [JSON.stringify(items), method, paid, name, phone]);
const saleErr = (items, method, paid, name = null, who = STAFF) =>
  err('authenticated', who, `select public.create_sale($1::jsonb, $2, $3, $4)`, [JSON.stringify(items), method, paid, name]);

const s0 = (await sale([{ product_id: P1, qty: 5 }], 'cash', 8000)).r;
ok(s0.invoice_no === 'INV-00001', 'staff can sell any quantity (no minimum order)', s0.invoice_no);
const s1 = (await sale([{ product_id: P1, qty: 10 }], 'cash', 16000)).r;
const s1row = (await sys(`select * from public.sales where id=$1`, [s1.id]))[0];
ok(s1.invoice_no === 'INV-00002' && Number(s1row.total) === 16000, 'an item without a price sells at the list price (₦1,600)', s1row.total);
ok((await stock(P1)) === 80, 'stock went down (95 − 5 − 10)');
const tooMany = await saleErr([{ product_id: P1, qty: 1000 }], 'cash', 0);
ok(tooMany && tooMany.includes('Only 80 cartons'), 'cannot sell more than in stock', tooMany);
const dupLines = await saleErr([{ product_id: P1, qty: 50 }, { product_id: P1, qty: 50 }], 'cash', 160000);
ok(dupLines && dupLines.includes('left in stock'), 'two lines of the same product checked together', dupLines);
ok((await stock(P1)) === 80, 'failed sale changed nothing');
const owes = await saleErr([{ product_id: P1, qty: 10 }], 'credit', 0);
ok(owes && owes.includes('Enter their name'), 'credit sale needs a customer name', owes);
const s2 = (await sale([{ product_id: P1, qty: 20 }, { product_id: P2, qty: 5 }], 'credit', 10000, 'Iya Bose Stores', '0803 000 0000')).r;
const s2row = (await sys(`select * from public.sales where id=$1`, [s2.id]))[0];
ok(Number(s2row.total) === 32000 + 12002.5 && Number(s2row.balance) === 44002.5 - 10000, 'credit sale with part payment', `${s2row.total} ${s2row.balance}`);
const s3 = (await sale([{ product_id: P2, qty: 5 }], 'transfer', 0, 'iya bose stores', null, STAFF2)).r;
ok((await sys(`select count(*)::int c from public.customers`))[0].c === 1, 'same customer reused (case-insensitive)');
ok((await sys(`select customer_name from public.sales where id=$1`, [s3.id]))[0].customer_name === 'Iya Bose Stores', "customer's saved spelling used on the invoice");
ok((await as('authenticated', STAFF, 'select * from public.sales')).rows.length === 3, 'staff only see their own sales');
ok((await as('authenticated', STAFF2, 'select * from public.sales')).rows.length === 1, 'second staff sees only theirs');
ok((await as('authenticated', OWNER, 'select * from public.sales')).rows.length === 4, 'owner sees all sales');
ok((await as('authenticated', STAFF, 'select * from public.payments')).rows.length === 0, 'staff cannot see payments');

console.log('\nOwner specials');
const s4 = (await sale([{ product_id: P1, qty: 2, price: 1000 }], 'pos', 2000, null, null, OWNER)).r;
const s4row = (await sys(`select * from public.sales where id=$1`, [s4.id]))[0];
ok(Number(s4row.total) === 2000 && s4row.items[0].list_price === 1600, 'owner can give a special price');
await as('authenticated', OWNER, `select public.record_payment($1, 20000, 'cash')`, [s2.id]);
let b = (await sys(`select balance from public.sales where id=$1`, [s2.id]))[0].balance;
ok(Number(b) === 14002.5, 'part payment recorded', b);
await as('authenticated', OWNER, `select public.record_payment($1, 999999, 'transfer')`, [s2.id]);
b = (await sys(`select balance, amount_paid from public.sales where id=$1`, [s2.id]))[0];
ok(Number(b.balance) === 0 && Number(b.amount_paid) === 44002.5, 'overpayment capped at the balance');
const paidTwice = await err('authenticated', OWNER, `select public.record_payment($1, 100, 'cash')`, [s2.id]);
ok(paidTwice && paidTwice.includes('fully paid'), 'cannot pay a paid invoice', paidTwice);
const staffPay = await err('authenticated', STAFF, `select public.record_payment($1, 100, 'cash')`, [s3.id]);
ok(staffPay && staffPay.includes('Only the owner'), 'staff cannot record payments', staffPay);

const before = await stock(P1);
await as('authenticated', OWNER, `select public.void_sale($1, 'Customer returned goods')`, [s1.id]);
ok((await stock(P1)) === before + 10, 'cancelled sale put stock back');
ok(Number((await sys(`select sum(amount) s from public.payments where sale_id=$1`, [s1.id]))[0].s) === 0, 'refund recorded for cancelled sale');
const voidAgain = await err('authenticated', OWNER, `select public.void_sale($1, 'again')`, [s1.id]);
ok(voidAgain && voidAgain.includes('already cancelled'), 'cannot cancel twice', voidAgain);

console.log('\nStock received');
const p2before = await stock(P2);
await as('authenticated', STAFF, `select public.receive_stock($1, 20, 2000, 'Coca-Cola depot', 'waybill 22')`, [P2]);
ok((await stock(P2)) === p2before + 20, 'staff received 20 packs');
ok((await as('authenticated', STAFF, 'select * from public.stock_ins')).rows.length === 1, 'staff see their own deliveries');
ok((await err('authenticated', STAFF, `select public.receive_stock($1, 0)`, [P2])) !== null, 'zero quantity refused');

console.log('\nSwitching a staff login off / password reset');
await as('authenticated', OWNER, `select public.set_staff_active($1, false)`, [STAFF]);
ok(!(await loginOk('tunde', 'pass12')), 'switched-off staff cannot log in (banned)');
ok((await as('authenticated', STAFF, 'select * from public.products')).rows.length === 0, 'switched-off staff see nothing');
const offSale = await saleErr([{ product_id: P1, qty: 10 }], 'cash', 16000);
ok(offSale && offSale.includes('not allowed'), 'switched-off staff cannot sell', offSale);
const ownProf = (await as('authenticated', STAFF, 'select active from public.profiles')).rows;
ok(ownProf.length === 1 && ownProf[0].active === false, 'switched-off staff can still see they are switched off (for logout)');
await as('authenticated', OWNER, `select public.set_staff_active($1, true)`, [STAFF]);
ok(!!(await loginOk('tunde', 'pass12')), 'switched back on');
await as('authenticated', OWNER, `select public.reset_staff_password($1, 'brandnew')`, [STAFF]);
ok(!!(await loginOk('tunde', 'brandnew')) && !(await loginOk('tunde', 'pass12')), 'owner reset staff password');
const ownerSelf = await err('authenticated', OWNER, `select public.set_staff_active($1, false)`, [OWNER]);
ok(ownerSelf && ownerSelf.includes('not found'), 'owner cannot switch herself off', ownerSelf);

console.log('\nOther');
await as('authenticated', OWNER, `select public.archive_product($1)`, [P2]);
ok((await sys(`select archived from public.products where id=$1`, [P2]))[0].archived === true, 'product removed from list (kept for history)');
ok((await err('authenticated', STAFF, `select public.receive_stock($1, 5)`, [P2])) !== null, 'cannot receive stock for removed product');
await as('authenticated', STAFF, `select public.log_event('login', 'Logged in')`);
ok((await err('authenticated', STAFF, `select public.log_event('sale', 'fake sale')`)) !== null, 'staff cannot log fake sales');

console.log('\nRun setup script again (must be safe)');
await db.exec(SETUP);
ok((await sys(`select count(*)::int c from public.sales`))[0].c === 5, 're-running kept all data');
ok((await as('authenticated', STAFF, 'select * from public.sales')).rows.length === 3, 'permissions still correct after re-run');
const pub = (await sys(`select tablename from pg_publication_tables where pubname='supabase_realtime' order by 1`)).map(r => r.tablename);
ok(pub.length === 7, 'live updates enabled on 7 tables', pub.join(','));

console.log('\nSaving twice, and saving without internet');
const sendSale = (who, items, paid, clientId, madeAt = null, name = null) =>
  one('authenticated', who, `select public.create_sale(p_items => $1::jsonb, p_method => 'cash', p_amount_paid => $2,
    p_customer_name => $3, p_client_id => $4, p_made_at => $5) as r`, [JSON.stringify(items), paid, name, clientId, madeAt]);
const minutesAgo = m => new Date(Date.now() - m * 60000).toISOString();
const saleRow = async id => (await sys(`select * from public.sales where id=$1`, [id]))[0];

await as('authenticated', OWNER, `select public.receive_stock($1, 50)`, [P1]);
let start1 = await stock(P1);
const ID1 = crypto.randomUUID();
const first = (await sendSale(STAFF, [{ product_id: P1, qty: 2 }], 3200, ID1)).r;
const second = (await sendSale(STAFF, [{ product_id: P1, qty: 2 }], 3200, ID1)).r;
ok(first.id === ID1 && second.invoice_no === first.invoice_no && (await stock(P1)) === start1 - 2, 'a sale sent twice is saved once, with the id the app picked');
const stolen = await err('authenticated', STAFF2, `select public.create_sale(p_items => $1::jsonb, p_method => 'cash', p_amount_paid => 0, p_client_id => $2)`,
  [JSON.stringify([{ product_id: P1, qty: 1 }]), ID1]);
ok(stolen && stolen.includes('could not be saved'), "someone else's sale id is refused", stolen);

start1 = await stock(P1);
const shortSale = (await sendSale(STAFF, [{ product_id: P1, qty: start1 + 5 }], 0, crypto.randomUUID(), minutesAgo(60), 'Mama Chidi')).r;
const shortRow = await saleRow(shortSale.id);
ok((await stock(P1)) === 0, 'offline sale bigger than the stock count is saved, and stock stops at 0');
ok(Math.abs(new Date(shortRow.created_at) - (Date.now() - 3600000)) < 5000, 'offline sale is dated when it was made, not when it was sent');
const shortNote = (await sys(`select message from public.activity where kind = 'adjust' order by id desc limit 1`))[0].message;
ok(shortNote.includes('Stock set to 0') && shortNote.includes(shortSale.invoice_no), 'owner gets a note to check the shelf', shortNote);
ok((await sys(`select message from public.activity where ref = $1 and kind = 'sale'`, [shortSale.id]))[0].message.includes('made offline'), 'sale is marked "made offline" in the log');

await as('authenticated', OWNER, `select public.receive_stock($1, 100)`, [P1]);
const before1700 = minutesAgo(10);
await as('authenticated', OWNER, `select public.set_price($1, 1700)`, [P1]);
const saleLog = async id => (await sys(`select message from public.activity where ref = $1 and kind = 'sale'`, [id]))[0].message;
const keep = (await sendSale(STAFF, [{ product_id: P1, qty: 2, price: 1600 }], 3200, crypto.randomUUID(), before1700)).r;
const keepRow = await saleRow(keep.id);
ok(Number(keepRow.total) === 3200 && Number(keepRow.items[0].list_price) === 1600 && !(await saleLog(keep.id)).includes('special price'),
  'offline sale made before a price change is at the old list price, not a special price');
const after = (await sendSale(STAFF, [{ product_id: P1, qty: 2, price: 1600 }], 3000, crypto.randomUUID(), new Date().toISOString(), 'Late Buyer')).r;
const afterRow = await saleRow(after.id);
ok(Number(afterRow.total) === 3200 && Number(afterRow.balance) === 200, 'offline sale made after the change keeps the price on its receipt', `${afterRow.total} ${afterRow.balance}`);
const afterLog = await saleLog(after.id);
ok(afterLog.includes('special price for Table water 75cl: ₦1,600 (list ₦1,700)'), '…and the owner sees it as a special price', afterLog);
const special = (await sale([{ product_id: P1, qty: 1, price: 1500 }], 'cash', 1500)).r;
ok(Number((await saleRow(special.id)).total) === 1500 && (await saleLog(special.id)).includes('special price for Table water 75cl: ₦1,500 (list ₦1,700)'),
  'staff can give a special price, and the owner sees it in the log');
ok((await err('authenticated', STAFF, `select public.create_sale($1::jsonb, 'cash', 0)`, [JSON.stringify([{ product_id: P1, qty: 1, price: -5 }])])) !== null, 'a price below 0 is refused');
ok(Number((await sys(`select price from public.products where id=$1`, [P1]))[0].price) === 1700, "a special price doesn't change the list price");
const future = (await sendSale(STAFF, [{ product_id: P1, qty: 1 }], 1700, crypto.randomUUID(), new Date(Date.now() + 2 * 86400000).toISOString())).r;
ok(new Date((await saleRow(future.id)).created_at) <= new Date(), 'a device clock in the future is not believed');
const old = (await sendSale(STAFF, [{ product_id: P1, qty: 1 }], 1700, crypto.randomUUID(), minutesAgo(30 * 24 * 60))).r;
ok(Math.abs(new Date((await saleRow(old.id)).created_at) - (Date.now() - 7 * 86400000)) < 60000, 'a date more than 7 days back is moved to 7 days back');

const ST = crypto.randomUUID(), p1b = await stock(P1);
for (let i = 0; i < 2; i++) await as('authenticated', STAFF, `select public.receive_stock(p_product => $1, p_qty => 10, p_client_id => $2, p_made_at => $3)`, [P1, ST, minutesAgo(5)]);
ok((await stock(P1)) === p1b + 10 && (await sys(`select count(*)::int c from public.stock_ins where id = $1`, [ST]))[0].c === 1, 'stock received sent twice is saved once');

const PAY = crypto.randomUUID();
for (let i = 0; i < 2; i++) await as('authenticated', OWNER, `select public.record_payment(p_sale => $1, p_amount => 200, p_method => 'cash', p_client_id => $2, p_made_at => $3)`, [after.id, PAY, minutesAgo(1)]);
const paidRow = await saleRow(after.id);
ok(Number(paidRow.balance) === 0 && (await sys(`select count(*)::int c from public.payments where id = $1`, [PAY]))[0].c === 1, 'payment sent twice is saved once (no "already paid" error the second time)');

const archivedOnline = await err('authenticated', STAFF, `select public.create_sale($1::jsonb, 'cash', 0)`, [JSON.stringify([{ product_id: P2, qty: 1 }])]);
ok(archivedOnline && archivedOnline.includes('no longer on the list'), 'removed product cannot be sold online', archivedOnline);
const archivedOffline = (await sendSale(STAFF, [{ product_id: P2, qty: 1 }], 2400.5, crypto.randomUUID(), minutesAgo(2))).r;
ok(!!archivedOffline.invoice_no, 'a sale of a removed product made offline (before it was removed) is still saved');
for (const fn of ['create_sale', 'receive_stock', 'record_payment']) {
  ok((await sys(`select count(*)::int c from pg_proc where proname = $1`, [fn]))[0].c === 1, `only one version of ${fn} exists`);
}

console.log('\nActivity log (as the owner sees it):');
for (const a of (await as('authenticated', OWNER, 'select user_code, kind, message from public.activity order by id')).rows) {
  console.log(`   [${a.user_code}] ${a.kind.padEnd(8)} ${a.message}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

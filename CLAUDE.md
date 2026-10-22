# Storekeeper (Warehouse Manager)

Stock, bulk sales and staff app for a family water and provisions warehouse in Lagos, Nigeria. The owner (the user's mom) is not technical and mostly uses it on her phone. Staff use a computer at the warehouse. Money is in naira (₦).

## Keep it simple (this matters most)

- The owner asked for fewer fields, not more. Don't add form fields, settings or options unless asked.
- Use plain words on screen, with no technical terms. Keep tap targets big.
- Every screen must work at 390px phone width with no sideways scrolling, in light and dark mode.
- These were removed on purpose; don't bring them back unless asked:
  - minimum order quantity
  - a "warn me at" stock level
  - opening stock on Add product (stock goes in with **Add stock**)
- "Running low" is worked out from the last 7 days of sales; see `stockOutlook()` in `app/app.js`.

## How it fits together

### The website: `app/`

- Plain HTML, CSS and JavaScript with no build step and no framework.
- Netlify publishes this folder (see `netlify.toml`). Every push to `main` goes live in about a minute.
- Files:
  - `app/app.js`: all screens and logic.
  - `app/styles.css`: colour tokens for light and dark mode.
  - `app/config.js`: business name, address and phone printed on invoices, plus the Supabase project URL and publishable key. The key is public by design.
  - `app/vendor/supabase.js`: supabase-js 2.117.2 UMD build, vendored.
  - `app/sw.js`: service worker so the site installs like an app. It is network-first. Bump `CACHE` when files are added or renamed.

### The receipt printer

- An Xprinter XP-Q200 (80mm, ESC/POS) on USB at the warehouse computer. The code is the "Receipt printer" section of `app/app.js`.
- It uses WebUSB, so only Chrome and Edge (and Chrome on Android) can print to it. On Windows the printer's driver has to be swapped for WinUSB with Zadig first (SETUP.md, step 9). Without that, `open()` fails with "Access denied".
- Receipts are drawn on a canvas and sent as a picture (`GS v 0`, 576 dots wide), then `GS V B` cuts the paper. Don't switch to text mode: the printer's fonts have no ₦.
- Whether a computer uses the printer is kept in `localStorage` (`receiptPrinter`), because the printer belongs to a computer, not a login. Without it, Print opens the normal print window.
- `test:e2e` swaps in a fake USB printer and saves what it printed as pictures in `tests/shots/` (`10-receipt.png`, `11-receipt-cancelled.png`). Look at them after changing the receipt.

### The database: `supabase-setup.sql`

This one file is the whole database: tables, row level security, and every write as a SECURITY DEFINER function. The functions are `create_sale`, `receive_stock`, `save_product`, `set_price`, `record_payment`, `void_sale`, `create_staff`, `set_staff_active`, `reset_staff_password`, `archive_product`, `log_event`, `setup_owner` and `owner_exists`.

- **The app only reads tables directly.** Add any new behaviour as a function:
  - check permissions inside it with `private.me()` or `private.require_owner()`;
  - write to the activity log with `private.log()`.
- **Permissions:** the owner can do everything. Staff can record sales and stock received and see prices. Staff can't change prices or products, and can't see other people's sales, payments or the activity log. Keep it that way.
- **Logins:**
  - Usernames become `<username>@login.warehouse.invalid`. `private.login_email()` in the SQL and `LOGIN_DOMAIN` in `app.js` must match.
  - Logins are created in SQL by `private.create_login()`.
  - Supabase Auth needs the token columns in `auth.users` to be `''`, not NULL.

## Database changes are NOT deployed automatically

Pushing only updates the website. After changing `supabase-setup.sql`, tell the user plainly that it must be re-run: Supabase → SQL Editor → paste the whole file → Run.

- The script must stay safe to re-run on the live database:
  - use `create ... if not exists`, `create or replace function` and `drop policy if exists`;
  - never drop tables or data.
- If you change a function's parameters, add `drop function if exists public.<name>(<old argument types>);` before it (see `save_product`). Otherwise Postgres keeps both versions.
- If an app change needs new SQL, ship both together and say so. The app shows "The database needs updating…" when a function it calls is missing.

## Tests: run before every push

```
cd tests && npm install
npm run test:db    # database rules on an in-memory Postgres (about 10 seconds)
npm run test:e2e   # whole app in headless Chromium against a local stand-in for Supabase (1–2 minutes)
```

- `test:e2e` saves screenshots in `tests/shots/`. Look at them after UI changes.
- `test:e2e` needs Playwright's Chromium; run `npx playwright install chromium` if it's missing.
- It starts a real Postgres through embedded-postgres. When run as root, embedded-postgres creates a `postgres` system user, which must be able to reach the repo folder.
- Update the tests when behaviour changes, and add a check for every new rule.
- `tests/` has its own `package.json` on purpose, so Netlify doesn't install test tools when it publishes.

## Words the owner sees

- Use short, plain sentences.
- Name buttons after what they do, e.g. "Add stock" and "Change price".
- Error messages say what went wrong and what to do next.

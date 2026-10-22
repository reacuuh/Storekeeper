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

- An Xprinter XP-Q200 (80mm, ESC/POS) on USB at the warehouse computer. Its Windows driver names it "XP-80C". The code is the "Receipt printer" section of `app/app.js`.
- `receiptCanvas()` draws the receipt as a black-and-white picture, 576 dots wide. Don't switch to the printer's text mode: its fonts have no ₦.
- Print receipt picks one of three ways, in this order:
  1. In the Windows app (`window.desktop` exists): a RAW job to the Windows printer saved in `localStorage` `receiptPrinterName`.
  2. In Chrome or Edge with a USB printer connected (`localStorage` `receiptPrinter` is `'1'`): WebUSB. On Windows that needs the Zadig driver swap (SETUP.md, step 9); without it `open()` fails with "Access denied".
  3. Otherwise `printInBrowser()`: the print window with only the receipt picture, on one 80mm page as long as the receipt.
- Ways 1 and 2 send the picture as `GS v 0` bands, then `GS V B` cuts the paper.
- The printer choice is kept in `localStorage` because the printer belongs to a computer, not a login.
- `test:e2e` fakes both the USB printer and the Windows app. It saves what they were sent as pictures (`tests/shots/10-receipt.png`, `11-receipt-cancelled.png`) and what the print window gets as `14-print-window.pdf`. Look at them after changing the receipt.

### The Windows app: `desktop/`

- Electron, with its own `package.json` like `tests/`. It opens the live site (`SITE` in `desktop/main.js`), so website changes reach it without a new installer. Only changes inside `desktop/` need one: raise `version`, then `npm run dist`.
- `desktop/preload.js` gives the site `window.desktop` with `printers()`, `print(name, bytes)` and `retry()`. That is the whole bridge; keep it small.
- `desktop/main.js` only answers `printers` and `print` for pages on the site's own origin, only prints to printers installed in Windows, opens every other link in the normal browser, and refuses all permission requests. Keep those checks.
- `desktop/rawprint.js` sends the bytes as a RAW job through `winspool.drv` (via koffi), so the driver passes the ESC/POS commands through untouched.
- `npm run check` in `desktop/` tests `rawprint.js` by printing to Windows' "Generic / Text Only" printer with the output sent to a file. Never test by printing to a real printer queue: the job waits there and prints the next time the printer is switched on.
- The installer isn't code-signed, so Windows shows "Windows protected your PC" the first time.

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

# Storekeeper: setup guide

Storekeeper runs in a web browser and installs like normal software on the warehouse computer and on a phone. Your mom logs in as the **owner** and controls everything. Each staff member gets their own login with a staff ID (STF-001, STF-002 …).

Everything here is free. You need:

- a **GitHub** account (holds the app's files)
- a **Supabase** account (the database)
- a **Netlify** account (puts the app online and updates it whenever the files on GitHub change)

---

## 1. Create a Supabase project

1. Go to **supabase.com** and sign up.
2. Click **New project** and give it a name, e.g. `warehouse`.
3. Set a database password and **write it down somewhere safe**. The app doesn't use it, but you'll need it if you ever ask Supabase for help.
4. For **Region**, pick one close to Nigeria, e.g. a European region such as London.
5. Click **Create new project** and wait a minute or two until it's ready.

## 2. Create (or update) the database

1. In your project, open **SQL Editor** (left menu) and click **New query**.
2. Open `supabase-setup.sql` (on GitHub, open the file and click the **copy** button), and paste it into the SQL editor.
3. Click **Run**. If Supabase warns about "destructive operations", confirm and run it anyway. The warning is about the permission rules the script sets up.
4. You should see **Success. No rows returned**.

**Run it again whenever `supabase-setup.sql` changes.** It's safe to re-run: it updates the rules and never deletes data. If the app ever says "The database needs updating", this is the fix.

## 3. Turn off public sign-ups

Staff logins are created by the owner inside the app, so nobody should be able to sign themselves up.

1. Go to **Authentication** in the left menu, then the **Sign In / Providers** settings.
2. Turn **off** "Allow new users to sign up" and save.

## 4. Business details and database connection

`app/config.js` holds:

- `businessName`, `businessAddress`, `businessPhone`: printed on every invoice
- `supabaseUrl` and `supabaseKey`: your Supabase project URL and publishable key (already filled in for your project)

The key is meant to be public. What each person can see or change is decided by the database rules from step 2, based on who is logged in.

## 5. Put the app online with Netlify

1. Go to **app.netlify.com** and sign up (signing in with GitHub is easiest).
2. Choose **Add new project → Import an existing project → GitHub** and pick the **Storekeeper** repository.
3. Leave the settings as they are and click **Deploy**. Netlify reads `netlify.toml` and publishes the `app` folder.
4. You get a web address like `https://random-name-123.netlify.app`. In the project settings you can change the name, e.g. `adebayo-warehouse.netlify.app`.

From now on, every change saved to GitHub goes live by itself in about a minute.

If you already have a Netlify site from dragging the folder, open it and use **Link repository** (under the project's build and deploy settings) instead, so you keep the same web address.

## 6. Create the owner account (do this straight away)

1. Open the web address.
2. You'll see **Create the owner account**. Enter your mom's name, a username (e.g. `mummy`) and a password.
3. That's it. She's logged in as the owner.

Do this right after putting the app online. Until the owner account exists, anyone who opens the link could create it.

## 7. Install it on the computer and on her phone

- **Warehouse computer (Chrome or Edge):** open the web address, then click the **install** icon at the right end of the address bar (or the ⋮ menu → **Install** / **Save and share → Install page as app**). It then opens from the desktop like normal software.
- **Android phone (Chrome):** open the web address, tap ⋮ → **Add to Home screen** → **Install**.
- **iPhone (Safari):** open the web address, tap the **Share** button → **Add to Home Screen**.

## 8. Add products and staff

As the owner:

1. **Products & prices → Add product.** Enter the name, what it's sold in (carton, pack, bag …) and the price.
2. On the product, tap **Add stock** and enter how many you have. Do the same whenever goods arrive.
3. **Staff → Add staff.** Enter a name, username and password. The app gives each person a staff ID (STF-001, STF-002 …) and shows the login details to hand over.

## 9. Receipt printer (Xprinter XP-Q200)

The app prints receipts straight to a USB receipt printer, and the paper cuts itself. This works in **Chrome or Edge** on the warehouse computer. Do this once on each computer that has the printer.

**First, a one-time driver swap (Windows only).** Windows normally keeps the printer to itself, so the browser can't reach it. A free tool called Zadig hands it over:

1. Plug the printer's USB cable into the computer and switch the printer on.
2. Download Zadig from **zadig.akeo.ie** and open it. Click **Yes** if Windows asks for permission.
3. In Zadig, open the **Options** menu and tick **List All Devices**.
4. Pick the printer from the drop-down list. It may be called something like "XP-Q200", "Printer" or "USB Printing Support". If you're not sure, unplug the printer: the one that disappears from the list is the printer. Plug it back in and pick it.
5. Make sure the box to the right of the green arrow says **WinUSB**, then click **Replace Driver** (or **Install Driver**). Wait until it says it worked.
6. Unplug the printer and plug it back in.

After this, the printer only prints from Chrome or Edge, not from other programs such as Word. To undo it, open **Device Manager**, right-click the printer, choose **Uninstall device** and tick **Attempt to remove the driver**. Then unplug the printer, plug it back in and install the Xprinter driver again.

**Then connect it in the app:**

1. Open the app and log in.
2. Click **Receipt printer** at the bottom of the left menu (on a phone it's under **More**).
3. Click **Connect printer**, pick the printer from the list and click **Connect**.
4. Click **Print test**. A short test slip should print and cut.

From now on, every invoice on this computer has a **Print receipt** button. If the app says the printer isn't connected, check it's switched on and plugged in.

An Android phone or tablet with Chrome can use the printer too, through a USB OTG cable, and doesn't need the driver swap. iPhones can't use USB printers from a web app.

---

## Making changes with Claude Code

1. Open **claude.ai/code** (or the **Code** tab in the Claude desktop app) and choose the **Storekeeper** repository.
2. Describe the change in plain words, e.g. "show yesterday's sales on the Home screen" or "let staff record money customers pay later".
3. Claude reads `CLAUDE.md` first, makes the change, runs the automatic checks and saves it to GitHub. Netlify publishes it about a minute later.

If a change touches `supabase-setup.sql`, Claude will say so. Then re-run the file in Supabase (step 2).

---

## Who can do what

| | Owner | Staff |
|---|---|---|
| Record sales and print or WhatsApp invoices | ✓ | ✓ |
| Record stock received | ✓ | ✓ |
| See products and prices | ✓ | ✓ |
| Change prices, add or edit products, correct stock | ✓ | |
| Give a special price | ✓ | |
| Record money paid later on credit sales | ✓ | |
| Cancel a sale (stock goes back automatically) | ✓ | |
| See everyone's sales, the Home dashboard and the Activity log | ✓ | own sales only |
| Add staff, set new passwords, switch logins off | ✓ | |

Every sale, delivery, price change, payment, login and staff change is written to the **Activity** log automatically. Nobody can edit or delete it. The owner's Home screen shows **Live** when it's updating by itself.

## Good to know

- **Running low** on the Home screen is worked out from the last 7 days of sales: a product shows up when what's left would last less than a week, or when it's out of stock.
- **Internet is needed to save a sale.** The stock check happens on the database, so two people can never sell the same last carton.
- **If the app stops loading:** free Supabase projects are paused after about a week with little or no use. Daily use keeps it awake. If it does pause (e.g. after a long holiday), log in to supabase.com, open the project and click **Resume project**. All the data comes back.
- **Staff member forgot their password:** owner goes to **Staff → New password**.
- **Owner forgot her password:** in Supabase, open **SQL Editor → New query**, paste this (with her username and a new password), and click **Run**:

  ```sql
  update auth.users
  set encrypted_password = extensions.crypt('NEW-PASSWORD-HERE', extensions.gen_salt('bf', 10))
  where email = 'USERNAME-HERE@login.warehouse.invalid';
  ```

- **Someone leaves:** **Staff → Switch off**. Their login stops working straight away, even on a device that's already logged in. Their past sales stay on record.
- **Keeping a copy of the records:** once a month, in Supabase open **Table Editor**, choose `sales` (and `products`, `stock_ins`), and use **Export → Export to CSV**. The files open in Excel.
- **If creating the owner account shows "permission denied":** Supabase has changed one of its internal rules. Note the exact message shown on the screen and get help before going further.

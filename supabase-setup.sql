-- =====================================================================
--  WAREHOUSE MANAGER — database setup for Supabase
--
--  How to use: Supabase dashboard → SQL Editor → New query →
--  paste this whole file → Run. It is safe to run again later.
--
--  How it works, in short:
--  * The app only READS tables directly. Every change (a sale, stock
--    received, a price change, new staff…) goes through one of the
--    functions below, which checks who is asking and writes the
--    activity log at the same time. Staff cannot skip the log or
--    change the list prices, even with technical tricks.
--  * Owner: can do everything. Staff: record sales and stock received,
--    see prices, see only their own sales.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;   -- helper functions, not reachable from the app

-- ---------------------------------------------------------------------
--  TABLES
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique,
  name        text not null,
  phone       text,
  role        text not null check (role in ('owner', 'staff')),
  staff_code  text not null unique,          -- OWNER, STF-001, STF-002 …
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.products (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  unit           text not null default 'carton',
  price          numeric(14,2) not null default 0 check (price >= 0),
  qty            numeric(12,2) not null default 0 check (qty >= 0),
  min_order      integer not null default 1 check (min_order >= 1),
  reorder_level  integer not null default 0 check (reorder_level >= 0),
  archived       boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- The price before the last change, and when it changed. A sale made without internet
-- before the change is compared with the old price, so it isn't noted as a special price.
alter table public.products add column if not exists prev_price numeric(14,2);
alter table public.products add column if not exists price_changed_at timestamptz;

create table if not exists public.customers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text,
  created_at  timestamptz not null default now()
);
create unique index if not exists customers_name_key on public.customers (lower(name));

create table if not exists public.sales (
  id              uuid primary key default gen_random_uuid(),
  invoice_no      text not null unique,
  customer_id     uuid references public.customers(id) on delete set null,
  customer_name   text,
  customer_phone  text,
  items           jsonb not null,            -- [{product_id, name, unit, qty, price, list_price, total}]
  total           numeric(14,2) not null,
  amount_paid     numeric(14,2) not null default 0,
  balance         numeric(14,2) not null default 0,
  method          text not null,             -- cash | transfer | pos | credit
  note            text,
  status          text not null default 'ok' check (status in ('ok', 'void')),
  void_reason     text,
  sold_by         uuid not null references public.profiles(id),
  sold_by_name    text not null,
  sold_by_code    text not null,
  created_at      timestamptz not null default now()
);
create index if not exists sales_created_idx on public.sales (created_at desc);
create index if not exists sales_sold_by_idx on public.sales (sold_by, created_at desc);
create index if not exists sales_owing_idx   on public.sales (balance) where balance > 0;

create table if not exists public.payments (
  id                uuid primary key default gen_random_uuid(),
  sale_id           uuid not null references public.sales(id) on delete cascade,
  amount            numeric(14,2) not null,  -- negative = refund
  method            text not null,           -- cash | transfer | pos | refund
  received_by       uuid references public.profiles(id),
  received_by_name  text,
  created_at        timestamptz not null default now()
);
create index if not exists payments_created_idx on public.payments (created_at desc);

create table if not exists public.stock_ins (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid references public.products(id) on delete set null,
  product_name      text not null,
  unit              text not null,
  qty               numeric(12,2) not null check (qty > 0),
  cost_per_unit     numeric(14,2),
  supplier          text,
  note              text,
  received_by       uuid not null references public.profiles(id),
  received_by_name  text not null,
  received_by_code  text not null,
  created_at        timestamptz not null default now()
);
create index if not exists stock_ins_created_idx on public.stock_ins (created_at desc);

-- Quantities can be in quarters (½ carton, 1¼ bags). Older databases had whole numbers only.
alter table public.products  alter column qty type numeric(12,2);
alter table public.stock_ins alter column qty type numeric(12,2);

create table if not exists public.activity (
  id          bigint generated always as identity primary key,
  user_id     uuid references public.profiles(id),
  user_name   text,
  user_code   text,
  user_role   text,
  kind        text not null,                 -- sale, payment, stock, adjust, price, product, staff, login
  message     text not null,
  ref         uuid,
  created_at  timestamptz not null default now()
);
create index if not exists activity_created_idx on public.activity (created_at desc);

create sequence if not exists public.invoice_seq;
create sequence if not exists public.staff_seq;

-- ---------------------------------------------------------------------
--  HELPERS (private)
-- ---------------------------------------------------------------------

-- Usernames become login emails behind the scenes. ".invalid" is a reserved
-- domain, so no email can ever be sent to these addresses.
create or replace function private.login_email(p_username text) returns text
language sql immutable set search_path = '' as $$
  select lower(trim(p_username)) || '@login.warehouse.invalid';
$$;

create or replace function private.is_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function private.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'owner');
$$;

create or replace function private.me() returns public.profiles
language plpgsql stable security definer set search_path = '' as $$
declare v public.profiles;
begin
  select * into v from public.profiles where id = auth.uid() and active;
  if not found then
    raise exception 'Your account is not allowed to do this. Ask the owner.' using errcode = '42501';
  end if;
  return v;
end $$;

create or replace function private.require_owner() returns public.profiles
language plpgsql stable security definer set search_path = '' as $$
declare v public.profiles := private.me();
begin
  if v.role <> 'owner' then
    raise exception 'Only the owner can do this.' using errcode = '42501';
  end if;
  return v;
end $$;

create or replace function private.naira(v numeric) returns text
language sql immutable set search_path = '' as $$
  select '₦' || case when v = trunc(v) then to_char(v, 'FM999,999,999,999,990')
                     else to_char(v, 'FM999,999,999,999,990.00') end;
$$;

-- Quantities are whole numbers or quarters: 3, ½, 2¾ …
create or replace function private.is_quarters(n numeric) returns boolean
language sql immutable set search_path = '' as $$
  select n * 4 = trunc(n * 4);
$$;

-- 1200 → "1,200", 9.5 → "9½", 0.25 → "¼"
create or replace function private.qty_text(n numeric) returns text
language sql immutable set search_path = '' as $$
  select case when trunc(n) = 0 and n <> 0 then '' else to_char(trunc(n), 'FM999,999,999,990') end
      || case round((n - trunc(n)) * 4) when 1 then '¼' when 2 then '½' when 3 then '¾' else '' end;
$$;

-- This used to take whole numbers only; remove that version so the one below is used.
drop function if exists private.units(integer, text);
create or replace function private.units(n numeric, unit text) returns text
language sql immutable set search_path = '' as $$
  select private.qty_text(n) || ' ' || unit ||
         case when n > 0 and n <= 1 then ''   -- 1 carton, ½ carton, 1½ cartons
              when unit ~ '(s|x|z|ch|sh)$' then 'es'
              else 's' end;
$$;

create or replace function private.log(p_me public.profiles, p_kind text, p_message text, p_ref uuid default null)
returns void language sql security definer set search_path = '' as $$
  insert into public.activity (user_id, user_name, user_code, user_role, kind, message, ref)
  values (p_me.id, p_me.name, p_me.staff_code, p_me.role, p_kind, p_message, p_ref);
$$;

-- When something saved without internet really happened, as the device reports it.
-- Never in the future and never more than 7 days back, so a wrong clock can't move it far.
create or replace function private.made_at(p timestamptz) returns timestamptz
language sql stable set search_path = '' as $$
  select case when p is null then now() else least(greatest(p, now() - interval '7 days'), now()) end;
$$;

create or replace function private.lagos_time(t timestamptz) returns text
language sql stable set search_path = '' as $$
  select to_char(t at time zone 'Africa/Lagos', 'FMDD Mon, HH24:MI');
$$;

-- Creates a Supabase login (auth user) for a username + password.
create or replace function private.create_login(p_username text, p_password text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id    uuid := gen_random_uuid();
  v_email text := private.login_email(p_username);
begin
  if p_username is null or p_username !~ '^[a-z0-9._-]{3,30}$' then
    raise exception 'Username must be 3 to 30 letters or numbers, with no spaces.';
  end if;
  if length(coalesce(p_password, '')) < 6 then
    raise exception 'Password must be at least 6 characters.';
  end if;
  if exists (select 1 from public.profiles where username = p_username)
     or exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'The username "%" is already taken. Pick another one.', p_username;
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_current, email_change_token_new,
    email_change, phone_change_token, phone_change, reauthentication_token, email_change_confirm_status
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf', 10)), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
    '', '', '', '', '', '', '', '', 0
  );
  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text, 'email',
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
          now(), now(), now());
  return v_id;
end $$;

-- ---------------------------------------------------------------------
--  FIRST-TIME SETUP
-- ---------------------------------------------------------------------
create or replace function public.owner_exists() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where role = 'owner');
$$;

create or replace function public.setup_owner(p_name text, p_username text, p_password text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user text := lower(trim(coalesce(p_username, '')));
  v_name text := trim(coalesce(p_name, ''));
  v_id   uuid;
  v_me   public.profiles;
begin
  perform pg_advisory_xact_lock(7340001);
  if exists (select 1 from public.profiles where role = 'owner') then
    raise exception 'The owner account already exists. Please log in.';
  end if;
  if v_name = '' then raise exception 'Enter the owner''s name.'; end if;
  v_id := private.create_login(v_user, p_password);
  insert into public.profiles (id, username, name, role, staff_code)
  values (v_id, v_user, v_name, 'owner', 'OWNER')
  returning * into v_me;
  perform private.log(v_me, 'staff', 'Created the owner account');
end $$;

-- ---------------------------------------------------------------------
--  STAFF (owner only)
-- ---------------------------------------------------------------------
create or replace function public.create_staff(p_name text, p_username text, p_password text, p_phone text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_me   public.profiles := private.require_owner();
  v_user text := lower(trim(coalesce(p_username, '')));
  v_name text := trim(coalesce(p_name, ''));
  v_id   uuid;
  v_code text;
begin
  if v_name = '' then raise exception 'Enter the staff member''s name.'; end if;
  v_id := private.create_login(v_user, p_password);
  v_code := 'STF-' || lpad(nextval('public.staff_seq')::text, 3, '0');
  insert into public.profiles (id, username, name, phone, role, staff_code)
  values (v_id, v_user, v_name, nullif(trim(coalesce(p_phone, '')), ''), 'staff', v_code);
  perform private.log(v_me, 'staff', format('Added staff %s (%s, @%s)', v_name, v_code, v_user), v_id);
  return v_code;
end $$;

create or replace function public.set_staff_active(p_user uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles := private.require_owner();
  v_t  public.profiles;
begin
  select * into v_t from public.profiles where id = p_user for update;
  if not found or v_t.role <> 'staff' then raise exception 'Staff member not found.'; end if;
  update public.profiles set active = coalesce(p_active, false) where id = p_user;
  -- a switched-off login cannot sign in or stay signed in
  update auth.users
     set banned_until = case when p_active then null else now() + interval '100 years' end,
         updated_at = now()
   where id = p_user;
  perform private.log(v_me, 'staff',
    format('%s the login for %s (%s)', case when p_active then 'Switched on' else 'Switched off' end, v_t.name, v_t.staff_code), p_user);
end $$;

create or replace function public.reset_staff_password(p_user uuid, p_password text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles := private.require_owner();
  v_t  public.profiles;
begin
  if length(coalesce(p_password, '')) < 6 then raise exception 'Password must be at least 6 characters.'; end if;
  select * into v_t from public.profiles where id = p_user;
  if not found or v_t.role <> 'staff' then raise exception 'Staff member not found.'; end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)), updated_at = now()
   where id = p_user;
  perform private.log(v_me, 'staff', format('Set a new password for %s (%s)', v_t.name, v_t.staff_code), p_user);
end $$;

-- ---------------------------------------------------------------------
--  PRODUCTS & PRICES (owner only)
-- ---------------------------------------------------------------------
-- An earlier version of this function also took a minimum order and a warning
-- level. Remove it so only the simple version below exists.
drop function if exists public.save_product(uuid, text, text, numeric, integer, integer, integer, text);
-- ...and the version that took whole-number stock counts only.
drop function if exists public.save_product(uuid, text, text, numeric, integer, text);

-- Add a product (p_id null) or edit one. New products start with 0 in stock;
-- stock is added with receive_stock. p_qty is only for correcting a wrong count.
create or replace function public.save_product(
  p_id uuid, p_name text, p_unit text, p_price numeric, p_qty numeric default null, p_reason text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_me      public.profiles := private.require_owner();
  v_old     public.products;
  v_new     public.products;
  v_name    text := trim(coalesce(p_name, ''));
  v_unit    text := lower(trim(coalesce(p_unit, '')));
  v_reason  text := nullif(trim(coalesce(p_reason, '')), '');
  v_changes text[] := '{}';
begin
  if v_name = '' then raise exception 'Enter the product name.'; end if;
  if v_unit = '' then v_unit := 'unit'; end if;
  if p_price is null or p_price < 0 then raise exception 'Enter a price of 0 or more.'; end if;
  if p_qty is not null and p_qty < 0 then raise exception 'Stock count cannot be below 0.'; end if;
  if p_qty is not null and not private.is_quarters(p_qty) then raise exception 'Quantities can be whole numbers or quarters, like 2, ½ or 1¼.'; end if;

  if p_id is null then
    insert into public.products (name, unit, price, qty)
    values (v_name, v_unit, p_price, coalesce(p_qty, 0))
    returning * into v_new;
    perform private.log(v_me, 'product',
      format('Added product %s at %s per %s%s', v_name, private.naira(v_new.price), v_unit,
             case when v_new.qty > 0 then ', with ' || private.units(v_new.qty, v_unit) || ' in stock' else '' end),
      v_new.id);
    return v_new.id;
  end if;

  select * into v_old from public.products where id = p_id and not archived for update;
  if not found then raise exception 'Product not found.'; end if;
  if p_qty is not null and p_qty <> v_old.qty and v_reason is null then
    raise exception 'Please say why the stock count changed.';
  end if;

  update public.products
     set name = v_name, unit = v_unit, price = p_price, qty = coalesce(p_qty, qty), updated_at = now(),
         prev_price       = case when p_price <> price then price else prev_price end,
         price_changed_at = case when p_price <> price then now() else price_changed_at end
   where id = p_id
  returning * into v_new;

  if v_new.price <> v_old.price then
    perform private.log(v_me, 'price',
      format('Changed price of %s: %s → %s per %s', v_name, private.naira(v_old.price), private.naira(v_new.price), v_unit), p_id);
  end if;
  if v_new.qty <> v_old.qty then
    perform private.log(v_me, 'adjust',
      format('Corrected stock of %s: %s → %s (%s)', v_name, private.units(v_old.qty, v_unit), private.units(v_new.qty, v_unit), v_reason), p_id);
  end if;
  if v_new.name <> v_old.name then v_changes := v_changes || format('renamed from "%s"', v_old.name); end if;
  if v_new.unit <> v_old.unit then v_changes := v_changes || format('now sold per %s (was %s)', v_new.unit, v_old.unit); end if;
  if coalesce(array_length(v_changes, 1), 0) > 0 then
    perform private.log(v_me, 'product', format('Edited %s: %s', v_name, array_to_string(v_changes, ', ')), p_id);
  end if;
  return p_id;
end $$;

create or replace function public.set_price(p_id uuid, p_price numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me  public.profiles := private.require_owner();
  v_old public.products;
  v_new public.products;
begin
  if p_price is null or p_price < 0 then raise exception 'Enter a price of 0 or more.'; end if;
  select * into v_old from public.products where id = p_id and not archived for update;
  if not found then raise exception 'Product not found.'; end if;
  update public.products
     set price = p_price, updated_at = now(),
         prev_price       = case when p_price <> price then price else prev_price end,
         price_changed_at = case when p_price <> price then now() else price_changed_at end
   where id = p_id returning * into v_new;
  if v_new.price <> v_old.price then
    perform private.log(v_me, 'price',
      format('Changed price of %s: %s → %s per %s', v_new.name, private.naira(v_old.price), private.naira(v_new.price), v_new.unit), p_id);
  end if;
end $$;

create or replace function public.archive_product(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles := private.require_owner();
  v_p  public.products;
begin
  update public.products set archived = true, updated_at = now() where id = p_id and not archived returning * into v_p;
  if not found then raise exception 'Product not found.'; end if;
  perform private.log(v_me, 'product', format('Removed %s from the product list (%s were left in stock)', v_p.name, private.units(v_p.qty, v_p.unit)), p_id);
end $$;

-- ---------------------------------------------------------------------
--  SAVING WITHOUT INTERNET
--  Sales, stock received and payments made without internet wait on the
--  device and are sent later. For these three functions:
--  * p_client_id is the id the app picked for the new row. If it is sent
--    twice (the answer got lost), it is only saved once.
--  * p_made_at is set when it was saved on the device first. It is when it
--    really happened, and the change is marked "made offline" in the log.
-- ---------------------------------------------------------------------

-- These used to have fewer parameters (and receive_stock took whole numbers only).
-- Remove the old versions so only one of each exists.
drop function if exists public.receive_stock(uuid, integer, numeric, text, text);
drop function if exists public.receive_stock(uuid, integer, numeric, text, text, uuid, timestamptz);
drop function if exists public.create_sale(jsonb, text, numeric, text, text, text);
drop function if exists public.record_payment(uuid, numeric, text);

-- ---------------------------------------------------------------------
--  STOCK RECEIVED (owner and staff)
-- ---------------------------------------------------------------------
create or replace function public.receive_stock(
  p_product uuid, p_qty numeric, p_cost numeric default null, p_supplier text default null, p_note text default null,
  p_client_id uuid default null, p_made_at timestamptz default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me   public.profiles := private.me();
  v_p    public.products;
  v_sup  text := nullif(trim(coalesce(p_supplier, '')), '');
  v_when timestamptz := private.made_at(p_made_at);
begin
  if p_qty is null or p_qty <= 0 then raise exception 'Enter how many came in.'; end if;
  if not private.is_quarters(p_qty) then raise exception 'Quantities can be whole numbers or quarters, like 2, ½ or 1¼.'; end if;
  if p_cost is not null and p_cost < 0 then raise exception 'Cost cannot be below 0.'; end if;
  -- Two copies arriving together: the second one fails on the id below and changes nothing.
  if p_client_id is not null and exists (select 1 from public.stock_ins where id = p_client_id) then return; end if;
  -- Goods that arrived while the device was offline still count if the product was removed meanwhile.
  update public.products set qty = qty + p_qty, updated_at = now()
   where id = p_product and (not archived or p_made_at is not null)
  returning * into v_p;
  if not found then raise exception 'Product not found.'; end if;
  insert into public.stock_ins (id, product_id, product_name, unit, qty, cost_per_unit, supplier, note,
                                received_by, received_by_name, received_by_code, created_at)
  values (coalesce(p_client_id, gen_random_uuid()), v_p.id, v_p.name, v_p.unit, p_qty, p_cost, v_sup, nullif(trim(coalesce(p_note, '')), ''),
          v_me.id, v_me.name, v_me.staff_code, v_when);
  perform private.log(v_me, 'stock',
    format('Received %s of %s%s%s', private.units(p_qty, v_p.unit), v_p.name,
           case when v_sup is not null then ' from ' || v_sup else '' end,
           case when p_made_at is not null then ' · made offline ' || private.lagos_time(v_when) else '' end), v_p.id);
end $$;

-- ---------------------------------------------------------------------
--  SALES (owner and staff)
--  p_items: [{"product_id": "...", "qty": 10, "price": 1200}]
--  Without a price an item sells at the list price. The owner and staff may
--  both give a special price; each one is noted in the activity log, so the
--  owner can see who sold below (or above) the list price.
--  A sale made without internet (p_made_at set) has already happened: the
--  goods are gone and the customer has a receipt. So a stock count that is
--  too low doesn't stop it (stock stops at 0 and the owner gets a note), and
--  it is compared with the list price of the time it was made.
-- ---------------------------------------------------------------------
create or replace function public.create_sale(
  p_items jsonb, p_method text, p_amount_paid numeric,
  p_customer_name text default null, p_customer_phone text default null, p_note text default null,
  p_client_id uuid default null, p_made_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me      public.profiles := private.me();
  v_offline boolean := p_made_at is not null;
  v_when    timestamptz := private.made_at(p_made_at);
  v_old     public.sales;
  v_item    record;
  v_prod    public.products;
  v_qty     numeric;
  v_line    numeric(14,2);
  v_price   numeric(14,2);
  v_list    numeric(14,2);
  v_lines   jsonb := '[]'::jsonb;
  v_total   numeric(14,2) := 0;
  v_paid    numeric(14,2);
  v_sale_id uuid := coalesce(p_client_id, gen_random_uuid());
  v_invoice text;
  v_cust    uuid;
  v_name    text := nullif(trim(coalesce(p_customer_name, '')), '');
  v_phone   text := nullif(trim(coalesce(p_customer_phone, '')), '');
  v_desc    text;
  v_notes   text[] := '{}';
  v_short   jsonb := '[]'::jsonb;
  v_s       jsonb;
begin
  if p_method is null or p_method not in ('cash', 'transfer', 'pos', 'credit') then
    raise exception 'Choose how the customer is paying.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item.';
  end if;

  -- lock every product in this sale, always in the same order
  perform 1 from public.products
   where id in (select (t.e->>'product_id')::uuid from jsonb_array_elements(p_items) as t(e))
   order by id
   for update;

  -- Sent before? Checked after the locks, so two copies arriving together are
  -- handled one after the other and the second one finds the first.
  if p_client_id is not null then
    select * into v_old from public.sales where id = p_client_id;
    if found then
      if v_old.sold_by <> v_me.id then raise exception 'This sale could not be saved. Try again.'; end if;
      return jsonb_build_object('id', v_old.id, 'invoice_no', v_old.invoice_no);
    end if;
  end if;

  for v_item in select t.e, t.ord from jsonb_array_elements(p_items) with ordinality as t(e, ord) order by t.ord loop
    v_qty := (v_item.e->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Every item needs a quantity.'; end if;
    if not private.is_quarters(v_qty) then raise exception 'Quantities can be whole numbers or quarters, like 2, ½ or 1¼.'; end if;

    select * into v_prod from public.products where id = (v_item.e->>'product_id')::uuid and (not archived or v_offline);
    if not found then raise exception 'A product in this sale is no longer on the list. Remove it and try again.'; end if;

    if v_prod.qty < v_qty then
      if not v_offline then
        raise exception 'Only % of % left in stock.', private.units(v_prod.qty, v_prod.unit), v_prod.name;
      end if;
      v_short := v_short || jsonb_build_array(jsonb_build_object('id', v_prod.id, 'name', v_prod.name, 'unit', v_prod.unit, 'had', v_prod.qty, 'sold', v_qty));
    end if;

    -- An offline sale made before the owner's last price change was at the old list price.
    v_list := case when v_offline and v_when < v_prod.price_changed_at then coalesce(v_prod.prev_price, v_prod.price) else v_prod.price end;
    v_price := case when jsonb_typeof(v_item.e->'price') = 'number' then (v_item.e->>'price')::numeric else v_list end;
    if v_price < 0 then raise exception 'Price cannot be below 0.'; end if;
    if v_price <> v_list then
      v_notes := v_notes || format('special price for %s: %s (list %s)', v_prod.name, private.naira(v_price), private.naira(v_list));
    end if;

    update public.products set qty = greatest(qty - v_qty, 0), updated_at = now() where id = v_prod.id;

    v_line := round(v_qty * v_price, 2);   -- ¼ of ₦2,400.50 is ₦600.13, on the line and in the total
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_prod.id, 'name', v_prod.name, 'unit', v_prod.unit, 'qty', v_qty,
      'price', v_price, 'list_price', v_list, 'total', v_line));
    v_total := v_total + v_line;
  end loop;

  v_paid := least(greatest(coalesce(p_amount_paid, 0), 0), v_total);
  if v_paid < v_total and v_name is null then
    raise exception 'This customer still owes money. Enter their name so you can follow up.';
  end if;

  if v_name is not null then
    insert into public.customers (name, phone) values (v_name, v_phone)
    on conflict ((lower(name))) do update set phone = coalesce(excluded.phone, public.customers.phone)
    returning id, name, phone into v_cust, v_name, v_phone;   -- keep the customer's saved spelling
  end if;

  v_invoice := 'INV-' || lpad(nextval('public.invoice_seq')::text, 5, '0');

  insert into public.sales (id, invoice_no, customer_id, customer_name, customer_phone, items, total,
                            amount_paid, balance, method, note, sold_by, sold_by_name, sold_by_code, created_at)
  values (v_sale_id, v_invoice, v_cust, v_name, v_phone, v_lines, v_total,
          v_paid, v_total - v_paid, p_method, nullif(trim(coalesce(p_note, '')), ''),
          v_me.id, v_me.name, v_me.staff_code, v_when);

  if v_paid > 0 then
    insert into public.payments (sale_id, amount, method, received_by, received_by_name, created_at)
    values (v_sale_id, v_paid, case when p_method = 'credit' then 'cash' else p_method end, v_me.id, v_me.name, v_when);
  end if;

  select string_agg(private.units((t.l->>'qty')::numeric, t.l->>'unit') || ' of ' || (t.l->>'name'), ', ')
    into v_desc from jsonb_array_elements(v_lines) as t(l);
  perform private.log(v_me, 'sale',
    format('Sold %s to %s for %s%s · %s%s%s', v_desc, coalesce(v_name, 'a walk-in customer'), private.naira(v_total),
           case when v_total > v_paid then ' (owes ' || private.naira(v_total - v_paid) || ')' else '' end, v_invoice,
           case when v_offline then ' · made offline ' || private.lagos_time(v_when) else '' end,
           case when cardinality(v_notes) > 0 then ' · ' || array_to_string(v_notes, '; ') else '' end),
    v_sale_id);

  for v_s in select t.e from jsonb_array_elements(v_short) as t(e) loop
    perform private.log(v_me, 'adjust',
      format('%s: the count showed %s, but %s (made offline) sold %s. Stock set to 0. Please check the shelf.',
             v_s->>'name', private.units((v_s->>'had')::numeric, v_s->>'unit'), v_invoice,
             private.units((v_s->>'sold')::numeric, v_s->>'unit')),
      (v_s->>'id')::uuid);
  end loop;

  return jsonb_build_object('id', v_sale_id, 'invoice_no', v_invoice);
end $$;

-- Money received later for a sale that was not fully paid (owner only)
create or replace function public.record_payment(
  p_sale uuid, p_amount numeric, p_method text, p_client_id uuid default null, p_made_at timestamptz default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_me   public.profiles := private.require_owner();
  v_s    public.sales;
  v_amt  numeric(14,2);
  v_when timestamptz := private.made_at(p_made_at);
begin
  if p_method is null or p_method not in ('cash', 'transfer', 'pos') then raise exception 'Choose how the customer paid.'; end if;
  select * into v_s from public.sales where id = p_sale for update;
  if not found then raise exception 'Invoice not found.'; end if;
  -- Sent before? (Checked before "fully paid", which the first copy may have caused.)
  if p_client_id is not null and exists (select 1 from public.payments where id = p_client_id) then return; end if;
  if v_s.status = 'void' then raise exception 'This sale was cancelled.'; end if;
  if v_s.balance <= 0 then raise exception 'This invoice is already fully paid.'; end if;
  v_amt := least(coalesce(p_amount, 0), v_s.balance);
  if v_amt <= 0 then raise exception 'Enter the amount received.'; end if;

  update public.sales set amount_paid = amount_paid + v_amt, balance = balance - v_amt where id = p_sale;
  insert into public.payments (id, sale_id, amount, method, received_by, received_by_name, created_at)
  values (coalesce(p_client_id, gen_random_uuid()), p_sale, v_amt, p_method, v_me.id, v_me.name, v_when);
  perform private.log(v_me, 'payment',
    format('Received %s from %s for %s%s%s', private.naira(v_amt), coalesce(v_s.customer_name, 'a customer'), v_s.invoice_no,
           case when v_s.balance - v_amt > 0 then ' (still owes ' || private.naira(v_s.balance - v_amt) || ')' else ' (fully paid)' end,
           case when p_made_at is not null then ' · made offline ' || private.lagos_time(v_when) else '' end),
    p_sale);
end $$;

-- Cancel a sale made by mistake: items go back into stock (owner only)
create or replace function public.void_sale(p_sale uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me     public.profiles := private.require_owner();
  v_s      public.sales;
  v_line   jsonb;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if v_reason is null then raise exception 'Please say why this sale is being cancelled.'; end if;
  select * into v_s from public.sales where id = p_sale for update;
  if not found then raise exception 'Invoice not found.'; end if;
  if v_s.status = 'void' then raise exception 'This sale was already cancelled.'; end if;

  for v_line in select t.e from jsonb_array_elements(v_s.items) as t(e) loop
    update public.products set qty = qty + (v_line->>'qty')::numeric, updated_at = now()
     where id = (v_line->>'product_id')::uuid;
  end loop;
  if v_s.amount_paid > 0 then
    insert into public.payments (sale_id, amount, method, received_by, received_by_name)
    values (p_sale, -v_s.amount_paid, 'refund', v_me.id, v_me.name);
  end if;
  update public.sales set status = 'void', void_reason = v_reason, balance = 0 where id = p_sale;
  perform private.log(v_me, 'sale',
    format('Cancelled %s for %s (%s). Items went back into stock%s', v_s.invoice_no, private.naira(v_s.total), v_reason,
           case when v_s.amount_paid > 0 then '; refund of ' || private.naira(v_s.amount_paid) else '' end),
    p_sale);
end $$;

-- Logins, logouts and password changes, written by the app
create or replace function public.log_event(p_kind text, p_message text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me public.profiles := private.me();
begin
  if p_kind not in ('login', 'logout', 'password') then raise exception 'Unknown event.'; end if;
  perform private.log(v_me, 'login', left(coalesce(p_message, ''), 200));
end $$;

-- ---------------------------------------------------------------------
--  WHO CAN READ WHAT (row level security)
-- ---------------------------------------------------------------------
alter table public.profiles  enable row level security;
alter table public.products  enable row level security;
alter table public.customers enable row level security;
alter table public.sales     enable row level security;
alter table public.payments  enable row level security;
alter table public.stock_ins enable row level security;
alter table public.activity  enable row level security;

drop policy if exists "read own profile or owner reads all" on public.profiles;
create policy "read own profile or owner reads all" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.is_owner()));

drop policy if exists "active users read products" on public.products;
create policy "active users read products" on public.products for select to authenticated
  using ((select private.is_active()));

drop policy if exists "active users read customers" on public.customers;
create policy "active users read customers" on public.customers for select to authenticated
  using ((select private.is_active()));

drop policy if exists "owner reads all sales, staff read their own" on public.sales;
create policy "owner reads all sales, staff read their own" on public.sales for select to authenticated
  using ((select private.is_owner()) or (sold_by = (select auth.uid()) and (select private.is_active())));

drop policy if exists "owner reads payments" on public.payments;
create policy "owner reads payments" on public.payments for select to authenticated
  using ((select private.is_owner()));

drop policy if exists "owner reads all stock received, staff read their own" on public.stock_ins;
create policy "owner reads all stock received, staff read their own" on public.stock_ins for select to authenticated
  using ((select private.is_owner()) or (received_by = (select auth.uid()) and (select private.is_active())));

drop policy if exists "owner reads activity" on public.activity;
create policy "owner reads activity" on public.activity for select to authenticated
  using ((select private.is_owner()));

-- Tables: read-only from the app. All changes go through the functions above.
revoke all on public.profiles, public.products, public.customers, public.sales,
              public.payments, public.stock_ins, public.activity from anon, authenticated;
grant select on public.profiles, public.products, public.customers, public.sales,
                public.payments, public.stock_ins, public.activity to authenticated;
revoke all on sequence public.invoice_seq, public.staff_seq from anon, authenticated;

-- Functions: logged-in users may call them (each one checks permissions itself).
-- Before anyone logs in, only "does an owner exist?" and first-time setup are allowed.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
grant execute on function public.owner_exists() to anon;
grant execute on function public.setup_owner(text, text, text) to anon;

revoke execute on all functions in schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.is_active(), private.is_owner() to authenticated;

-- ---------------------------------------------------------------------
--  LIVE UPDATES (so the owner's phone updates by itself)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['profiles', 'products', 'customers', 'sales', 'payments', 'stock_ins', 'activity'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Done. Open the app and create the owner account.

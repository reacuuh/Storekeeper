// Local stand-in for Supabase, used only by e2e.test.mjs:
// a real Postgres server (embedded-postgres) + an auth endpoint that follows the
// password-login rules of supabase/auth (GoTrue) + a PostgREST-style REST/RPC layer.
// Supabase Realtime is not imitated, so the app shows "Connecting…" during tests.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('../app/', import.meta.url)).replace(/\/$/, '');
const SECRET = 'local-test-jwt-secret-local-test-jwt-secret';
const ANON_KEY = 'sb_publishable_localtestkey';

export async function start({ port = 8099, setupSql }) {
  // embedded-postgres creates this folder itself (and, when run as root, a "postgres" user to own it).
  // It lives next to this file because that user must be able to reach it; the system temp folder may be private.
  const dataDir = fileURLToPath(new URL('./.pgdata-' + crypto.randomBytes(4).toString('hex'), import.meta.url));
  // Only root needs the extra user. Otherwise embedded-postgres tries groupadd, which fails for normal users and on Windows.
  // UTF8 is forced because Windows would otherwise pick WIN1252, which can't store the → used in activity log text.
  const asRoot = os.userInfo().uid === 0;
  const epg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'password', port: 54329, persistent: false, createPostgresUser: asRoot, initdbFlags: ['--encoding=UTF8'], onLog: () => {} });
  await epg.initialise();
  await epg.start();
  await epg.createDatabase('app');
  const pool = new pg.Pool({ host: '127.0.0.1', port: 54329, user: 'postgres', password: 'password', database: 'app', max: 8 });
  pool.on('error', () => {}); // idle connections drop when the server stops

  // --- Supabase-like bootstrap (roles, auth schema as defined by supabase/auth, default grants) ---
  await pool.query(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create schema extensions;
    create table auth.users (
      instance_id uuid, id uuid primary key, aud varchar(255), role varchar(255), email varchar(255),
      encrypted_password varchar(255), email_confirmed_at timestamptz, invited_at timestamptz,
      confirmation_token varchar(255), confirmation_sent_at timestamptz, recovery_token varchar(255), recovery_sent_at timestamptz,
      email_change_token_new varchar(255), email_change varchar(255), email_change_sent_at timestamptz, last_sign_in_at timestamptz,
      raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean, created_at timestamptz, updated_at timestamptz,
      phone text unique default null, phone_confirmed_at timestamptz, phone_change text default '', phone_change_token varchar(255) default '',
      phone_change_sent_at timestamptz, email_change_token_current varchar(255) default '', email_change_confirm_status smallint default 0,
      banned_until timestamptz, reauthentication_token varchar(255) default '', reauthentication_sent_at timestamptz,
      is_sso_user boolean not null default false, deleted_at timestamptz, is_anonymous boolean not null default false);
    create unique index users_email_partial_key on auth.users (email) where (is_sso_user = false);
    create table auth.identities (
      provider_id text not null, user_id uuid not null references auth.users(id) on delete cascade, identity_data jsonb not null,
      provider text not null, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz,
      email text generated always as (lower(identity_data->>'email')) stored,
      id uuid primary key default gen_random_uuid(), unique (provider_id, provider));
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(coalesce(current_setting('request.jwt.claim.sub', true), (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    grant usage on schema extensions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  `);
  await pool.query(setupSql);

  // --- JWT ---
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = payload => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64(payload); return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
  const verify = tok => {
    const [h, p, s] = String(tok || '').split('.');
    if (!s) return null;
    if (crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url') !== s) return null;
    const c = JSON.parse(Buffer.from(p, 'base64url').toString());
    return c.exp * 1000 > Date.now() ? c : 'expired';
  };
  const refreshTokens = new Map();
  const userJson = u => ({ id: u.id, aud: u.aud, role: u.role, email: u.email, email_confirmed_at: u.email_confirmed_at, app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: u.created_at, updated_at: u.updated_at, is_anonymous: false });
  const NOT_NULL_STRINGS = ['confirmation_token', 'recovery_token', 'email_change_token_current', 'email_change_token_new', 'email_change', 'phone_change_token', 'phone_change', 'reauthentication_token'];
  async function session(u) {
    const now = Math.floor(Date.now() / 1000);
    const access = sign({ sub: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, iat: now, exp: now + 3600, session_id: crypto.randomUUID() });
    const refresh = crypto.randomBytes(16).toString('hex');
    refreshTokens.set(refresh, u.id);
    await pool.query(`update auth.users set last_sign_in_at = now() where id = $1`, [u.id]);
    return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: refresh, user: userJson(u) };
  }
  const authErr = (res, status, code, msg) => send(res, status, { code: status, error_code: code, msg });
  // mirrors FindUserByEmailAndAudience + ResourceOwnerPasswordGrant in supabase/auth
  async function findUser(where, args) {
    const r = await pool.query(`select * from auth.users where instance_id = '00000000-0000-0000-0000-000000000000' and ${where}`, args);
    const u = r.rows[0];
    if (u) { const bad = NOT_NULL_STRINGS.filter(c => u[c] === null); if (bad.length) throw new Error('Database error querying schema (NULL in ' + bad + ')'); }
    return u;
  }
  const banned = u => u.banned_until && new Date(u.banned_until) > new Date();

  // --- PostgREST-like DB execution as the caller ---
  function claimsFrom(req) {
    const auth = (req.headers.authorization || '').replace(/^Bearer /i, '');
    const c = verify(auth);
    if (c === 'expired') return 'expired';
    return c && c.role ? c : { role: 'anon' };
  }
  async function asCaller(claims, sql, args) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('role', $1, true), set_config('request.jwt.claims', $2, true), set_config('request.jwt.claim.sub', $3, true)`, [claims.role, JSON.stringify(claims), claims.sub || '']);
      const r = await client.query(sql, args);
      await client.query('commit');
      return r;
    } catch (e) { await client.query('rollback').catch(() => {}); throw e; }
    finally { client.release(); }
  }
  function pgErr(res, e, claims) {
    const status = e.code === '42501' ? (claims.role === 'anon' ? 401 : 403) : e.code === 'P0001' ? 400 : (e.code || '').startsWith('23') ? 409 : 400;
    send(res, status, { code: e.code, details: e.detail || null, hint: e.hint || null, message: e.message });
  }
  const ident = s => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Object.assign(new Error('bad identifier ' + s), { code: 'PGRST100' }); return `"${s}"`; };

  // --- HTTP ---
  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }
  const readBody = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d ? JSON.parse(d) : {})); });
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return send(res, 204);
    try {
      // ---------- auth ----------
      if (url.pathname === '/auth/v1/token') {
        const body = await readBody(req);
        if (url.searchParams.get('grant_type') === 'password') {
          const u = await findUser(`lower(email) = $1 and aud = 'authenticated' and is_sso_user = false`, [String(body.email || '').toLowerCase()]);
          if (!u) return authErr(res, 400, 'invalid_credentials', 'Invalid login credentials');
          if (banned(u)) return authErr(res, 400, 'user_banned', 'User is banned');
          const ok = (await pool.query(`select encrypted_password = extensions.crypt($1, encrypted_password) as ok from auth.users where id = $2`, [body.password || '', u.id])).rows[0].ok;
          if (!ok || !u.encrypted_password.startsWith('$2')) return authErr(res, 400, 'invalid_credentials', 'Invalid login credentials');
          return send(res, 200, await session(u));
        }
        if (url.searchParams.get('grant_type') === 'refresh_token') {
          const id = refreshTokens.get(body.refresh_token);
          if (!id) return authErr(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
          refreshTokens.delete(body.refresh_token);
          const u = await findUser('id = $1', [id]);
          if (!u || banned(u)) return authErr(res, 400, 'user_banned', 'User is banned');
          return send(res, 200, await session(u));
        }
      }
      if (url.pathname === '/auth/v1/user') {
        const c = claimsFrom(req);
        if (!c.sub) return authErr(res, 401, 'no_authorization', 'This endpoint requires a valid Bearer token');
        if (req.method === 'PUT') {
          const body = await readBody(req);
          if (body.password) await pool.query(`update auth.users set encrypted_password = extensions.crypt($1, extensions.gen_salt('bf', 10)), updated_at = now() where id = $2`, [body.password, c.sub]);
        }
        return send(res, 200, userJson(await findUser('id = $1', [c.sub])));
      }
      if (url.pathname === '/auth/v1/logout') return send(res, 204);
      if (url.pathname.startsWith('/auth/v1/')) return authErr(res, 404, 'not_found', 'not handled in test server');
      if (url.pathname.startsWith('/realtime/')) return send(res, 404, { message: 'realtime not available in test server' });

      // ---------- rest ----------
      if (url.pathname.startsWith('/rest/v1/')) {
        if (req.headers.apikey !== ANON_KEY) return send(res, 401, { message: 'Invalid API key' });
        const claims = claimsFrom(req);
        if (claims === 'expired') return send(res, 401, { code: 'PGRST301', message: 'JWT expired' });
        const rest = url.pathname.slice('/rest/v1/'.length);
        if (rest.startsWith('rpc/')) {
          const fn = rest.slice(4);
          const body = req.method === 'POST' ? await readBody(req) : {};
          const meta = (await pool.query(`select p.proargnames as names, array(select format_type(t, null) from unnest(p.proargtypes) t) as types, p.prorettype = 'void'::regtype as isvoid
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [fn])).rows[0];
          if (!meta) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn}` });
          const keys = Object.keys(body);
          if (keys.some(k => !(meta.names || []).includes(k))) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn}(${keys}) in the schema cache` });
          const args = keys.map(k => { const v = body[k]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v; });
          const call = `public.${ident(fn)}(${keys.map((k, i) => `${ident(k)} := $${i + 1}::${meta.types[meta.names.indexOf(k)]}`).join(', ')})`;
          try {
            if (meta.isvoid) { await asCaller(claims, `select ${call}`, args); return send(res, 204); }
            const r = await asCaller(claims, `select to_jsonb(${call}) as r`, args);
            return send(res, 200, r.rows[0].r);
          } catch (e) { return pgErr(res, e, claims); }
        }
        // table read
        const table = ident(rest);
        const p = url.searchParams;
        const cols = (p.get('select') || '*') === '*' ? '*' : p.get('select').split(',').map(ident).join(', ');
        const where = [], args = [];
        for (const [k, v] of p) {
          if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
          const m = /^(eq|neq|gt|gte|lt|lte)\.(.*)$/.exec(v);
          if (!m) return send(res, 400, { code: 'PGRST100', message: 'unsupported filter ' + v });
          args.push(m[2]);
          where.push(`${ident(k)} ${{ eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[m[1]]} $${args.length}`);
        }
        const order = p.get('order') ? ' order by ' + p.get('order').split(',').map(o => { const [c, dir, nulls] = o.split('.'); return `${ident(c)} ${dir === 'desc' ? 'desc' : 'asc'}${nulls === 'nullsfirst' ? ' nulls first' : nulls === 'nullslast' ? ' nulls last' : ''}`; }).join(', ') : '';
        const lim = p.get('limit') ? ` limit ${parseInt(p.get('limit'), 10)}` : '';
        const off = p.get('offset') ? ` offset ${parseInt(p.get('offset'), 10)}` : '';
        const sql = `select coalesce(json_agg(t), '[]'::json) as rows from (select ${cols} from public.${table}${where.length ? ' where ' + where.join(' and ') : ''}${order}${lim}${off}) t`;
        try {
          const r = await asCaller(claims, sql, args);
          const rows = r.rows[0].rows;
          if ((req.headers.accept || '').includes('vnd.pgrst.object')) {
            if (rows.length !== 1) return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
            return send(res, 200, rows[0]);
          }
          return send(res, 200, rows);
        } catch (e) { return pgErr(res, e, claims); }
      }

      // ---------- static app ----------
      if (url.pathname === '/config.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(`window.APP_CONFIG = { businessName: "Adebayo Water & Provisions", businessAddress: "12 Warehouse Road, Ikeja, Lagos", businessPhone: "0803 123 4567", currency: "₦", supabaseUrl: "http://localhost:${port}", supabaseKey: "${ANON_KEY}" };`);
      }
      let f = path.join(APP_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
      if (!f.startsWith(APP_DIR) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(f));
    } catch (e) {
      console.error('server error', req.method, req.url, e);
      return send(res, 500, { message: String(e.message || e) });
    }
  });
  server.on('upgrade', (req, socket) => socket.destroy());
  await new Promise(r => server.listen(port, r));
  return {
    pool,
    close: async () => {
      server.close();
      await pool.end().catch(() => {});
      await epg.stop().catch(() => {});
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

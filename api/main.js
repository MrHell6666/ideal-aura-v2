/* ---------------------------------------------------------------------
   Ideal Packages HR ERP — single serverless API entry point (Vercel).
   vercel.json rewrites /api/<route> → /api/main?route=<route>
   --------------------------------------------------------------------- */
import crypto from 'node:crypto';
import { canSeeEmp } from '../lib/auth.js';
import zlib from 'node:zlib';
import { P, cmd, pipe, pairs, parse, backendName, DbError } from '../lib/db.js';
import { hashNew, verifyPw, strongPw, setSession, clearSession, tokenFrom, readToken, sanitizeUser, can } from '../lib/auth.js';
import { ALL, SINGLE, MAPS, key, HttpError, context, loadScoped, changesSince, checkOp, writeRecords, recordChanges, version, epoch } from '../lib/store.js';

const VERSION = '3.0.0-aura';
const uid = p => p + '_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');

/* ---------------- http helpers ---------------- */
function send(req, res, status, obj) {
  let body = Buffer.from(JSON.stringify(obj));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (body.length > 2048 && /gzip/.test(req.headers['accept-encoding'] || '')) { body = zlib.gzipSync(body); res.setHeader('Content-Encoding', 'gzip'); }
  res.end(body);
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  const chunks = []; let n = 0;
  for await (const ch of req) { n += ch.length; if (n > 4.4e6) throw new HttpError(413, 'Request too large.'); chunks.push(ch); }
  const s = Buffer.concat(chunks).toString('utf8');
  try { return s ? JSON.parse(s) : {}; } catch { throw new HttpError(400, 'Invalid JSON body.'); }
}
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim();

/* ---------------- users / session ---------------- */
async function allUsers() { return [...pairs(await cmd('HGETALL', key('users'))).values()].map(parse).filter(Boolean); }
async function getUser(id) { return parse(await cmd('HGET', key('users'), id)); }
async function saveUser(u) { await cmd('HSET', key('users'), u.id, JSON.stringify(u)); await recordChanges([['users', u.id]]); }
async function session(req) {
  const t = readToken(tokenFrom(req)); if (!t) throw new HttpError(401, 'Please sign in.');
  const u = await getUser(t.uid);
  if (!u || !u.active || (u.tv || 0) !== t.tv) throw new HttpError(401, 'Your session has ended. Please sign in again.');
  return u;
}
async function audit(user, action, module, details) {
  const a = { id: uid('log'), ts: new Date().toISOString(), userId: user?.id || null, user: user?.username || 'system', role: user?.role || '-', action, module, details: String(details || '').slice(0, 500), server: true };
  await cmd('HSET', key('audit'), a.id, JSON.stringify(a)); await recordChanges([['audit', a.id]]);
}

/* ---------------- staged import (setup / restore / reset) ---------------- */
const STG = P + 'stg:';
const IMPORT_KEYS = [...ALL, 'users', 'files'];
async function importBegin() { await pipe([['DEL', ...IMPORT_KEYS.map(c => STG + key(c))]]); }
async function importChunk(ops) {
  if (!Array.isArray(ops)) throw new HttpError(400, 'ops must be an array.');
  const ch = ops.map(o => {
    if (!IMPORT_KEYS.includes(o.c) || !o.id || !o.data || typeof o.data !== 'object') throw new HttpError(400, `Invalid import record ${o.c}/${o.id}.`);
    const d = Object.assign({}, o.data);
    if (o.c === 'employees') (d.documents || []).forEach(x => delete x.data);
    return { c: o.c, id: String(o.id), data: d };
  });
  await writeRecords(ch, STG);
}
async function importCommit(admin) {
  const users = [...pairs(await cmd('HGETALL', STG + key('users'))).values()].map(parse).filter(Boolean);
  if (admin) {
    if (!/^[a-z0-9._-]{3,30}$/.test(admin.username || '')) throw new HttpError(400, 'Administrator username: 3–30 characters a-z 0-9 . _ -');
    if (!strongPw(admin.password)) throw new HttpError(400, 'Administrator password must be at least 8 characters with letters and numbers.');
    const ex = users.find(u => u.username === admin.username);
    const u = Object.assign(ex || { id: uid('usr'), email: '', deptId: null, empId: null, overrides: {}, createdAt: new Date().toISOString() }, { username: admin.username, name: admin.name || 'Administrator', role: 'super_admin', active: true, mustChange: false, failed: 0, lockedUntil: null, tv: (ex?.tv || 0) + 1 }, hashNew(admin.password));
    await cmd('HSET', STG + key('users'), u.id, JSON.stringify(u));
    users.push(u);
  }
  if (!users.some(u => u.role === 'super_admin' && u.active && u.hash)) { await importBegin(); throw new HttpError(400, 'The imported data has no active Super Administrator account. Nothing was changed.'); }
  const exists = await pipe(IMPORT_KEYS.map(c => ['EXISTS', STG + key(c)]));
  const cmds = [];
  IMPORT_KEYS.forEach((c, i) => { if (exists[i]) cmds.push(['RENAME', STG + key(c), key(c)]); else cmds.push(['DEL', key(c)]); });
  cmds.push(['DEL', P + 'chg'], ['SET', P + 'epoch', crypto.randomBytes(6).toString('hex')], ['INCR', P + 'ver']);
  await pipe(cmds);
}
async function isEmpty() { return Number(await cmd('HLEN', key('users'))) === 0; }

/* ---------------- route handlers ---------------- */
const routes = {
  'GET health': async () => ({ ok: true, version: VERSION, database: backendName() || 'not configured', time: new Date().toISOString() }),

  'GET setup/status': async () => {
    if (!backendName()) return { configured: false, needsSetup: true, message: 'Database not configured.' };
    const [n, meta, settings, emps] = await pipe([['HLEN', key('users')], ['HGET', key('meta'), 'main'], ['HGET', key('settings'), 'main'], ['HLEN', key('employees')]]);
    const s = parse(settings) || {};
    return { configured: true, needsSetup: Number(n) === 0, hasData: Number(emps) > 0, setupTokenRequired: true, demo: !!parse(meta)?.demo, company: { name: s.company?.name || 'Ideal Packages (Pvt) Ltd.', logo: s.company?.logo || null }, security: s.security || null };
  },

  'POST setup': async (req, res, b) => {
    if (!process.env.SETUP_TOKEN) throw new HttpError(500, 'SETUP_TOKEN environment variable is not set on the server.');
    const a = Buffer.from(String(b.setupToken || '')), t = Buffer.from(process.env.SETUP_TOKEN);
    if (a.length !== t.length || !crypto.timingSafeEqual(a, t)) throw new HttpError(403, 'Setup token is incorrect.');
    if (!(await isEmpty())) throw new HttpError(409, 'Setup has already been completed.');
    if (b.phase === 'admin-only') { // recover access: create an administrator, keep all existing data
      const a = b.admin || {};
      if (!/^[a-z0-9._-]{3,30}$/.test(a.username || '')) throw new HttpError(400, 'Administrator username: 3–30 characters a-z 0-9 . _ -');
      if (!strongPw(a.password)) throw new HttpError(400, 'Administrator password must be at least 8 characters with letters and numbers.');
      const u = Object.assign({ id: uid('usr'), username: a.username, name: a.name || 'Administrator', email: '', role: 'super_admin', deptId: null, empId: null, active: true, overrides: {}, mustChange: false, failed: 0, lockedUntil: null, tv: 0, createdAt: new Date().toISOString() }, hashNew(a.password));
      await saveUser(u); await audit(u, 'Administrator recovered via setup', 'backup', 'Existing data kept'); return { ok: true };
    }
    if (b.phase === 'begin') { await importBegin(); return { ok: true }; }
    if (b.phase === 'chunk') { await importChunk(b.ops); return { ok: true }; }
    if (b.phase === 'commit') { await importCommit(b.admin); await audit({ username: b.admin.username, role: 'super_admin' }, 'Initial setup completed', 'backup', b.note || ''); return { ok: true }; }
    throw new HttpError(400, 'Unknown setup phase.');
  },

  'POST auth/login': async (req, res, b) => {
    const rl = P + 'rl:' + ipOf(req);
    const [hits] = await pipe([['INCR', rl], ['EXPIRE', rl, 900]]);
    if (Number(hits) > 40) throw new HttpError(429, 'Too many sign-in attempts from this network. Try again in 15 minutes.');
    const users = await allUsers();
    const u = users.find(x => x.username.toLowerCase() === String(b.username || '').trim().toLowerCase());
    const sec = (parse(await cmd('HGET', key('settings'), 'main')) || {}).security || {};
    if (!u) { await audit(null, 'Failed login', 'auth', `Unknown username "${String(b.username).slice(0, 40)}" from ${ipOf(req)}`); throw new HttpError(401, 'Invalid username or password.'); }
    if (!u.active) throw new HttpError(403, 'This account is disabled. Contact the administrator.');
    if (u.lockedUntil && Date.now() < u.lockedUntil) throw new HttpError(423, `Account locked after repeated failed attempts. Try again in ${Math.ceil((u.lockedUntil - Date.now()) / 60000)} minute(s).`);
    if (!verifyPw(u, b.password)) {
      u.failed = (u.failed || 0) + 1; let msg = 'Invalid username or password.';
      if (u.failed >= (sec.maxLoginAttempts || 5)) { u.lockedUntil = Date.now() + (sec.lockMins || 5) * 60000; u.failed = 0; msg = `Too many failed attempts. Account locked for ${sec.lockMins || 5} minutes.`; }
      await saveUser(u); await audit(u, 'Failed login', 'auth', `from ${ipOf(req)}`);
      throw new HttpError(401, msg);
    }
    if (u.algo !== 'scrypt') Object.assign(u, hashNew(b.password)); // upgrade legacy hashes
    u.failed = 0; u.lockedUntil = null; u.lastLogin = new Date().toISOString();
    await saveUser(u); setSession(req, res, u); await audit(u, 'Login', 'auth', `${u.username} signed in from ${ipOf(req)}`);
    return { user: sanitizeUser(u) };
  },
  'POST auth/logout': async (req, res, b) => { try { const u = await session(req); await audit(u, 'Logout', 'auth', b.reason || `${u.username} signed out`); } catch { } clearSession(req, res); return { ok: true }; },
  'GET auth/me': async req => ({ user: sanitizeUser(await session(req)) }),
  'POST auth/change-password': async (req, res, b) => {
    const u = await session(req);
    if (!verifyPw(u, b.current)) throw new HttpError(400, 'Current password is incorrect.');
    if (!strongPw(b.password)) throw new HttpError(400, 'Use at least 8 characters including letters and numbers.');
    if (b.password === b.current) throw new HttpError(400, 'New password must be different.');
    Object.assign(u, hashNew(b.password), { mustChange: false, tv: (u.tv || 0) + 1 });
    await saveUser(u); setSession(req, res, u); await audit(u, 'Password changed', 'users', u.username);
    return { user: sanitizeUser(u) };
  },

  'GET data': async req => {
    const u = await session(req); const ctx = await context(u);
    const [ver, ep] = [await version(), await epoch()];
    return { ver, epoch: ep, user: sanitizeUser(u), db: await loadScoped(ctx) };
  },
  'GET changes': async (req, res, b, q) => {
    // cheap path first (1 database command): nothing changed since the client's version
    if (!readToken(tokenFrom(req))) throw new HttpError(401, 'Please sign in.');
    const [v0, e0] = await cmd('MGET', P + 'ver', P + 'epoch');
    const ver = Number(v0) || 0, ep = e0 || '0';
    const since = Number(q.since) || 0;
    if (q.epoch !== ep || since > ver) return { reload: true, ver, epoch: ep };
    if (since === ver) return { ver, epoch: ep, put: {}, del: {} };
    const u = await session(req); const ctx = await context(u);
    const ch = await changesSince(ctx, since);
    return Object.assign({ ver, epoch: ep, user: sanitizeUser(u) }, ch);
  },
  'POST sync': async (req, res, b) => {
    const u = await session(req); const ctx = await context(u);
    const ops = Array.isArray(b.ops) ? b.ops : [];
    if (ops.length > 3000) throw new HttpError(413, 'Too many changes in one request.');
    const groups = new Map(); ops.forEach(o => { if (!groups.has(o.c)) groups.set(o.c, []); groups.get(o.c).push(o); });
    const colls = [...groups.keys()].filter(c => [...ALL, 'files'].includes(c));
    const exRes = await pipe(colls.map(c => ['HMGET', key(c), ...groups.get(c).map(o => SINGLE.includes(c) ? 'main' : String(o.id))]));
    const existing = new Map(); colls.forEach((c, i) => groups.get(c).forEach((o, j) => existing.set(c + '|' + o.id, parse(exRes[i][j]))));
    const newEmps = new Map((groups.get('employees') || []).filter(o => o.op !== 'del').map(o => [o.id, o.data]));
    const out = [];
    for (const o of ops) {
      if (o.c === 'users') throw new HttpError(400, 'User accounts are managed through the Users screen.');
      const ex = existing.get(o.c + '|' + o.id);
      const data = checkOp(ctx, o, ex, newEmps);
      if (o.op === 'del') { if (data === null && (o.c === 'audit' || o.c === 'notifications' || o.c === 'meta')) continue; out.push({ c: o.c, id: SINGLE.includes(o.c) ? 'main' : String(o.id), data: null }); }
      else if (data !== null) out.push({ c: o.c, id: SINGLE.includes(o.c) ? 'main' : String(o.id), data });
    }
    await writeRecords(out);
    const ver = await recordChanges(out.filter(x => x.c !== 'files').map(x => [x.c, x.id]));
    return { ok: true, ver, applied: out.length, adjusted: out.filter(x => x.data && x.c === 'attendance' && x.data.approval === 'pending').map(x => x.id) };
  },

  'POST users': async (req, res, b) => {
    const me = await session(req); const ctx = await context(me);
    const users = await allUsers();
    const sas = users.filter(x => x.role === 'super_admin' && x.active);
    const checkFields = (d, self) => {
      if (!/^[a-z0-9._-]{3,30}$/.test(d.username || '')) throw new HttpError(400, 'Username: 3–30 characters a-z 0-9 . _ -');
      if (users.some(x => x.username === d.username && x.id !== self)) throw new HttpError(400, 'Username already taken.');
      const role = ctx.roles.find(r => r.id === d.role); if (!role) throw new HttpError(400, 'Unknown role.');
      if (d.role === 'super_admin' && me.role !== 'super_admin') throw new HttpError(403, 'Only a Super Administrator can grant that role.');
      if (role.scope === 'department' && !d.deptId) throw new HttpError(400, 'Department required for this role.');
      if (role.scope === 'self' && !d.empId) throw new HttpError(400, 'Employee role needs a linked employee.');
      if (d.empId && users.some(x => x.empId === d.empId && x.id !== self)) throw new HttpError(400, 'That employee already has a login.');
      const ov = {}; Object.entries(d.overrides || {}).forEach(([k, v]) => { if (/^[a-z]+\.(view|create|edit|delete|approve|export)$/.test(k) && typeof v === 'boolean') ov[k] = v; });
      if (me.role !== 'super_admin' && Object.keys(ov).length) throw new HttpError(403, 'Only a Super Administrator can set permission overrides.');
      return { username: d.username, name: String(d.name || '').slice(0, 80), email: String(d.email || '').slice(0, 120), role: d.role, deptId: d.deptId || null, empId: d.empId || null, active: d.active !== false, overrides: ov };
    };
    if (b.action === 'theme') { me.theme = ['light', 'dark', 'system'].includes(b.theme) ? b.theme : 'light'; await saveUser(me); return { user: sanitizeUser(me) }; }
    if (b.action === 'create') {
      if (!can(me, ctx.roles, 'users', 'create')) throw new HttpError(403, 'Permission denied: users.create.');
      if (!strongPw(b.password)) throw new HttpError(400, 'Initial password must be at least 8 characters with letters and numbers.');
      const u = Object.assign({ id: uid('usr'), createdAt: new Date().toISOString(), failed: 0, lockedUntil: null, lastLogin: null, tv: 0, mustChange: b.mustChange !== false }, checkFields(b.user || {}, null), hashNew(b.password));
      await saveUser(u); await audit(me, 'Create user', 'users', `${u.username} (${u.role})`); return { user: sanitizeUser(u) };
    }
    const u = users.find(x => x.id === b.id); if (!u) throw new HttpError(404, 'User not found.');
    if (u.role === 'super_admin' && me.role !== 'super_admin') throw new HttpError(403, 'Only a Super Administrator can change that account.');
    if (b.action === 'update') {
      if (!can(me, ctx.roles, 'users', 'edit')) throw new HttpError(403, 'Permission denied: users.edit.');
      const f = checkFields(b.user || {}, u.id);
      if (u.role === 'super_admin' && u.active && (f.role !== 'super_admin' || !f.active) && sas.length <= 1) throw new HttpError(400, 'This is the last active Super Administrator.');
      const sessionsReset = f.role !== u.role || !f.active || f.deptId !== u.deptId;
      Object.assign(u, f); if (sessionsReset && u.id !== me.id) u.tv = (u.tv || 0) + 1;
      await saveUser(u); await audit(me, 'Edit user', 'users', `${u.username} (${u.role})`); return { user: sanitizeUser(u) };
    }
    if (b.action === 'reset') {
      if (!can(me, ctx.roles, 'users', 'edit')) throw new HttpError(403, 'Permission denied: users.edit.');
      if (!strongPw(b.password)) throw new HttpError(400, 'Password must be at least 8 characters with letters and numbers.');
      Object.assign(u, hashNew(b.password), { mustChange: b.mustChange !== false, tv: (u.tv || 0) + 1 }); if (b.unlock) { u.failed = 0; u.lockedUntil = null; }
      await saveUser(u); await audit(me, 'Password reset', 'users', u.username); return { user: sanitizeUser(u) };
    }
    if (b.action === 'delete') {
      if (!can(me, ctx.roles, 'users', 'delete')) throw new HttpError(403, 'Permission denied: users.delete.');
      if (u.id === me.id) throw new HttpError(400, 'You cannot delete your own account.');
      if (u.role === 'super_admin' && sas.length <= 1) throw new HttpError(400, 'Cannot delete the last active Super Administrator.');
      await cmd('HDEL', key('users'), u.id); await recordChanges([['users', u.id]]); await audit(me, 'Delete user', 'users', u.username); return { ok: true };
    }
    throw new HttpError(400, 'Unknown action.');
  },

  /* ---- kiosk: employee PIN set / verify (PINs are hashed and never sent to browsers) ---- */
  'POST kiosk/pin': async (req, res, b) => {
    const u = await session(req); const ctx = await context(u);
    const emp = parse(await cmd('HGET', key('employees'), String(b.empId || '')));
    if (!emp || !canSeeEmp(u, ctx.roles, emp)) throw new HttpError(404, 'Employee not found.');
    if (!(emp.id === u.empId || ctx.can('employees', 'edit'))) throw new HttpError(403, 'Permission denied: employees.edit.');
    if (b.clear) { delete emp.pin; } else { if (!/^\d{4,6}$/.test(String(b.pin || ''))) throw new HttpError(400, 'PIN must be 4 to 6 digits.'); emp.pin = hashNew(String(b.pin)); }
    await cmd('HSET', key('employees'), emp.id, JSON.stringify(emp)); await recordChanges([['employees', emp.id]]);
    await audit(u, b.clear ? 'Kiosk PIN cleared' : 'Kiosk PIN set', 'employees', emp.code);
    return { ok: true, hasPin: !b.clear };
  },
  'POST kiosk/verify': async (req, res, b) => {
    const u = await session(req); const ctx = await context(u);
    if (!ctx.can('attendance', 'create')) throw new HttpError(403, 'Kiosk mode requires attendance.create permission.');
    const code = String(b.code || '').trim().toLowerCase();
    const emp = [...ctx.emps.values()].find(e => e && String(e.code).toLowerCase() === code && !e.archived);
    if (!emp || !canSeeEmp(u, ctx.roles, emp)) throw new HttpError(404, 'Employee ID not recognised.');
    const lk = P + 'kpin:' + emp.id;
    const fails = Number(await cmd('GET', lk)) || 0;
    if (fails >= 5) throw new HttpError(423, 'Too many wrong PINs. This ID is locked for 10 minutes.');
    if (!emp.pin) throw new HttpError(400, 'No kiosk PIN is set for this employee. Ask HR to set one.');
    if (!verifyPw(emp.pin, String(b.pin || ''))) { await pipe([['INCR', lk], ['EXPIRE', lk, 600]]); throw new HttpError(401, `Wrong PIN (${4 - fails} attempt(s) left).`); }
    await cmd('DEL', lk);
    return { ok: true, empId: emp.id };
  },

  'GET file': async (req, res, b, q) => {
    const u = await session(req); const ctx = await context(u);
    const f = parse(await cmd('HGET', key('files'), String(q.id || '')));
    if (!f || !ctx.sees(f.empId)) throw new HttpError(404, 'File not found.');
    return f;
  },

  'GET admin/backup': async req => {
    const u = await session(req); const ctx = await context(u);
    if (!ctx.can('backup', 'export') || ctx.scope !== 'all') throw new HttpError(403, 'Permission denied: backup.export.');
    const res = await pipe([...ALL, 'users', 'files'].map(c => ['HGETALL', key(c)]));
    const db = {};
    [...ALL, 'users', 'files'].forEach((c, i) => { const vals = [...pairs(res[i]).values()].map(parse).filter(Boolean); if (SINGLE.includes(c)) db[c] = vals[0] || {}; else if (MAPS.includes(c)) { db[c] = {}; vals.forEach(v => db[c][v.id] = v.ids); } else db[c] = vals; });
    if (!ctx.can('users', 'view')) db.users = db.users.map(sanitizeUser);
    await audit(u, 'Backup downloaded (server)', 'backup', `${db.employees.length} employees, ${db.attendance.length} attendance`);
    return { app: 'ipk-hr-erp', format: 2, version: VERSION, exportedAt: new Date().toISOString(), exportedBy: u.username, db };
  },
  'POST admin/import': async (req, res, b) => {
    const u = await session(req); const ctx = await context(u);
    if (u.role !== 'super_admin' || !ctx.can('backup', 'delete')) throw new HttpError(403, 'Only a Super Administrator can restore or reset data.');
    if (b.phase === 'begin') { await importBegin(); return { ok: true }; }
    if (b.phase === 'chunk') { await importChunk(b.ops); return { ok: true }; }
    if (b.phase === 'commit') {
      if (b.keepSelf) { // keep the signed-in administrator's own account (e.g. when loading demo data)
        const me = await getUser(u.id);
        const stg = [...pairs(await cmd('HGETALL', STG + key('users'))).values()].map(parse).filter(Boolean);
        const clash = stg.filter(x => x.id === me.id || x.username === me.username).map(x => x.id);
        if (clash.length) await cmd('HDEL', STG + key('users'), ...clash);
        await cmd('HSET', STG + key('users'), me.id, JSON.stringify(me));
      }
      await importCommit(b.admin || null); await audit(u, b.label || 'Data restored', 'backup', b.note || ''); return { ok: true, relogin: true };
    }
    throw new HttpError(400, 'Unknown import phase.');
  },
  'POST admin/purge-audit': async (req, res, b) => {
    const u = await session(req); const ctx = await context(u);
    if (!ctx.can('backup', 'delete')) throw new HttpError(403, 'Permission denied.');
    const all = [...pairs(await cmd('HGETALL', key('audit'))).values()].map(parse).filter(Boolean).sort((a, c) => String(c.ts).localeCompare(String(a.ts)));
    const drop = all.slice(Math.max(50, Number(b.keep) || 500)).map(a => a.id);
    for (let i = 0; i < drop.length; i += 500) await cmd('HDEL', key('audit'), ...drop.slice(i, i + 500));
    await recordChanges(drop.map(id => ['audit', id])); await audit(u, 'Audit purged', 'backup', `${drop.length} entries removed`);
    return { removed: drop.length };
  }
};

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const q = Object.fromEntries(url.searchParams);
    let route = (q.route || url.pathname.replace(/^\/api\/?/, '')).replace(/\/+$/, '');
    if (route === 'main') route = '';
    const fn = routes[`${req.method} ${route}`];
    if (!fn) return send(req, res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.headers['x-ipk'] !== '1') return send(req, res, 403, { error: 'Missing request header.' });
    const b = req.method === 'GET' ? {} : await readBody(req);
    const out = await fn(req, res, b, q);
    send(req, res, 200, out);
  } catch (e) {
    const st = e instanceof HttpError ? e.status : e instanceof DbError ? 503 : e.status || 500;
    if (st >= 500) console.error(e);
    send(req, res, st, { error: e.message || 'Server error' });
  }
}

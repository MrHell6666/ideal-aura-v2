/* ---------------------------------------------------------------------
   store.js — data layout, scoped reads and server-side write rules
   Every collection is a Redis hash  ipk:c:<collection>  (id -> JSON).
   Users live in ipk:users, uploaded documents in ipk:files.
   --------------------------------------------------------------------- */
import { P, cmd, pipe, pairs, parse } from './db.js';
import { can, scopeOf, canSeeEmp, sanitizeUser } from './auth.js';

export const ARRAYS = ['roles', 'departments', 'designations', 'shifts', 'rotations', 'employees', 'attendance', 'corrections', 'shiftRequests', 'leaveTypes', 'leaves', 'leaveAdjust', 'encashments', 'holidays', 'specialDays', 'payrollRuns', 'loans', 'payItems', 'notifications', 'audit'];
export const SINGLE = ['settings', 'meta'];
export const MAPS = ['notifRead'];
export const ALL = [...ARRAYS, ...SINGLE, ...MAPS];
export const key = c => c === 'users' ? P + 'users' : c === 'files' ? P + 'files' : P + 'c:' + c;
const EMP_COLLS = { attendance: 'attendance', corrections: 'attendance', shiftRequests: 'shifts', leaves: 'leaves', leaveAdjust: 'leaves', encashments: 'leaves', loans: 'payroll', payItems: 'payroll' };
const MODULE = { roles: 'users', departments: 'departments', designations: 'departments', shifts: 'shifts', rotations: 'shifts', employees: 'employees', attendance: 'attendance', corrections: 'attendance', shiftRequests: 'shifts', leaveTypes: 'leaves', leaves: 'leaves', leaveAdjust: 'leaves', encashments: 'leaves', holidays: 'holidays', specialDays: 'holidays', payrollRuns: 'payroll', loans: 'payroll', payItems: 'payroll' };

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/* ----- version / change log ----- */
export async function version() { return Number(await cmd('GET', P + 'ver')) || 0; }
export async function epoch() { return (await cmd('GET', P + 'epoch')) || '0'; }
export async function recordChanges(list) { // list of [collection, id]
  if (!list.length) return version();
  const v = await cmd('INCR', P + 'ver');
  const z = ['ZADD', P + 'chg']; list.forEach(([c, id]) => z.push(v, `${v}|${c}|${id}`));
  await pipe([z, ['ZREMRANGEBYRANK', P + 'chg', 0, -30001]]);
  return v;
}

/* ----- context loaded for every authenticated request ----- */
export async function context(user) {
  const [roles, settings, emps] = await pipe([['HGETALL', key('roles')], ['HGET', key('settings'), 'main'], ['HGETALL', key('employees')]]);
  const ctx = { user, roles: [...pairs(roles).values()].map(parse).filter(Boolean), settings: parse(settings) || {}, emps: new Map() };
  pairs(emps).forEach((v, k) => ctx.emps.set(k, parse(v)));
  ctx.can = (m, a) => can(user, ctx.roles, m, a);
  ctx.scope = scopeOf(user, ctx.roles);
  ctx.sees = empId => canSeeEmp(user, ctx.roles, ctx.emps.get(empId));
  return ctx;
}

/* ----- read filters (what each user may receive) ----- */
function salaryVisible(ctx, emp) { return emp.id === ctx.user.empId || (ctx.can('payroll', 'view') && ctx.scope === 'all'); }
function notifFor(ctx, n) {
  const u = ctx.user; const to = n.to || 'all';
  if (to === 'all' || to === u.id || (u.empId && to === 'emp:' + u.empId) || to === 'role:' + u.role) return true;
  if (to.startsWith('perm:')) { const [m, a] = to.slice(5).split('.'); return ctx.can(m, a); }
  return false;
}
export function filterRecord(ctx, c, r) {
  if (!r) return null;
  if (c === 'employees') { if (!canSeeEmp(ctx.user, ctx.roles, r)) return null; if (r.pin) { r = Object.assign({}, r, { hasPin: true }); delete r.pin; } if (!salaryVisible(ctx, r)) { const { salary, bank, ...rest } = r; return Object.assign(rest, { salary: { hidden: true }, bank: {} }); } return r; }
  if (EMP_COLLS[c]) { if (EMP_COLLS[c] === 'payroll' && !ctx.can('payroll', 'view')) return null; return ctx.sees(r.empId) ? r : null; }
  if (c === 'payrollRuns') { if (!ctx.can('payroll', 'view')) return null; if (ctx.scope === 'all') return r; return Object.assign({}, r, { rows: (r.rows || []).filter(x => ctx.sees(x.empId)) }); }
  if (c === 'audit') return ctx.can('audit', 'view') ? r : null;
  if (c === 'notifications') return notifFor(ctx, r) ? r : null;
  if (c === 'notifRead') return r.id === ctx.user.id ? r : null;
  if (c === 'users') return (ctx.can('users', 'view') || r.id === ctx.user.id) ? sanitizeUser(r) : null;
  return r;
}
export async function loadScoped(ctx) {
  const cmds = ALL.map(c => ['HGETALL', key(c)]).concat([['HGETALL', key('users')]]);
  const res = await pipe(cmds);
  const db = {};
  ALL.forEach((c, i) => {
    const vals = [...pairs(res[i]).values()].map(parse).filter(Boolean);
    if (SINGLE.includes(c)) db[c] = vals[0] || {};
    else if (c === 'notifRead') { db.notifRead = {}; vals.forEach(v => { const f = filterRecord(ctx, c, v); if (f) db.notifRead[f.id] = f.ids || []; }); }
    else db[c] = vals.map(r => filterRecord(ctx, c, r)).filter(Boolean);
  });
  db.users = [...pairs(res[ALL.length]).values()].map(parse).filter(Boolean).map(u => filterRecord(ctx, 'users', u)).filter(Boolean);
  ['attendance', 'audit', 'notifications'].forEach(c => db[c].sort((a, b) => (c === 'attendance' ? 0 : String(b.ts).localeCompare(String(a.ts)))));
  return db;
}
export async function changesSince(ctx, since) {
  const members = await cmd('ZRANGEBYSCORE', P + 'chg', '(' + since, '+inf');
  const first = await cmd('ZRANGE', P + 'chg', 0, 0);
  const firstVer = first && first.length ? Number(String(first[0]).split('|')[0]) : 0;
  if (since > 0 && firstVer > since + 1) return { reload: true }; // older changes were trimmed
  const want = new Map();
  members.forEach(m => { const [, c, ...rest] = m.split('|'); const id = rest.join('|'); if (!want.has(c)) want.set(c, new Set()); want.get(c).add(id); });
  const colls = [...want.keys()];
  const res = await pipe(colls.map(c => ['HMGET', key(c), ...want.get(c)]));
  const put = {}, del = {};
  colls.forEach((c, i) => {
    const ids = [...want.get(c)];
    ids.forEach((id, j) => {
      const r = parse(res[i][j]);
      if (!r) { (del[c] = del[c] || []).push(id); return; }
      const f = filterRecord(ctx, c, r);
      if (f) (put[c] = put[c] || []).push(f);
    });
  });
  return { put, del };
}

/* ----- write rules (enforced for every change a browser sends) ----- */
const today = tz => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const only = (a, b, fields) => { const x = Object.assign({}, a), y = Object.assign({}, b); fields.forEach(f => { delete x[f]; delete y[f]; }); return same(x, y); };
const DECISION = ['status', 'actionBy', 'actionAt', 'remarks', 'amount', 'month'];

function deny(msg) { throw new HttpError(403, msg); }
function needP(ctx, m, a, what) { if (!ctx.can(m, a)) deny(`Permission denied: ${m}.${a}${what ? ' (' + what + ')' : ''}.`); }

export function checkOp(ctx, op, ex, newEmps) {
  const { c, id } = op; const u = ctx.user; const isDel = op.op === 'del';
  let d = isDel ? null : op.data;
  if (!isDel && (!d || typeof d !== 'object')) throw new HttpError(400, `Invalid data for ${c}/${id}.`);
  if (d && c !== 'settings' && c !== 'meta' && c !== 'notifRead' && d.id !== id) throw new HttpError(400, 'Record id mismatch.');
  const sees = empId => ctx.sees(empId) || (newEmps.has(empId) && canSeeEmp(u, ctx.roles, newEmps.get(empId)));
  switch (c) {
    case 'meta': return null; // managed by the server
    case 'audit': if (isDel || ex) return null; return Object.assign({}, d, { userId: u.id, user: u.username, role: u.role, details: String(d.details || '').slice(0, 500) });
    case 'notifications':
      if (isDel) return null;
      if (ex) { const read = new Set(ex.read || []); if ((d.read || []).includes(u.id)) read.add(u.id); return Object.assign({}, ex, { read: [...read] }); }
      return Object.assign({}, d, { read: [], from: u.username });
    case 'notifRead': if (id !== u.id) deny('Cannot change another user’s notification state.'); return isDel ? null : { id, ids: (Array.isArray(d.ids) ? d.ids : []).map(String).slice(-1500) };
    case 'settings': {
      if (isDel) deny('Settings cannot be deleted.');
      if (ex && only(ex, d, ['lastBackupAt']) && ctx.can('backup', 'export')) return d;
      if (ex && only(ex, d, ['weeklyOffs']) && ctx.can('holidays', 'edit')) return d;
      needP(ctx, 'settings', 'edit'); return d;
    }
    case 'roles': if (!(ctx.can('users', 'edit') && u.role === 'super_admin')) deny('Only a Super Administrator can change roles.'); if (isDel && ex?.system) deny('System roles cannot be deleted.'); if (d && d.id === 'super_admin') { d.perms = ex?.perms || d.perms; d.scope = 'all'; } return d;
    case 'files': {
      const empId = (d || ex)?.empId; if (!sees(empId)) deny('Employee outside your access scope.');
      const selfie = (d || ex)?.kind === 'selfie';
      if (selfie) { if (!ctx.can('attendance', 'create')) deny('Permission denied: attendance.create.'); if (isDel && !ctx.can('attendance', 'delete')) deny('Permission denied.'); if (d && String(d.data || '').length > 160000) throw new HttpError(413, 'Selfie image too large.'); if (ex && !isDel) deny('Selfies cannot be replaced.'); return d; }
      needP(ctx, 'employees', 'edit', 'documents');
      if (d && String(d.data || '').length > 1400000) throw new HttpError(413, 'File too large (max ~1 MB).');
      return d;
    }
  }
  const mod = MODULE[c]; if (!mod) throw new HttpError(400, 'Unknown collection: ' + c);
  const empId = c === 'employees' ? id : (d || ex)?.empId;
  if (c === 'employees') { if (ex && !canSeeEmp(u, ctx.roles, ex)) deny('Employee outside your access scope.'); if (d && !canSeeEmp(u, ctx.roles, d)) deny('You can only manage employees in your own scope.'); }
  else if (EMP_COLLS[c]) { if (!sees(empId) || (ex && !sees(ex.empId))) deny('Employee outside your access scope.'); }
  const self = empId && empId === u.empId;
  const s = ctx.settings || {};

  if (isDel) {
    if (c === 'attendance') { if (ctx.can('attendance', 'delete') || (ctx.can('leaves', 'approve') && ex && (ex.mark === 'A' || !ex.in)) || (ctx.can('attendance', 'approve') && ex?.approval === 'pending')) return null; deny('Permission denied: attendance.delete.'); }
    if (c === 'leaves' && ex && ex.empId === u.empId && ex.status === 'pending') return null;
    needP(ctx, mod, 'delete'); return null;
  }
  switch (c) {
    case 'attendance': {
      if (self && !ctx.can('attendance', 'edit')) { needP(ctx, 'attendance', 'create'); const td = today(s.timezone); if (d.date < addDays(td, -1) || d.date > td) deny('Self-service punches are only allowed for today. Use a correction request.'); if (ex && ex.approval === 'pending') d.approval = 'pending'; return d; }
      if (ex && only(ex, d, ['approval', 'log']) && ctx.can('attendance', 'approve')) return d;
      if (ex && ex.approval === 'pending' && d.approval === 'approved' && !ctx.can('attendance', 'approve')) deny('Approval requires attendance.approve.');
      needP(ctx, 'attendance', ex ? 'edit' : 'create');
      if (!self && !ctx.can('attendance', 'approve') && s.attendance?.requireApprovalForManual !== false && (!ex || !only(ex, d, ['log']))) d.approval = 'pending';
      return d;
    }
    case 'leaves': case 'corrections': case 'shiftRequests': case 'encashments': {
      const apMod = { leaves: 'leaves', corrections: 'attendance', shiftRequests: 'shifts', encashments: 'leaves' }[c];
      const from = ex?.status, to = d.status;
      if (!ex) { needP(ctx, mod, 'create'); if (to && to !== 'pending' && !(c === 'encashments' && !self && ctx.can('leaves', 'approve')) && !(to === 'approved' && ctx.can(apMod, 'approve') && !self)) deny('New requests must be pending unless entered by an approver.'); return d; }
      if (from !== to && ['approved', 'rejected'].includes(to)) { if (!ctx.can(apMod, 'approve') || self) deny('You cannot approve or reject this request.'); return only(ex, d, DECISION) ? d : (needP(ctx, mod, 'edit'), d); }
      if (to === 'cancelled' && from !== 'cancelled') { if ((self && from === 'pending') || ctx.can(apMod, 'approve')) return d; deny('You cannot cancel this request.'); }
      needP(ctx, mod, 'edit'); return d;
    }
    case 'employees': {
      needP(ctx, 'employees', ex ? 'edit' : 'create');
      const salaryOk = ctx.can('payroll', 'edit') || (ctx.can('employees', 'edit') && ctx.can('payroll', 'view') && ctx.scope === 'all');
      if (!salaryOk) { d.salary = ex ? ex.salary : { basic: 0, allowances: [], deductions: [], tax: 0, otEligible: true, paymentMode: 'Bank' }; d.bank = ex ? ex.bank : {}; }
      else if (d.salary && d.salary.hidden) { d.salary = ex?.salary; d.bank = ex?.bank; }
      (d.documents || []).forEach(x => { delete x.data; });
      delete d.hasPin; if (ex && ex.pin) d.pin = ex.pin; else delete d.pin; // PINs change only through the kiosk/pin endpoint
      return d;
    }
    case 'payrollRuns': {
      if (ex && ex.status === 'finalized') { if (!(ctx.can('payroll', 'approve') && ctx.can('payroll', 'delete'))) deny('Reopening a finalized payroll requires payroll approve + delete.'); return d; }
      if (d.status === 'finalized') needP(ctx, 'payroll', 'approve', 'finalize');
      needP(ctx, 'payroll', ex ? 'edit' : 'create'); return d;
    }
    default: needP(ctx, mod, ex ? 'edit' : 'create'); return d;
  }
}

/* ----- bulk write helper ----- */
export async function writeRecords(changes, prefix = '') { // changes: [{c,id,data|null}]
  const cmds = []; const byC = new Map();
  changes.forEach(ch => { if (!byC.has(ch.c)) byC.set(ch.c, { put: [], del: [] }); const g = byC.get(ch.c); if (ch.data === null) g.del.push(ch.id); else g.put.push(ch.id, JSON.stringify(ch.data)); });
  byC.forEach((g, c) => {
    const k = prefix + key(c);
    for (let i = 0; i < g.put.length; i += 400) cmds.push(['HSET', k, ...g.put.slice(i, i + 400)]);
    if (g.del.length) cmds.push(['HDEL', k, ...g.del]);
  });
  await pipe(cmds);
}

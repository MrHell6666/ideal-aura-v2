/* ---------------------------------------------------------------------
   auth.js — password hashing (scrypt), signed session cookies, roles
   --------------------------------------------------------------------- */
import crypto from 'node:crypto';

const COOKIE = 'aura_s';
const SESSION_HOURS = 12;
let devSecret = null;

export function secret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.IPK_MEMORY_DB === '1') return (devSecret = devSecret || crypto.randomBytes(32).toString('hex'));
  throw Object.assign(new Error('SESSION_SECRET environment variable is missing or shorter than 32 characters.'), { status: 500 });
}

/* ----- passwords ----- */
export function hashNew(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { algo: 'scrypt', salt, hash: h };
}
// legacy hash produced by the offline (browser) version: 500 × SHA-256
function legacy(pw, salt) { let h = salt + '|' + pw; for (let i = 0; i < 500; i++) h = crypto.createHash('sha256').update(salt + h, 'utf8').digest('hex'); return h; }
export function verifyPw(user, pw) {
  if (!user || !user.hash || !user.salt) return false;
  const calc = user.algo === 'scrypt' ? crypto.scryptSync(String(pw), user.salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex') : legacy(String(pw), user.salt);
  const a = Buffer.from(calc, 'hex'), b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function strongPw(pw) { return typeof pw === 'string' && pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw); }

/* ----- session tokens ----- */
const b64 = s => Buffer.from(s).toString('base64url');
export function issue(user) {
  const body = b64(JSON.stringify({ uid: user.id, tv: user.tv || 0, exp: Date.now() + SESSION_HOURS * 3600e3 }));
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return body + '.' + sig;
}
export function readToken(tok) {
  if (!tok || !tok.includes('.')) return null;
  const [body, sig] = tok.split('.');
  const exp = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
export function cookieHeader(req, value, maxAge) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') || process.env.VERCEL ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
export function setSession(req, res, user) { res.setHeader('Set-Cookie', cookieHeader(req, issue(user), SESSION_HOURS * 3600)); }
export function clearSession(req, res) { res.setHeader('Set-Cookie', cookieHeader(req, '', 0)); }
export function tokenFrom(req) {
  const c = req.headers.cookie || '';
  const m = c.split(/;\s*/).find(x => x.startsWith(COOKIE + '='));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : null;
}

/* ----- permissions (mirror of the front-end rules, enforced on the server) ----- */
export function can(user, roles, mod, act = 'view') {
  if (!user) return false;
  const key = mod + '.' + act;
  const ov = user.overrides || {};
  if (ov[key] === true) return true;
  if (ov[key] === false) return false;
  const role = roles.find(r => r.id === user.role);
  return !!(role && role.perms && role.perms[key]);
}
export function scopeOf(user, roles) { return user.scopeOverride || roles.find(r => r.id === user.role)?.scope || 'self'; }
export function canSeeEmp(user, roles, emp) {
  if (!emp) return false;
  const sc = scopeOf(user, roles);
  if (sc === 'all') return true;
  if (sc === 'department') return emp.deptId === user.deptId || emp.id === user.empId;
  return emp.id === user.empId;
}
export function sanitizeUser(u) { if (!u) return null; const { hash, salt, algo, tv, ...rest } = u; return rest; }

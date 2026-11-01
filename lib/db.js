/* ---------------------------------------------------------------------
   db.js — Redis access over the Upstash REST API (no npm dependencies).
   Production: Upstash for Redis (Vercel Marketplace) env vars
     KV_REST_API_URL / KV_REST_API_TOKEN  (or UPSTASH_REDIS_REST_URL / _TOKEN)
   Local testing: IPK_MEMORY_DB=1 uses an in-process memory store.
   --------------------------------------------------------------------- */
export const P = (process.env.DB_PREFIX || 'aura') + ':'; // Volume 2 keeps its data separate from Volume 1 ('ipk:')
const URL_ = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export function backendName() {
  if (URL_() && TOKEN()) return 'upstash';
  if (process.env.IPK_MEMORY_DB === '1') return 'memory';
  return null;
}

export class DbError extends Error {}

/* ---------------- in-memory Redis subset (local tests only) ---------------- */
const mem = new Map(); // key -> {t:'s'|'h'|'z', v, exp}
function live(k) { const e = mem.get(k); if (e && e.exp && Date.now() > e.exp) { mem.delete(k); return null; } return e || null; }
function hashOf(k, create) { let e = live(k); if (!e && create) { e = { t: 'h', v: new Map() }; mem.set(k, e); } return e ? e.v : null; }
function memExec(c) {
  const [cmd, ...a] = c; const C = cmd.toUpperCase();
  switch (C) {
    case 'PING': return 'PONG';
    case 'GET': { const e = live(a[0]); return e ? e.v : null; }
    case 'MGET': return a.map(k => { const e = live(k); return e ? e.v : null; });
    case 'SET': { const e = { t: 's', v: String(a[1]) }; const i = a.findIndex(x => String(x).toUpperCase() === 'EX'); if (i > 0) e.exp = Date.now() + Number(a[i + 1]) * 1000; mem.set(a[0], e); return 'OK'; }
    case 'INCR': case 'INCRBY': { const e = live(a[0]); const n = (e ? Number(e.v) : 0) + (C === 'INCR' ? 1 : Number(a[1])); mem.set(a[0], { t: 's', v: String(n), exp: e?.exp }); return n; }
    case 'EXPIRE': { const e = live(a[0]); if (!e) return 0; e.exp = Date.now() + Number(a[1]) * 1000; return 1; }
    case 'DEL': { let n = 0; a.forEach(k => { if (mem.delete(k)) n++; }); return n; }
    case 'EXISTS': return a.filter(k => live(k)).length;
    case 'RENAME': { const e = live(a[0]); if (!e) throw new DbError('ERR no such key'); mem.delete(a[0]); mem.set(a[1], e); return 'OK'; }
    case 'HSET': { const h = hashOf(a[0], true); let n = 0; for (let i = 1; i < a.length; i += 2) { if (!h.has(a[i])) n++; h.set(String(a[i]), String(a[i + 1])); } return n; }
    case 'HGET': { const h = hashOf(a[0]); return h && h.has(a[1]) ? h.get(a[1]) : null; }
    case 'HMGET': { const h = hashOf(a[0]); return a.slice(1).map(f => (h && h.has(f) ? h.get(f) : null)); }
    case 'HGETALL': { const h = hashOf(a[0]); const out = []; if (h) h.forEach((v, k) => out.push(k, v)); return out; }
    case 'HDEL': { const h = hashOf(a[0]); let n = 0; if (h) a.slice(1).forEach(f => { if (h.delete(f)) n++; }); return n; }
    case 'HLEN': { const h = hashOf(a[0]); return h ? h.size : 0; }
    case 'ZADD': { let e = live(a[0]); if (!e) { e = { t: 'z', v: new Map() }; mem.set(a[0], e); } for (let i = 1; i < a.length; i += 2) e.v.set(String(a[i + 1]), Number(a[i])); return 1; }
    case 'ZRANGEBYSCORE': { const e = live(a[0]); if (!e) return []; const lo = String(a[1]), hi = String(a[2]); const lv = lo.startsWith('(') ? Number(lo.slice(1)) : Number(lo), excl = lo.startsWith('('); const hv = hi === '+inf' ? Infinity : Number(hi);
      return [...e.v.entries()].filter(([, s]) => (excl ? s > lv : s >= lv) && s <= hv).sort((x, y) => x[1] - y[1]).map(x => x[0]); }
    case 'ZREMRANGEBYRANK': { const e = live(a[0]); if (!e) return 0; const arr = [...e.v.entries()].sort((x, y) => x[1] - y[1]); const n = arr.length; let s = Number(a[1]), t = Number(a[2]); if (s < 0) s += n; if (t < 0) t += n; let c2 = 0; arr.forEach(([m], i) => { if (i >= s && i <= t) { e.v.delete(m); c2++; } }); return c2; }
    case 'ZRANGE': { const e = live(a[0]); if (!e) return []; const arr = [...e.v.entries()].sort((x, y) => x[1] - y[1]).map(x => x[0]); const n = arr.length; let s = Number(a[1]), t = Number(a[2]); if (s < 0) s += n; if (t < 0) t += n; return arr.slice(s, t + 1); }
    case 'ZCARD': { const e = live(a[0]); return e ? e.v.size : 0; }
    default: throw new DbError('Memory DB: unsupported command ' + C);
  }
}

/* ---------------- public API ---------------- */
export async function cmd(...args) { return (await pipe([args]))[0]; }

export async function pipe(cmds) {
  if (!cmds.length) return [];
  const b = backendName();
  if (b === 'memory') return cmds.map(c => memExec(c.map(x => (typeof x === 'number' ? x : x))));
  if (!b) throw new DbError('Database is not configured. Add the Upstash Redis integration in Vercel (KV_REST_API_URL / KV_REST_API_TOKEN).');
  const out = [];
  // keep each REST request comfortably under Upstash's request size limit
  let batch = [], size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const r = await fetch(URL_().replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN(), 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
    if (!r.ok) throw new DbError(`Database request failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    const js = await r.json();
    js.forEach(x => { if (x.error) throw new DbError('Database error: ' + x.error); out.push(x.result); });
    batch = []; size = 0;
  };
  for (const c of cmds) {
    const s = JSON.stringify(c).length;
    if (size + s > 700000 && batch.length) await flush();
    batch.push(c.map(String)); size += s;
  }
  await flush();
  return out;
}

export function pairs(arr) { const m = new Map(); for (let i = 0; i < (arr || []).length; i += 2) m.set(arr[i], arr[i + 1]); return m; }
export function parse(s) { if (s === null || s === undefined) return null; try { return JSON.parse(s); } catch { return null; } }

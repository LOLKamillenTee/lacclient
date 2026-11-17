// The LAC sync service as an ordinary Node program (for a free Oracle Cloud VM or any Linux box): the same worker.js and hub.js code that runs on Cloudflare,
// with a SQLite file in place of KV and the Durable Object. No request limit except what the machine can do.
//   PORT (default 8787), DB (default ./lac.db). HTTPS comes from Caddy in front of it (see deploy/Caddyfile).
import http from "node:http";
import Database from "better-sqlite3";
import worker from "../worker.js";
import { FriendsHub } from "../hub.js";
import { attachRelay } from "./relay-node.js";

const db = new Database(process.env.DB || "./lac.db");
db.pragma("journal_mode = WAL"); db.pragma("synchronous = NORMAL");
db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER); CREATE TABLE IF NOT EXISTS st (k TEXT PRIMARY KEY, v TEXT NOT NULL);");
const kvGet = db.prepare("SELECT v, exp FROM kv WHERE k = ?"), kvPut = db.prepare("INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp"), kvDel = db.prepare("DELETE FROM kv WHERE k = ?");
const stGet = db.prepare("SELECT v FROM st WHERE k = ?"), stPut = db.prepare("INSERT INTO st (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"), stAll = db.prepare("SELECT k, v FROM st");

/** Cloudflare KV as the worker uses it: get / put (with expirationTtl) / delete */
const LAC = {
  async get(k) { const r = kvGet.get(String(k)); if (!r) return null; if (r.exp && r.exp < Date.now()) { kvDel.run(String(k)); return null; } return r.v; },
  async put(k, v, o) { kvPut.run(String(k), String(v), o && o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : null); },
  async delete(k) { kvDel.run(String(k)); },
  /** KV list: keys in order, `cursor` = the last key of the previous page */
  async list({ prefix = "", cursor, limit = 1000 } = {}) {
    const rows = db.prepare("SELECT k FROM kv WHERE k >= ? AND (exp IS NULL OR exp >= ?) AND substr(k, 1, ?) = ? AND k > ? ORDER BY k LIMIT ?").all(prefix, Date.now(), prefix.length, prefix, cursor || "", limit + 1);
    const more = rows.length > limit; if (more) rows.pop();
    return { keys: rows.map((r) => ({ name: r.k })), list_complete: !more, cursor: more ? rows[rows.length - 1].k : undefined };
  },
};
/** Durable Object storage as the hub uses it: values of any JSON shape */
const storage = {
  async get(k) { const r = stGet.get(String(k)); return r ? JSON.parse(r.v) : undefined; },
  async put(k, v) { stPut.run(String(k), JSON.stringify(v)); },
  async list({ prefix = "" } = {}) { const m = new Map(); for (const r of stAll.all()) if (r.k.startsWith(prefix)) m.set(r.k, JSON.parse(r.v)); return m; },
};
const env = { LAC };
const hub = new FriendsHub({ storage }, env);
env.HUB = { idFromName: (n) => n, get: () => ({ fetch: (req) => hub.fetch(req) }) };   // one global instance, in this process

// old rows that have expired are removed now and then
setInterval(() => { try { db.prepare("DELETE FROM kv WHERE exp IS NOT NULL AND exp < ?").run(Date.now()); } catch { /* next time */ } }, 10 * 60_000);

const server = http.createServer(async (req, res) => {
  try {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 3_000_000) { res.writeHead(413); res.end("too large"); return; } chunks.push(c); }
    const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const request = new Request(url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const r = await worker.fetch(request, env);
    const out = Buffer.from(await r.arrayBuffer()); const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(r.status, h); res.end(out);
  } catch (e) { console.error(e); res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Serverfehler" })); }
});
attachRelay(server, worker, env);
server.listen(Number(process.env.PORT || 8787), "127.0.0.1", () => console.log("LAC sync service on 127.0.0.1:" + (process.env.PORT || 8787)));
process.on("SIGTERM", () => { try { db.close(); } catch { /* closed */ } process.exit(0); });

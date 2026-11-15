// Friends: presence, chat relay, join requests and invites. One Hub (a Cloudflare Durable Object in production) keeps everything in memory
// and writes accounts to storage only when they change, so polling costs no KV reads or writes.
//
// The client calls sync() every few seconds with its own presence (status, the name of the server or world, and the address to join), the
// events it has seen (ack) and any actions (ops). It gets back its friends with their presence and its pending events.
// The server address of a friend is NEVER sent to other friends as presence: it only travels inside a join_ok (after the friend accepted a
// request) or an invite, and the client does not show it.
import { validUuid, dashless } from "./logic.js";

const STATUS = new Set(["online", "afk", "offline"]);
const ALIVE_MS = 150_000, REQ_MS = 10 * 60_000, EVENT_MS = 14 * 86_400_000, MAX_FRIENDS = 100, MAX_EVENTS = 200;
const STAT_KEYS = ["lvl", "minutes", "walked", "mined", "hits", "adv", "deaths"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O/1/I

export class Hub {
  constructor(storage, kv, now = () => Date.now(), random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
    this.storage = storage; this.kv = kv; this.now = now; this.random = random;
    this.users = new Map(); this.presence = new Map(); this.rate = new Map();
  }

  async sha256(text) {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async load(uuid) {
    if (this.users.has(uuid)) return this.users.get(uuid);
    const u = await this.storage.get("u:" + uuid);
    if (u) this.users.set(uuid, u);
    return u || null;
  }
  async save(u) { await this.storage.put("u:" + u.uuid, u); }

  async newCode() {
    for (let i = 0; i < 20; i++) {
      const r = this.random(8); let code = "";
      for (const b of r) code += CODE_CHARS[b % CODE_CHARS.length];
      if (!(await this.storage.get("c:" + code))) return code;
    }
    throw new Error("kein freier Code");
  }

  event(u, e) {
    u.inbox.push({ id: this.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), ts: this.now(), ...e });
    if (u.inbox.length > MAX_EVENTS) u.inbox.splice(0, u.inbox.length - MAX_EVENTS);
  }

  limited(uuid, key, max) {
    const k = uuid + key, m = Math.floor(this.now() / 60_000), r = this.rate.get(k);
    if (!r || r.m !== m) { this.rate.set(k, { m, n: 1 }); return false; }
    return ++r.n > max;
  }

  online(uuid) { const p = this.presence.get(uuid); return !!p && p.status !== "offline" && this.now() - p.ts < ALIVE_MS; }

  async sync(b) {
    const uuid = dashless(String(b.uuid || ""));
    if (!validUuid(uuid)) return { status: 400, error: "UUID ungültig" };
    if (typeof b.key !== "string" || !/^[0-9a-f]{32,128}$/.test(b.key)) return { status: 400, error: "Schlüssel ungültig" };
    const hash = await this.sha256(b.key);   // the same hash the profile sync stores in KV (k:<uuid>)
    let u = await this.load(uuid);
    if (!u) {   // first use: the key must agree with the claim the profile sync made (if any)
      const owner = this.kv ? await this.kv.get("k:" + uuid) : null;
      if (owner && owner !== hash) return { status: 403, error: "Dieses Profil wurde schon von einem anderen Gerät beansprucht" };
      if (!owner && this.kv) await this.kv.put("k:" + uuid, hash, { expirationTtl: 180 * 86400 });
      const code = await this.newCode();
      u = { uuid, keyHash: hash, name: "", code, friends: [], inbox: [], reqsIn: {} };
      this.users.set(uuid, u); await this.storage.put("c:" + code, uuid);
    } else if (u.keyHash !== hash) {   // a new PC took the account over (see /v1/takeover): the claim in KV now holds the new key
      const owner = this.kv ? await this.kv.get("k:" + uuid) : null;
      if (owner !== hash) return { status: 403, error: "Schlüssel passt nicht" };
      u.keyHash = hash; await this.save(u);
    }

    let dirty = false;
    const name = /^[A-Za-z0-9_]{1,16}$/.test(String(b.name || "")) ? String(b.name) : u.name;
    if (name !== u.name) { u.name = name; dirty = true; }
    const p = b.presence;
    if (p && p.stats && typeof p.stats === "object") {   // numbers only, what friends may compare: level, minutes, blocks walked, mined, hits, advancements, deaths
      const st = {}; for (const k of STAT_KEYS) { const v = Number(p.stats[k]); if (Number.isFinite(v) && v >= 0) st[k] = Math.min(Math.floor(v), 1e12); }
      if (JSON.stringify(st) !== JSON.stringify(u.stats || {}) && this.now() - (u.statsAt || 0) > 60_000) { u.stats = st; u.statsAt = this.now(); dirty = true; }
    }
    if (p && STATUS.has(p.status)) {
      this.presence.set(uuid, { status: p.status, server: String(p.server || "").slice(0, 48), addr: /^[A-Za-z0-9.\-:_]{1,100}$/.test(String(p.addr || "")) ? String(p.addr) : "", ts: this.now() });
    }
    if (Array.isArray(b.ack) && b.ack.length) { const ack = new Set(b.ack.slice(0, 200).map(String)); const n = u.inbox.length; u.inbox = u.inbox.filter((e) => !ack.has(e.id)); if (u.inbox.length !== n) dirty = true; }
    const cut = this.now() - EVENT_MS; if (u.inbox.some((e) => e.ts < cut)) { u.inbox = u.inbox.filter((e) => e.ts >= cut); dirty = true; }

    const results = [], touched = new Set();
    for (const op of (Array.isArray(b.ops) ? b.ops : []).slice(0, 10)) {
      const r = await this.op(u, op, touched);
      results.push(r); if (r.ok) dirty = true;
    }
    if (dirty) touched.add(u);
    for (const t of touched) await this.save(t);

    const friends = [];
    for (const f of u.friends) {
      const fu = await this.load(f); if (!fu) continue;
      const pr = this.presence.get(f), on = this.online(f);
      friends.push({ uuid: f, name: fu.name, status: on ? pr.status : "offline", server: on ? pr.server : "", joinable: on && !!pr.addr, seen: pr ? pr.ts : 0, stats: fu.stats || {} });
    }
    return { status: 200, code: u.code, friends, events: u.inbox.slice(-100), results };
  }

  async op(u, op, touched) {
    const o = op && typeof op === "object" ? op : {};
    const friend = async () => { const id = dashless(String(o.to || o.uuid || "")); if (!validUuid(id) || !u.friends.includes(id)) return null; return this.load(id); };
    switch (o.op) {
      case "add": {
        const code = String(o.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (code.length !== 8) return { error: "Code ungültig" };
        if (this.limited(u.uuid, "add", 10)) return { error: "Zu viele Versuche" };
        const id = await this.storage.get("c:" + code), f = id ? await this.load(id) : null;
        if (!f) return { error: "Code nicht gefunden" };
        if (f.uuid === u.uuid) return { error: "Das ist dein eigener Code" };
        if (u.friends.includes(f.uuid)) return { error: "Ihr seid schon befreundet" };
        if (u.friends.length >= MAX_FRIENDS || f.friends.length >= MAX_FRIENDS) return { error: "Freundesliste voll" };
        u.friends.push(f.uuid); f.friends.push(u.uuid);
        this.event(f, { type: "friend_added", from: u.uuid, name: u.name }); this.event(u, { type: "friend_added", from: f.uuid, name: f.name });
        touched.add(f); return { ok: true, name: f.name };
      }
      case "remove": {
        const id = dashless(String(o.uuid || "")); const f = validUuid(id) ? await this.load(id) : null;
        u.friends = u.friends.filter((x) => x !== id); if (f) { f.friends = f.friends.filter((x) => x !== u.uuid); touched.add(f); }
        return { ok: true };
      }
      case "msg": {
        const f = await friend(); if (!f) return { error: "Kein Freund" };
        const text = String(o.text || "").trim().slice(0, 500); if (!text) return { error: "Leer" };
        if (this.limited(u.uuid, "msg", 30)) return { error: "Zu schnell" };
        this.event(f, { type: "msg", from: u.uuid, name: u.name, text }); touched.add(f); return { ok: true };
      }
      case "join_req": {
        const f = await friend(); if (!f) return { error: "Kein Freund" };
        if (!this.online(f.uuid)) return { error: "Offline" };
        if (this.limited(u.uuid, "req", 10)) return { error: "Zu schnell" };
        f.reqsIn = f.reqsIn || {}; f.reqsIn[u.uuid] = this.now();
        this.event(f, { type: "join_req", from: u.uuid, name: u.name, server: (this.presence.get(f.uuid) || {}).server || "" }); touched.add(f); return { ok: true };
      }
      case "join_ok": {
        const f = await friend(); if (!f) return { error: "Kein Freund" };
        const at = (u.reqsIn || {})[f.uuid]; if (!at || this.now() - at > REQ_MS) return { error: "Anfrage abgelaufen" };
        const pr = this.presence.get(u.uuid); if (!this.online(u.uuid) || !pr || !pr.addr) return { error: "Du bist auf keinem Server" };
        delete u.reqsIn[f.uuid];
        this.event(f, { type: "join_ok", from: u.uuid, name: u.name, server: pr.server, addr: pr.addr }); touched.add(f); return { ok: true };
      }
      case "join_no": {
        const f = await friend(); if (!f) return { error: "Kein Freund" };
        if (u.reqsIn) delete u.reqsIn[f.uuid];
        this.event(f, { type: "join_no", from: u.uuid, name: u.name }); touched.add(f); return { ok: true };
      }
      case "invite": {
        const f = await friend(); if (!f) return { error: "Kein Freund" };
        const pr = this.presence.get(u.uuid); if (!this.online(u.uuid) || !pr || !pr.addr) return { error: "Du bist auf keinem Server" };
        if (this.limited(u.uuid, "inv", 10)) return { error: "Zu schnell" };
        this.event(f, { type: "invite", from: u.uuid, name: u.name, server: pr.server, addr: pr.addr }); touched.add(f); return { ok: true };
      }
      default: return { error: "Unbekannt" };
    }
  }
}

/** Cloudflare Durable Object wrapper: one global instance */
export class FriendsHub {
  constructor(state, env) { this.hub = new Hub(state.storage, env.LAC); this.storage = state.storage; }
  async fetch(req) {
    let body; try { body = await req.json(); } catch { return Response.json({ error: "kein JSON" }, { status: 400 }); }
    if (new URL(req.url).pathname === "/live") {   // the "live" instance: profiles, ranks and roles, read and written in one place so a change is seen everywhere at once
      if (body.op === "get" && Array.isArray(body.keys)) { const v = {}; await Promise.all(body.keys.slice(0, 400).map(async (k) => { v[k] = await this.storage.get(String(k)); })); return Response.json({ v }); }
      if (body.op === "put" && typeof body.key === "string" && typeof body.value === "string" && body.value.length < 20000) { await this.storage.put(body.key, body.value); return Response.json({ ok: true }); }
      if (body.op === "dump") { const m = await this.storage.list(); return Response.json({ items: [...m].map(([k, v]) => [k, v]) }); }   // for moving to another host (worker.js /v1/admin/dump)
      return Response.json({ error: "ungültig" }, { status: 400 });
    }
    if (new URL(req.url).pathname === "/dump") { const m = await this.storage.list(); return Response.json({ items: [...m].map(([k, v]) => [k, v]) }); }
    const r = await this.hub.sync(body);
    return Response.json(r, { status: r.status || 200 });
  }
}

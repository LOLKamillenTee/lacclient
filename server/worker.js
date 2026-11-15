// LAC sync service (Cloudflare Worker + KV). It only stores what a player chose to show: equipped cosmetics, badge and name style.
//
// Who may write which profile:
//  1. If the client joined a Mojang session with a random id (joinServer) and Mojang confirms it (hasJoined), the account is proven and its
//     profile can always be written (this also lets the real owner take back a profile somebody else claimed).
//  2. Mojang's session server answers 403 to requests that come from Cloudflare Workers, so (1) usually cannot be checked. Then the first
//     client to upload for a UUID claims it with a random secret key; later uploads must present the same key.
import { sanitize, dashless, validUuid } from "./logic.js";
export { FriendsHub } from "./hub.js";
import { listPacks, getPack, getIcon, publish, removePack } from "./packs.js";
import ITEMS from "./catalog-ids.json" with { type: "json" };

const DEV_HASH = "e571ebc85c3c49cebaf117e556f1edfa653a47abf878ba2dbdcf40f1e3d1808f";   // sha256 of "lac-code:" + the Dev code
const PRO_HASH = "d3dd9ca618d84642e0e01f81f6a8d4ecf9934db3ee524ffe306d391c733279f3", PLUS_HASH = "6579677e08cee86e29cb6c97bfe05ecd9bf1ef996f397955073cbc0e90901d71";
const ORDER = ["free", "pro", "plus", "creator", "dev"];   // Creator: everything LAC+ gives, no Dev tools
const PLUS_ONLY = new Set(ITEMS.filter((i) => i.type === "morph" || i.type === "buddy" || i.type === "mount" || i.plus).map((i) => i.id));
const RANK_ITEM = new Map(ITEMS.filter((i) => i.rank).map((i) => [i.id, i.rank]));   // cosmetics only one rank may wear (Dev may wear all)
/** the Dev log: the last 150 changes Devs made (ranks, defaults, codes); "by" is what the Dev's client says */
async function devlog(env, by, what) {
  const log = JSON.parse((await env.LAC.get("devlog")) || "[]");
  log.push({ t: Date.now(), by: typeof by === "string" && /^[A-Za-z0-9_]{1,16}$/.test(by) ? by : "?", what: String(what).slice(0, 120) });
  await env.LAC.put("devlog", JSON.stringify(log.slice(-150)));
}
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...extra } });

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** @returns the proven uuid, or null when Mojang could not confirm (blocked, or not joined) */
async function mojangProof(name, serverId) {
  if (!serverId || !/^[A-Za-z0-9_]{1,16}$/.test(name) || !/^[A-Za-z0-9\-]{8,64}$/.test(serverId)) return null;
  try {
    const r = await fetch(`https://sessionserver.mojang.com/session/minecraft/hasJoined?username=${encodeURIComponent(name)}&serverId=${encodeURIComponent(serverId)}`, { headers: { "user-agent": "lac-sync/1.0" } });
    if (r.status !== 200) return null;
    const j = await r.json();
    return validUuid(j.id) ? dashless(j.id) : null;
  } catch { return null; }
}

/**
 * Profiles, ranks and roles must show up for everybody at once. KV keeps what it read for up to a minute in every region, so these live in one Durable Object
 * (a single strongly consistent copy). KV only answers for what was written before the move, and when there is no object (tests). A deleted key is stored as ""
 * (a missing one would fall back to the old KV value).
 */
async function liveCall(env, op) { const r = await env.HUB.get(env.HUB.idFromName("live")).fetch(new Request("https://hub/live", { method: "POST", body: JSON.stringify(op) })); return r.json(); }
async function lgetMany(env, keys) {
  let have = {}; if (env.HUB) { try { have = (await liveCall(env, { op: "get", keys })).v || {}; } catch { have = {}; } }
  const out = {};
  await Promise.all(keys.map(async (k) => { let v = have[k]; if (v === undefined || v === null) v = await env.LAC.get(k); out[k] = v === "" || v === undefined ? null : v; }));
  return out;
}
const lget = async (env, k) => (await lgetMany(env, [k]))[k];
async function lput(env, k, v) { if (env.HUB) { try { await liveCall(env, { op: "put", key: k, value: v }); return; } catch { /* KV below */ } } await env.LAC.put(k, v); }
const ldel = (env, k) => lput(env, k, "");

/** The rank is decided here, never by the client: a rank a Dev gave, else one proven with a redeem code (see /v1/rank), else free. */
async function authRank(env, id, roles) {
  const given = roles && roles[id] && roles[id].rank;
  if (ORDER.includes(given)) return given;
  const r = await lget(env, "rk:" + id);
  return ORDER.includes(r) ? r : "free";
}
/** what a rank is allowed to show: free has no badge/name styling; Transform and pets are LAC+ only */
const isRed = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return false;
  const c = parseInt(m[1], 16), r = (c >> 16 & 255) / 255, g = (c >> 8 & 255) / 255, b = (c & 255) / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn;
  if (mx < 0.35 || mx === 0 || dl / mx < 0.5) return false;
  let h = mx === r ? ((g - b) / dl) * 60 : mx === g ? (2 + (b - r) / dl) * 60 : (4 + (r - g) / dl) * 60; h = ((h % 360) + 360) % 360;
  return h <= 20 || h >= 340;
};
/** Free: everything white and still; Pro: colours, no animations; Plus: everything but red colours; Dev: everything */
function styleRules(o, rank) {
  const white = { color: "#ffffff", color2: "#ffffff", effects: [] };
  for (const k of ["tag", "name"]) {
    if (!o[k]) continue; let s = { ...o[k] };
    if (rank === "free") s = { ...white };
    else if (rank !== "dev") {
      if (rank === "pro") s.effects = [];
      if (isRed(s.color)) s.color = "#ffffff"; if (isRed(s.color2)) s.color2 = "#ffffff";
    }
    o[k] = s;
  }
}
/** the chat colour a rank may use: Free and Pro pick from a short list, Plus and Creator any colour but red, Dev anything */
const CHAT_FREE = ["#ffffff", "#aaaaaa", "#55ffff", "#55ff55"], CHAT_PRO = [...CHAT_FREE, "#ffff55", "#ff55ff", "#5555ff", "#ffaa00"];
const chatOk = (c, rank) => rank === "dev" || ((rank === "plus" || rank === "creator") && !isRed(c)) || (rank === "pro" && CHAT_PRO.includes(c)) || (rank === "free" && CHAT_FREE.includes(c));
function enforce(p, rank) {
  const o = { ...p, rank };
  if (o.chat && !chatOk(o.chat, rank)) o.chat = "";
  if (rank === "free") o.styled = false;
  styleRules(o, rank);
  if (rank !== "dev") for (const k of ["tag", "name"]) if (o[k] && (o[k].effects || []).includes("fire")) o[k] = { ...o[k], effects: o[k].effects.filter((e) => e !== "fire") };   // the Fire effect is for Devs only
  if (rank !== "dev") o.equipped = (o.equipped || []).filter((e) => !RANK_ITEM.has(e) || RANK_ITEM.get(e) === rank || ((rank === "plus" || rank === "creator") && (RANK_ITEM.get(e) === "pro" || (rank === "creator" && RANK_ITEM.get(e) === "plus"))));
  if (rank !== "plus" && rank !== "creator" && rank !== "dev") o.equipped = (o.equipped || []).filter((e) => !PLUS_ONLY.has(e));
  return o;
}

const b64 = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** Mojang's public keys that sign player certificates (cached for 12 h) */
async function mojangKeys(env) {
  const c = await env.LAC.get("mojkeys");
  if (c) return JSON.parse(c);
  const r = await fetch("https://api.minecraftservices.com/publickeys", { headers: { "user-agent": "lac-sync/1.0" } });
  if (r.status !== 200) return null;
  const j = await r.json(), keys = [...(j.playerCertificateKeys || []), ...(j.profilePropertyKeys || [])].map((k) => k.publicKey).filter(Boolean);
  if (!keys.length) return null;
  await env.LAC.put("mojkeys", JSON.stringify(keys), { expirationTtl: 12 * 3600 });
  return keys;
}

/**
 * A new PC takes over an account's claim: the player proves the account with the chat key pair Mojang certified for it (no token is sent anywhere).
 * Mojang signed (uuid, expiry, public key); only the owner has the private key, which signs a one-time nonce from this service.
 */
async function takeover(env, b) {
  const id = typeof b.uuid === "string" ? dashless(b.uuid) : "";
  if (!validUuid(id) || typeof b.key !== "string" || !/^[0-9a-f]{32,128}$/.test(b.key) || typeof b.nonce !== "string" || !/^[0-9a-f]{32}$/.test(b.nonce)) return json({ error: "ungültig" }, 400);
  const exp = Number(b.expiresAt); if (!Number.isFinite(exp) || exp < Date.now()) return json({ error: "Zertifikat abgelaufen" }, 403);
  if (!(await env.LAC.get("n:" + b.nonce))) return json({ error: "Anfrage abgelaufen, bitte nochmal" }, 403);
  await env.LAC.delete("n:" + b.nonce);   // one use
  let pub, sig, nsig;
  try { pub = b64(b.pub); sig = b64(b.sig); nsig = b64(b.nsig); } catch { return json({ error: "ungültig" }, 400); }
  if (pub.length > 1024 || sig.length > 1024 || nsig.length > 1024) return json({ error: "zu groß" }, 400);
  const payload = new Uint8Array(24 + pub.length), dv = new DataView(payload.buffer);
  for (let i = 0; i < 8; i++) { dv.setUint8(i, parseInt(id.slice(i * 2, i * 2 + 2), 16)); dv.setUint8(8 + i, parseInt(id.slice(16 + i * 2, 18 + i * 2), 16)); }
  dv.setBigInt64(16, BigInt(Math.floor(exp)), false); payload.set(pub, 24);
  const keys = await mojangKeys(env); if (!keys) return json({ error: "Mojang-Schlüssel nicht erreichbar" }, 503);
  let certified = false;
  for (const k of keys) { try { const ck = await crypto.subtle.importKey("spki", b64(k), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" }, false, ["verify"]); if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", ck, sig, payload)) { certified = true; break; } } catch { /* next key */ } }
  if (!certified) return json({ error: "Mojang bestätigt das Zertifikat nicht" }, 403);
  let ok = false;
  try { const pk = await crypto.subtle.importKey("spki", pub, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]); ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pk, nsig, new TextEncoder().encode(b.nonce)); } catch { /* not valid */ }
  if (!ok) return json({ error: "Signatur stimmt nicht" }, 403);
  await env.LAC.put("k:" + id, await sha256(b.key), { expirationTtl: 180 * 86400 });
  return json({ ok: true });
}

export default {
  async fetch(req, env) {
    try { return await this.handle(req, env); } catch (e) {
      const m = String((e && e.message) || e), full = /limit|quota|exceeded|too many/i.test(m);   // Cloudflare's free tier stops writes when the daily limit is used up
      return new Response(JSON.stringify({ error: full ? "Server-Limit erreicht (Schreibzugriffe von heute aufgebraucht). Versuche es später oder morgen noch einmal." : "Serverfehler: " + m.slice(0, 120) }), { status: full ? 429 : 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
    }
  },
  async handle(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return json({}, 204);
    if (url.pathname === "/v1/health") return json({ ok: true });
    if (url.pathname === "/v1/nonce" && req.method === "GET") { const n = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join(""); await env.LAC.put("n:" + n, "1", { expirationTtl: 120 }); return json({ nonce: n }, 200, { "cache-control": "no-store" }); }
    if (url.pathname === "/v1/takeover" && req.method === "POST") {
      const text = await req.text(); if (text.length > 4096) return json({ error: "zu groß" }, 413);
      let b; try { b = JSON.parse(text); } catch { return json({ error: "kein JSON" }, 400); }
      return takeover(env, b);
    }

    // LAC Modpacks: everybody can list and download, only the Dev rank publishes
    if (url.pathname === "/v1/packs" && req.method === "GET") return json({ packs: await listPacks(env) }, 200, { "cache-control": "public, max-age=10" });
    if (url.pathname.startsWith("/v1/packs/") && req.method === "GET") {
      const rest = url.pathname.slice("/v1/packs/".length);
      if (rest.endsWith("/icon")) { const b64 = await getIcon(env, rest.slice(0, -5)); if (!b64) return json({ error: "kein Bild" }, 404); return new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } }); }
      const p = await getPack(env, rest); return p ? json(p) : json({ error: "Modpack nicht gefunden" }, 404);
    }
    if (url.pathname === "/v1/packs" && req.method === "POST") {
      const text = await req.text(); if (text.length > 1_700_000) return json({ error: "zu groß" }, 413);
      let b; try { b = JSON.parse(text); } catch { return json({ error: "kein JSON" }, 400); }
      if (typeof b.code !== "string" || (await sha256("lac-code:" + b.code)) !== DEV_HASH) return json({ error: "kein Dev-Rang" }, 403);
      const r = b.remove ? await removePack(env, String(b.remove)) : await publish(env, b);
      return json(r, r.status || 200);
    }

    if (url.pathname === "/v1/f" && req.method === "POST") {   // friends: one request does presence, chat, requests and invites
      if (Number(req.headers.get("content-length") || 0) > 8192) return json({ error: "zu groß" }, 413);
      const r = await env.HUB.get(env.HUB.idFromName("main")).fetch(new Request("https://hub/", { method: "POST", body: await req.text() }));
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" } });
    }

    if (url.pathname === "/v1/profile" && req.method === "POST") {
      const text = await req.text();
      if (text.length > 4096) return json({ error: "zu groß" }, 413);
      let body; try { body = JSON.parse(text); } catch { return json({ error: "kein JSON" }, 400); }
      const claimed = dashless(body.uuid);
      if (!validUuid(claimed)) return json({ error: "UUID ungültig" }, 400);
      if (typeof body.key !== "string" || !/^[0-9a-f]{32,128}$/.test(body.key)) return json({ error: "Schlüssel ungültig" }, 400);
      const keyHash = await sha256(body.key);

      const proven = await mojangProof(String(body.name || ""), String(body.serverId || ""));
      if (proven && proven !== claimed) return json({ error: "Mojang bestätigt eine andere UUID" }, 403);
      if (!proven) {   // trust on first use
        const owner = await env.LAC.get("k:" + claimed);
        if (owner && owner !== keyHash) return json({ error: "Dieses Profil wurde schon von einem anderen Gerät beansprucht" }, 403);
      }
      const last = Number(await env.LAC.get("r:" + claimed) || 0);
      if (Date.now() - last < 2000) return json({ error: "zu schnell" }, 429);   // at most one upload every 2 s per player
      const clean = sanitize(body.profile, ITEMS);
      if (!clean) return json({ error: "Profil ungültig" }, 400);
      await env.LAC.put("r:" + claimed, String(Date.now()), { expirationTtl: 60 });         // KV keeps keys at least 60 s; the value holds the time
      await env.LAC.put("k:" + claimed, keyHash, { expirationTtl: 180 * 86400 });          // the claim (renewed by every upload)
      const roles = JSON.parse((await lget(env, "roles")) || "{}");
      clean.rank = await authRank(env, claimed, roles);   // whatever rank the client claims is ignored
      { const e = enforce(clean, clean.rank); e.seen = Date.now(); await lput(env, "p:" + claimed, JSON.stringify(e)); }   // seen: when this player was last in the game with LAC
      return json({ ok: true, verified: !!proven });
    }

    // Rank proof: the owner of a profile (device key) shows a redeem code; the service keeps only the rank, never the code. No code = back to free.
    if (url.pathname === "/v1/rank" && req.method === "POST") {
      const text = await req.text(); if (text.length > 512) return json({ error: "zu groß" }, 413);
      let b; try { b = JSON.parse(text); } catch { return json({ error: "kein JSON" }, 400); }
      const id = typeof b.uuid === "string" ? dashless(b.uuid) : "";
      if (!validUuid(id) || typeof b.key !== "string" || !/^[0-9a-f]{32,128}$/.test(b.key)) return json({ error: "ungültig" }, 400);
      const owner = await env.LAC.get("k:" + id); if (!owner || owner !== (await sha256(b.key))) return json({ error: "Profil gehört einem anderen Gerät" }, 403);
      let rank = "free";
      if (b.keep === true && !b.code) { const cur = await lget(env, "rk:" + id); return json({ ok: true, rank: ORDER.includes(cur) ? cur : "free" }); }   // a rank from a one-time code has no code to show again
      if (typeof b.code === "string" && b.code) {
        const h = await sha256("lac-code:" + b.code);
        rank = h === DEV_HASH ? "dev" : h === PLUS_HASH ? "plus" : h === PRO_HASH ? "pro" : null;
        if (!rank) return json({ error: "Code ungültig" }, 403);
      }
      if (rank === "free") await ldel(env, "rk:" + id); else await lput(env, "rk:" + id, rank);
      return json({ ok: true, rank });
    }

    // One-time codes: every Dev may make them (they prove themselves with the Dev code), the service keeps only a hash, a code works once and gives the rank for good.
    if (url.pathname === "/v1/codes" && req.method === "POST") {
      const text = await req.text(); if (text.length > 512) return json({ error: "zu groß" }, 413);
      let b; try { b = JSON.parse(text); } catch { return json({ error: "kein JSON" }, 400); }
      if (typeof b.code !== "string" || (await sha256("lac-code:" + b.code)) !== DEV_HASH) return json({ error: "kein Dev-Rang" }, 403);
      if (!["pro", "plus", "creator"].includes(b.rank)) return json({ error: "Rang muss pro, plus oder creator sein" }, 400);
      const n = Math.max(1, Math.min(20, Number(b.count) || 1)), A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", out = [];
      for (let i = 0; i < n; i++) {
        const r = crypto.getRandomValues(new Uint8Array(12)), c = "LAC-" + [0, 4, 8].map((o) => [...r.slice(o, o + 4)].map((x) => A[x % 32]).join("")).join("-");
        await env.LAC.put("rc:" + (await sha256("lac-code:" + c)), JSON.stringify({ rank: b.rank, at: Date.now() }));   // never expires: it stays until somebody redeems it
        out.push(c);
      }
      await devlog(env, b.by, `${out.length} Code(s) für ${b.rank} erzeugt`);
      return json({ ok: true, rank: b.rank, codes: out });
    }
    if (url.pathname === "/v1/redeem" && req.method === "POST") {
      const text = await req.text(); if (text.length > 512) return json({ error: "zu groß" }, 413);
      let b; try { b = JSON.parse(text); } catch { return json({ error: "kein JSON" }, 400); }
      const id = typeof b.uuid === "string" ? dashless(b.uuid) : "";
      if (!validUuid(id) || typeof b.key !== "string" || !/^[0-9a-f]{32,128}$/.test(b.key) || typeof b.code !== "string" || b.code.length > 40) return json({ error: "ungültig" }, 400);
      const owner = await env.LAC.get("k:" + id); if (!owner) return json({ error: "Noch nicht mit dem Dienst verbunden: bitte einmal Spiel oder Launcher mit Anmeldung starten" }, 403);
      if (owner !== (await sha256(b.key))) return json({ error: "Profil gehört einem anderen Gerät" }, 403);
      if (Date.now() - Number(await env.LAC.get("r:red:" + id) || 0) < 5000) return json({ error: "Bitte kurz warten" }, 429);   // one try every 5 seconds per account
      await env.LAC.put("r:red:" + id, String(Date.now()), { expirationTtl: 60 });
      const key = "rc:" + (await sha256("lac-code:" + b.code.trim().toUpperCase())), rec = await env.LAC.get(key);
      if (!rec) return json({ error: "Code ungültig oder schon benutzt" }, 403);
      let r; try { r = JSON.parse(rec); } catch { return json({ error: "Code ungültig" }, 403); }
      if (!["pro", "plus", "creator"].includes(r.rank)) return json({ error: "Code ungültig" }, 403);
      await env.LAC.delete(key);
      const cur = await lget(env, "rk:" + id); if (ORDER.indexOf(r.rank) > ORDER.indexOf(cur)) await lput(env, "rk:" + id, r.rank);   // never lowers a rank the account already has
      return json({ ok: true, rank: r.rank });
    }

    if (url.pathname === "/v1/devlog" && req.method === "POST") {
      const text = await req.text(); if (text.length > 512) return json({ error: "zu groß" }, 413);
      let b; try { b = JSON.parse(text); } catch { return json({ error: "kein JSON" }, 400); }
      if (typeof b.code !== "string" || (await sha256("lac-code:" + b.code)) !== DEV_HASH) return json({ error: "kein Dev-Rang" }, 403);
      return json({ log: JSON.parse((await env.LAC.get("devlog")) || "[]").reverse() });
    }

    // Default size and position of cosmetics, set by players with the Dev rank and shown to everybody.
    if (url.pathname === "/v1/defaults" && req.method === "GET") return json(JSON.parse((await env.LAC.get("defaults")) || "{}"), 200, { "cache-control": "public, max-age=15" });
    if (url.pathname === "/v1/defaults" && req.method === "POST") {
      const text = await req.text(); if (text.length > 1024) return json({ error: "zu groß" }, 413);
      let b; try { b = JSON.parse(text); } catch { return json({ error: "kein JSON" }, 400); }
      if (typeof b.code !== "string" || (await sha256("lac-code:" + b.code)) !== DEV_HASH) return json({ error: "kein Dev-Rang" }, 403);
      if (typeof b.id !== "string" || !ITEMS.some((i) => i.id === b.id) || !Array.isArray(b.a) || (b.a.length !== 5) || !b.a.every((n) => typeof n === "number" && isFinite(n))) return json({ error: "ungültig" }, 400);
      const [sc, x, y, z, br] = b.a, cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const all = JSON.parse((await env.LAC.get("defaults")) || "{}");
      all[b.id] = [cl(sc, 0.4, 2.5), cl(x, -12, 12), cl(y, -12, 12), cl(z, -12, 12), cl(br, 0.2, 1.5)];
      await env.LAC.put("defaults", JSON.stringify(all));
      await devlog(env, b.by, `Standard ${b.id}: ${b.a.map((n) => Math.round(n * 100) / 100).join(" ")}`);
      return json({ ok: true });
    }

    // Screenshots to share: a JPEG (at most ~1.4 MB) in KV for 60 days, shown on a small page. Only the owner of a profile may upload; one upload per 30 seconds.
    if (url.pathname === "/v1/shot" && req.method === "POST") {
      const text = await req.text(); if (text.length > 2_000_000) return json({ error: "zu groß" }, 413);
      let b; try { b = JSON.parse(text); } catch { return json({ error: "kein JSON" }, 400); }
      const id = typeof b.uuid === "string" ? dashless(b.uuid) : "";
      if (!validUuid(id) || typeof b.key !== "string" || !/^[0-9a-f]{32,128}$/.test(b.key) || typeof b.jpg !== "string" || !/^[A-Za-z0-9+/=]+$/.test(b.jpg)) return json({ error: "ungültig" }, 400);
      const owner = await env.LAC.get("k:" + id); if (!owner || owner !== (await sha256(b.key))) return json({ error: "Profil gehört einem anderen Gerät" }, 403);
      if (await env.LAC.get("r:shot:" + id)) return json({ error: "Bitte kurz warten" }, 429);
      if (!b.jpg.startsWith("/9j/")) return json({ error: "kein JPEG" }, 400);   // JPEG files start with FF D8 FF
      const CH = "abcdefghijkmnpqrstuvwxyz23456789"; let sid = ""; for (const x of crypto.getRandomValues(new Uint8Array(10))) sid += CH[x % CH.length];
      await env.LAC.put("shot:" + sid, b.jpg, { expirationTtl: 60 * 86400 });
      await env.LAC.put("r:shot:" + id, "1", { expirationTtl: 60 });
      return json({ id: sid, url: url.origin + "/s/" + sid });
    }
    if (url.pathname.startsWith("/s/") && req.method === "GET") {
      const sid = url.pathname.slice(3).replace(/[^a-z0-9]/g, ""); const v = sid.length === 10 ? await env.LAC.get("shot:" + sid) : null;
      if (!v) return new Response("Nicht gefunden", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      const page = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>LAC Screenshot</title><meta property="og:image" content="${url.origin}/v1/shot/${sid}.jpg"><style>body{margin:0;background:#0b0f1e;color:#e8eaf6;font:14px system-ui;display:grid;place-items:center;min-height:100vh;gap:12px;padding:16px;box-sizing:border-box}img{max-width:100%;max-height:82vh;border-radius:12px;box-shadow:0 12px 40px #0008}a{color:#00d4ff}</style><img src="/v1/shot/${sid}.jpg" alt="Screenshot"><div>Mit dem <b>LAC Client</b> aufgenommen</div>`;
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname.startsWith("/v1/shot/") && url.pathname.endsWith(".jpg") && req.method === "GET") {
      const sid = url.pathname.slice(9, -4).replace(/[^a-z0-9]/g, ""); const v = sid.length === 10 ? await env.LAC.get("shot:" + sid) : null;
      if (!v) return new Response("Nicht gefunden", { status: 404 });
      const bin = Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
      return new Response(bin, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" } });
    }

    // The default settings every new player starts with, saved by a Dev.
    if (url.pathname === "/v1/defaultcfg" && req.method === "GET") { const v = await env.LAC.get("defaultcfg"); return json(v ? JSON.parse(v) : {}, 200, { "cache-control": "public, max-age=30" }); }
    if (url.pathname === "/v1/defaultcfg" && req.method === "POST") {
      const text = await req.text(); if (text.length > 40000) return json({ error: "zu groß" }, 413);
      let b; try { b = JSON.parse(text); } catch { return json({ error: "kein JSON" }, 400); }
      if (typeof b.code !== "string" || (await sha256("lac-code:" + b.code)) !== DEV_HASH) return json({ error: "kein Dev-Rang" }, 403);
      if (typeof b.cfg !== "object" || b.cfg === null || JSON.stringify(b.cfg).length > 30000) return json({ error: "ungültig" }, 400);
      const old = JSON.parse((await env.LAC.get("defaultcfg")) || "{}");   // a tab saves only its own keys: merge
      const merged = { ...old, ...b.cfg }; if (old.hud && b.cfg.hud && typeof b.cfg.hud === "object") merged.hud = { ...old.hud, ...b.cfg.hud };   // one HUD element at a time
      await env.LAC.put("defaultcfg", JSON.stringify(merged));
      return json({ ok: true });
    }

    // Settings in the cloud: only the owner of a profile (same device key as the profile sync) may write or read them.
    if (url.pathname === "/v1/cfg" && req.method === "POST") {
      const text = await req.text(); if (text.length > 40000) return json({ error: "zu groß" }, 413);
      let b; try { b = JSON.parse(text); } catch { return json({ error: "kein JSON" }, 400); }
      const id = typeof b.uuid === "string" ? dashless(b.uuid) : "";
      if (!validUuid(id) || typeof b.key !== "string" || !/^[0-9a-f]{32,128}$/.test(b.key)) return json({ error: "ungültig" }, 400);
      const owner = await env.LAC.get("k:" + id); if (!owner || owner !== (await sha256(b.key))) return json({ error: "Profil gehört einem anderen Gerät" }, 403);
      if (b.cfg === undefined) { const v = await env.LAC.get("cfg:" + id); return json(v ? JSON.parse(v) : { stamp: 0 }); }   // read
      if (typeof b.cfg !== "object" || b.cfg === null || JSON.stringify(b.cfg).length > 30000) return json({ error: "ungültig" }, 400);
      await env.LAC.put("cfg:" + id, JSON.stringify(b.cfg), { expirationTtl: 400 * 86400 });
      return json({ ok: true });
    }
    // Share codes: anybody can hand out a layout; the code opens it for 30 days.
    if (url.pathname === "/v1/share" && req.method === "POST") {
      const text = await req.text(); if (text.length > 40000) return json({ error: "zu groß" }, 413);
      let b; try { b = JSON.parse(text); } catch { return json({ error: "kein JSON" }, 400); }
      if (typeof b.cfg !== "object" || b.cfg === null) return json({ error: "ungültig" }, 400);
      const CH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let code = ""; for (const x of crypto.getRandomValues(new Uint8Array(8))) code += CH[x % CH.length];
      await env.LAC.put("sh:" + code, JSON.stringify(b.cfg), { expirationTtl: 30 * 86400 });
      return json({ code });
    }
    if (url.pathname.startsWith("/v1/share/") && req.method === "GET") {
      const code = url.pathname.slice("/v1/share/".length).toUpperCase().replace(/[^A-Z0-9]/g, ""); const v = code.length === 8 ? await env.LAC.get("sh:" + code) : null;
      return v ? json(JSON.parse(v)) : json({ error: "Code nicht gefunden" }, 404);
    }

    // Roles given by Devs: uuid -> { name, rank }. Everyone may read them; only a request with the Dev code may change them.
    if (url.pathname === "/v1/roles" && req.method === "GET") return json(JSON.parse((await lget(env, "roles")) || "{}"), 200, { "cache-control": "no-store" });
    if (url.pathname === "/v1/roles" && req.method === "POST") {
      const text = await req.text(); if (text.length > 1024) return json({ error: "zu groß" }, 413);
      let b; try { b = JSON.parse(text); } catch { return json({ error: "kein JSON" }, 400); }
      if (typeof b.code !== "string" || (await sha256("lac-code:" + b.code)) !== DEV_HASH) return json({ error: "kein Dev-Rang" }, 403);
      if (!["free", "pro", "plus", "creator", "dev", "remove"].includes(b.rank)) return json({ error: "ungültiger Rang" }, 400);
      let id = typeof b.uuid === "string" ? dashless(b.uuid) : "", name = typeof b.name === "string" ? b.name : "";
      if (!validUuid(id)) {   // a name is looked up at Mojang
        if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return json({ error: "Name ungültig" }, 400);
        // Mojang's own lookups sometimes refuse requests from Cloudflare, so there are several sources
        const enc = encodeURIComponent(name), H = { "user-agent": "lac-sync" };
        const sources = [
          [`https://api.minecraftservices.com/minecraft/profile/lookup/name/${enc}`, (j) => j && j.id && { id: j.id, name: j.name }],
          [`https://api.mojang.com/users/profiles/minecraft/${enc}`, (j) => j && j.id && { id: j.id, name: j.name }],
          [`https://playerdb.co/api/player/minecraft/${enc}`, (j) => j && j.success && j.data && j.data.player && { id: j.data.player.raw_id, name: j.data.player.username }],
        ];
        let found = null;
        for (const [u, pick] of sources) {
          try { const r = await fetch(u, { headers: H }); if (r.status === 200) { found = pick(await r.json()); if (found && validUuid(dashless(found.id))) break; found = null; } } catch { /* next source */ }
        }
        if (!found) return json({ error: "Spieler nicht gefunden" }, 404);
        id = dashless(found.id); name = found.name;
      }
      const all = JSON.parse((await lget(env, "roles")) || "{}");
      if (b.rank === "remove") delete all[id]; else { if (Object.keys(all).length >= 500 && !all[id]) return json({ error: "Liste voll" }, 400); all[id] = { name: name.slice(0, 16), rank: b.rank }; }
      await lput(env, "roles", JSON.stringify(all));
      await devlog(env, b.by, b.rank === "remove" ? `${name || id}: Rolle entfernt` : `${name || id}: Rolle ${b.rank}`);
      return json({ ok: true, roles: all });
    }

    if (url.pathname === "/v1/profiles" && req.method === "GET") {
      const ids = (url.searchParams.get("ids") || "").split(",").map(dashless).filter(validUuid).slice(0, 40);
      const out = {};
      const got = await lgetMany(env, ["roles", ...ids.map((id) => "p:" + id), ...ids.map((id) => "rk:" + id)]), roles = JSON.parse(got.roles || "{}");
      for (const id of ids) {
        if (!got["p:" + id]) continue;
        const given = roles[id] && roles[id].rank, own = got["rk:" + id], rank = ORDER.includes(given) ? given : ORDER.includes(own) ? own : "free";   // the same decision as authRank
        { const stored = JSON.parse(got["p:" + id]); out[id] = enforce(stored, rank); out[id].age = stored.seen ? Date.now() - stored.seen : -1; }   // age in ms: the game only shows players seen lately
      }
      return json(out, 200, { "cache-control": "no-store" });
    }
    // Moving to another host: the owner (Dev code) reads everything out once. part "live" / "main" = the two Durable Object stores, "kv" = KV in pages of 100 keys.
    if (url.pathname === "/v1/admin/dump" && req.method === "POST") {
      let b; try { b = JSON.parse(await req.text()); } catch { return json({ error: "kein JSON" }, 400); }
      if (typeof b.code !== "string" || (await sha256("lac-code:" + b.code)) !== DEV_HASH) return json({ error: "kein Dev-Rang" }, 403);
      if (b.part === "live" || b.part === "main") { const r = await env.HUB.get(env.HUB.idFromName(b.part)).fetch(new Request(b.part === "live" ? "https://hub/live" : "https://hub/dump", { method: "POST", body: JSON.stringify({ op: "dump" }) })); return json(await r.json()); }
      if (b.part === "kv") {
        const l = await env.LAC.list({ cursor: b.cursor || undefined, limit: 100 }), items = [];
        for (const k of l.keys) { const v = await env.LAC.get(k.name); if (v !== null) items.push({ k: k.name, v, exp: k.expiration ? k.expiration * 1000 : null }); }
        return json({ items, cursor: l.list_complete ? null : l.cursor });
      }
      return json({ error: "part?" }, 400);
    }
    return json({ error: "unbekannt" }, 404);
  },
};

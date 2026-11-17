// node server/test.js : checks the validation and the worker routes with a fake KV and a fake Mojang
import { sanitize } from "./logic.js";
import worker from "./worker.js";
import { readFileSync } from "node:fs";
const ITEMS_FOR_TEST = JSON.parse(readFileSync(new URL("./catalog-ids.json", import.meta.url), "utf8"));
import assert from "node:assert/strict";

const items = [{ id: "wings_fairy", type: "wings" }, { id: "halo_star", type: "halo" }, { id: "wings_angel", type: "wings" }];
const ok = sanitize({ equipped: ["wings_fairy", "wings_angel", "halo_star", "evil"], chroma: { wings_fairy: 2, halo_star: 99 }, styled: true,
  tag: { color: "#ffffff", color2: "#000000", effects: ["gradient", "waving"] }, name: { color: "#7c5cff", color2: "#00d4ff", effects: ["rainbow", "glowing"] } }, items);
assert.deepEqual(ok.equipped, ["wings_fairy", "halo_star"]);
{   // every kind worn at once: none may be cut off (Transform and Companion are worn last)
  const all = ITEMS_FOR_TEST.filter((i, n, arr) => arr.findIndex((x) => x.type === i.type) === n).map((i) => i.id);
  assert.equal(all.length, 13); assert.equal(sanitize({ equipped: all, styled: false }, ITEMS_FOR_TEST).equipped.length, 13);
}

assert.deepEqual(ok.chroma, { wings_fairy: 2 });
assert.equal(ok.styled, true);
const bad = sanitize({ equipped: [], styled: true, tag: { color: "red", color2: "#000000", effects: [] }, name: { color: "#ffffff", color2: "#ffffff", effects: ["gradient", "rainbow"] } }, items);
assert.equal(bad.styled, false);

const UUID = "0123456789abcdef0123456789abcdef", KEY_A = "a".repeat(64), KEY_B = "b".repeat(64);
let kv = new Map(); const env = { LAC: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); } } };
let mojang = 403;   // what the (fake) Mojang session server answers
globalThis.fetch = async (u) => (String(u).includes("serverId=good") && mojang === 200 ? new Response(JSON.stringify({ id: UUID, name: "Steve" }), { status: 200 }) : new Response(null, { status: mojang === 200 ? 204 : mojang }));
const post = (b) => worker.fetch(new Request("https://x/v1/profile", { method: "POST", body: JSON.stringify(b) }), env);
const tick = () => { for (const k of [...kv.keys()]) if (k.startsWith("r:")) kv.delete(k); };   // the 20 s rate limit

// Mojang blocks us (403): first use claims the profile, the same key may update it, another key may not
assert.equal((await post({ uuid: UUID, name: "Steve", key: KEY_A, profile: ok })).status, 200); tick();
assert.equal((await post({ uuid: UUID, name: "Steve", key: KEY_A, profile: ok })).status, 200); tick();
assert.equal((await post({ uuid: UUID, name: "Steve", key: KEY_B, profile: ok })).status, 403); tick();
assert.equal((await post({ uuid: UUID, name: "Steve", key: "zz", profile: ok })).status, 400);
assert.equal((await post({ uuid: UUID, name: "Steve", key: KEY_A, profile: ok })).status, 200);
assert.equal((await post({ uuid: UUID, name: "Steve", key: KEY_A, profile: ok })).status, 429);   // rate limit
tick();
// Mojang confirms: the proven owner wins even against an earlier claim
mojang = 200;
const r = await post({ uuid: UUID, name: "Steve", serverId: "good-aaaa-1", key: KEY_B, profile: ok });
assert.equal(r.status, 200); assert.equal((await r.json()).verified, true); tick();
assert.equal((await post({ uuid: UUID, name: "Steve", key: KEY_A, profile: ok })).status, 403);   // the old key lost its claim
assert.equal((await post({ uuid: "f".repeat(32), name: "Steve", serverId: "good-aaaa-1", key: KEY_B, profile: ok })).status, 403);   // Mojang says another uuid

const got = await (await worker.fetch(new Request("https://x/v1/profiles?ids=" + UUID + ",ffffffffffffffffffffffffffffffff"), env)).json();
assert.equal(Object.keys(got).length, 1);
assert.deepEqual(got[UUID].equipped, ["wings_fairy", "halo_star"]);
console.log("server tests ok");

// roles: only with the Dev code
{
  const r = (b) => worker.fetch(new Request("https://x/v1/roles", { method: "POST", body: JSON.stringify(b) }), env);
  assert.equal((await r({ code: "nope", uuid: UUID, rank: "plus" })).status, 403);
  assert.equal((await r({ code: "DEV2026LAC", uuid: UUID, name: "Steve", rank: "plus" })).status, 200);
  assert.equal((await (await worker.fetch(new Request("https://x/v1/roles"), env)).json())[UUID].rank, "plus");
  assert.equal((await r({ code: "DEV2026LAC", uuid: UUID, rank: "remove" })).status, 200);
  console.log("roles ok");
}

// rank proof: the client's claimed rank is ignored; only a valid code (owner key) or a Dev role counts
{
  const KEYR = "e".repeat(64), U = "1111111111111111111111111111aaaa", sh = async (t) => { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join(""); };
  kv.set("k:" + U, await sh(KEYR));
  const rk = (b) => worker.fetch(new Request("https://x/v1/rank", { method: "POST", body: JSON.stringify(b) }), env);
  const prof = async () => (await (await worker.fetch(new Request("https://x/v1/profiles?ids=" + U), env)).json())[U];
  assert.equal((await post({ uuid: U, name: "Rankie", key: KEYR, profile: { ...ok, rank: "dev", tag: { color: "#ffffff", color2: "#000000", effects: ["fire"] } } })).status, 200); tick();
  assert.equal((await prof()).rank, "free"); assert.equal((await prof()).styled, false);
  assert.ok(!JSON.stringify((await prof()).tag.effects).includes("fire"));   // Fire is Dev only: stripped for others
  assert.equal((await prof()).tag.color, "#ffffff");   // Free: everything white   // claimed dev, but no proof
  tick(); assert.equal((await post({ uuid: U, name: "Rankie", key: KEYR, profile: { ...ok, equipped: ["cape_dev_code", "cape_pro_prism"] } })).status, 200);
  assert.ok(!(await prof()).equipped.includes("cape_dev_code") && !(await prof()).equipped.includes("cape_pro_prism"));   // rank cosmetics need the rank
  assert.equal((await rk({ uuid: U, key: "f".repeat(64), code: "x" })).status, 403);
  assert.equal((await rk({ uuid: U, key: KEYR, code: "falsch" })).status, 403);
  assert.equal((await rk({ uuid: U, key: KEYR, code: "DEV2026LAC" })).status, 200); assert.equal((await prof()).rank, "dev");
  assert.equal((await rk({ uuid: U, key: KEYR, code: "" })).status, 200); assert.equal((await prof()).rank, "free");
  console.log("rank ok");
}

// one-time codes: a Dev makes them, one account redeems each, it works once, and a rank from a code stays when the client shows no code
{
  const KEYC = "c".repeat(64), U = "2222222222222222222222222222bbbb", sh = async (t) => { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join(""); };
  kv.set("k:" + U, await sh(KEYC));
  const call = (path, b) => worker.fetch(new Request("https://x" + path, { method: "POST", body: JSON.stringify(b) }), env);
  assert.equal((await call("/v1/codes", { code: "nope", rank: "plus" })).status, 403);
  assert.equal((await call("/v1/codes", { code: "DEV2026LAC", rank: "dev" })).status, 400);   // no Dev codes
  const made = await (await call("/v1/codes", { code: "DEV2026LAC", rank: "plus", count: 2 })).json();
  assert.equal(made.codes.length, 2); assert.match(made.codes[0], /^LAC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await call("/v1/redeem", { uuid: U, key: "d".repeat(64), code: made.codes[0] })).status, 403);   // another device's key
  tick(); assert.equal((await call("/v1/redeem", { uuid: U, key: KEYC, code: "LAC-AAAA-BBBB-CCCC" })).status, 403);
  tick(); const ok1 = await call("/v1/redeem", { uuid: U, key: KEYC, code: made.codes[0].toLowerCase() }); assert.equal(ok1.status, 200); assert.equal((await ok1.json()).rank, "plus");
  tick(); assert.equal((await call("/v1/redeem", { uuid: U, key: KEYC, code: made.codes[0] })).status, 403);   // used up
  assert.equal(kv.get("rk:" + U), "plus");
  assert.equal((await call("/v1/rank", { uuid: U, key: KEYC, code: "", keep: true })).status, 200); assert.equal(kv.get("rk:" + U), "plus");   // keep: not reset
  assert.equal((await call("/v1/rank", { uuid: U, key: KEYC, code: "" })).status, 200); assert.ok(!kv.get("rk:" + U));   // the downgrade still works
  // Creator: its own rank, set by a code, wears Plus and Pro items but nothing Dev
  const U2 = "3333333333333333333333333333cccc", K2 = "9".repeat(64); kv.set("k:" + U2, await sh(K2));
  const cm = await (await call("/v1/codes", { code: "DEV2026LAC", rank: "creator" })).json();
  tick(); assert.equal((await (await call("/v1/redeem", { uuid: U2, key: K2, code: cm.codes[0] })).json()).rank, "creator"); assert.equal(kv.get("rk:" + U2), "creator");
  tick(); assert.equal((await post({ uuid: U2, name: "Creat", key: K2, profile: { ...ok, equipped: ["cape_plus_gold", "cape_dev_code"] } })).status, 200);
  const pc = (await (await worker.fetch(new Request("https://x/v1/profiles?ids=" + U2), env)).json())[U2];
  assert.equal(pc.rank, "creator"); assert.ok(pc.equipped.includes("cape_plus_gold") && !pc.equipped.includes("cape_dev_code"));
  // the Dev log: written by Dev actions, readable only with the Dev code
  assert.equal((await call("/v1/devlog", { code: "nope" })).status, 403);
  const lg = (await (await call("/v1/devlog", { code: "DEV2026LAC" })).json()).log; assert.ok(lg.length >= 1 && /Code/.test(lg[0].what) && typeof lg[0].t === "number");
  // chat colour: a plain colour by rank palette (Free: short list, Plus: no red, Dev: any)
  const chatOf = async (u) => (await (await worker.fetch(new Request("https://x/v1/profiles?ids=" + u), env)).json())[u].chat;
  tick(); await post({ uuid: U, name: "Chatty", key: KEYC, profile: { ...ok, chat: "#ff0000" } }); assert.equal(await chatOf(U), "");   // U is Plus (red not allowed)... after the downgrade above it is Free anyway
  tick(); await post({ uuid: U, name: "Chatty", key: KEYC, profile: { ...ok, chat: "#55ffff" } }); assert.equal(await chatOf(U), "#55ffff");
  tick(); await post({ uuid: U, name: "Chatty", key: KEYC, profile: { ...ok, chat: "#123456" } }); assert.equal(await chatOf(U), "");   // not in the Free list
  console.log("codes ok");
}

// the live store: profiles, ranks and roles in one Durable Object, KV only for what was there before
{
  const { FriendsHub } = await import("./hub.js");
  const store = new Map(), hub = new FriendsHub({ storage: { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v); } } }, { LAC: env.LAC });
  const env2 = { LAC: env.LAC, HUB: { idFromName: () => "live", get: () => ({ fetch: (req) => hub.fetch(req) }) } };
  const U3 = "4444444444444444444444444444dddd", K3 = "7".repeat(64), U4 = "5555555555555555555555555555eeee";
  const sh = async (t) => { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join(""); };
  kv.set("k:" + U3, await sh(K3)); tick();
  const w = (path, body, method = "POST") => worker.fetch(new Request("https://x" + path, { method, body: method === "GET" ? undefined : JSON.stringify(body) }), env2);
  const prof = async (u) => (await (await w("/v1/profiles?ids=" + u, null, "GET")).json())[u];
  assert.equal((await w("/v1/profile", { uuid: U3, name: "Live", key: K3, profile: ok })).status, 200);
  assert.ok(store.has("p:" + U3)); assert.ok(!kv.has("p:" + U3));   // written to the object, not to KV
  assert.equal((await prof(U3)).rank, "free");
  assert.equal((await w("/v1/roles", { code: "DEV2026LAC", uuid: U3, name: "Live", rank: "creator" })).status, 200);
  assert.equal((await prof(U3)).rank, "creator");   // seen at once
  assert.equal((await w("/v1/roles", { code: "DEV2026LAC", uuid: U3, rank: "remove" })).status, 200);
  assert.equal((await prof(U3)).rank, "free");
  kv.set("p:" + U4, JSON.stringify({ v: 1, rank: "free", chat: "", styled: false, equipped: [], chroma: {}, tag: { color: "#ffffff", color2: "#ffffff", effects: [] }, name: { color: "#ffffff", color2: "#ffffff", effects: [] } }));
  assert.ok(await prof(U4));   // an older profile that is only in KV still answers
  tick(); const cu = await (await w("/v1/codes", { code: "DEV2026LAC", rank: "pro" })).json();
  kv.set("k:" + U4, await sh(K3)); tick(); assert.equal((await w("/v1/redeem", { uuid: U4, key: K3, code: cu.codes[0] })).status, 200); assert.equal((await prof(U4)).rank, "pro");
  tick(); assert.equal((await w("/v1/rank", { uuid: U4, key: K3, code: "" })).status, 200); assert.equal((await prof(U4)).rank, "free");   // the downgrade is not undone by an older value in KV
  console.log("live ok");
}

// takeover: a new PC proves the account with the Mojang-certified chat key pair
{
  const U = "2222222222222222222222222222bbbb", gen = (hash) => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash }, true, ["sign", "verify"]);
  const moj = await gen("SHA-1"), player = await gen("SHA-256"), b64e = (u8) => Buffer.from(u8).toString("base64");
  const mojPub = b64e(await crypto.subtle.exportKey("spki", moj.publicKey)), pubDer = new Uint8Array(await crypto.subtle.exportKey("spki", player.publicKey));
  const oldFetch = globalThis.fetch; globalThis.fetch = async (u) => String(u).includes("publickeys") ? new Response(JSON.stringify({ playerCertificateKeys: [{ publicKey: mojPub }] })) : oldFetch(u);
  const exp = Date.now() + 86400000, payload = Buffer.alloc(24 + pubDer.length); Buffer.from(U, "hex").copy(payload, 0); payload.writeBigInt64BE(BigInt(exp), 16); Buffer.from(pubDer).copy(payload, 24);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", moj.privateKey, payload));
  const nonce = async () => (await (await worker.fetch(new Request("https://x/v1/nonce"), env)).json()).nonce;
  const tk = async (over = {}) => { const n = over.nonce || await nonce(); const nsig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", player.privateKey, new TextEncoder().encode(n)));
    return worker.fetch(new Request("https://x/v1/takeover", { method: "POST", body: JSON.stringify({ uuid: U, key: "9".repeat(64), nonce: n, expiresAt: exp, pub: b64e(pubDer), sig: b64e(sig), nsig: b64e(nsig), ...over }) }), env); };
  assert.equal((await tk()).status, 200);
  assert.equal((await tk({ nonce: "0".repeat(32) })).status, 403);                        // nonce never issued
  assert.equal((await tk({ sig: b64e(new Uint8Array(256)) })).status, 403);               // not certified by Mojang
  const other = await gen("SHA-256"), n2 = await nonce();
  assert.equal((await tk({ nonce: n2, nsig: b64e(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", other.privateKey, new TextEncoder().encode(n2)))) })).status, 403);   // somebody else's private key
  const n3 = await nonce(); assert.equal((await tk({ nonce: n3 })).status, 200); assert.equal((await tk({ nonce: n3 })).status, 403);   // one use
  globalThis.fetch = oldFetch;
  console.log("takeover ok");
}


// screenshots: owner only, JPEG only, then served
{
  const KEYS = "e".repeat(64), U = "0123456789abcdef0123456789abcdef";
  const hash = async (k) => { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(k)); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join(""); };
  kv.set("k:" + U, await hash(KEYS));
  const up = (b) => worker.fetch(new Request("https://x/v1/shot", { method: "POST", body: JSON.stringify(b) }), env);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
  assert.equal((await up({ uuid: U, key: "f".repeat(64), jpg })).status, 403);
  assert.equal((await up({ uuid: U, key: KEYS, jpg: Buffer.from("hello there").toString("base64") })).status, 400);
  const ok = await up({ uuid: U, key: KEYS, jpg }); assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal((await up({ uuid: U, key: KEYS, jpg })).status, 429);
  assert.equal((await worker.fetch(new Request("https://x/v1/shot/" + j.id + ".jpg"), env)).headers.get("content-type"), "image/jpeg");
  assert.equal((await worker.fetch(new Request("https://x/s/" + j.id), env)).status, 200);
  console.log("shots ok");
}

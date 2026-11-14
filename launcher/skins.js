// Skin changer: everything the Minecraft launcher's skin page does, through Mojang's own API (api.minecraftservices.com).
// The access token stays in this process and goes to Mojang only. A local library (skins/ in the LAC folder) keeps the skins you collect.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const core = require("./core");

const API = "https://api.minecraftservices.com";
const DIR = () => path.join(core.ROOT, "skins");
const INDEX = () => path.join(DIR(), "index.json");
const UA = { "user-agent": "LAC-Launcher" };

const readIndex = () => { try { return JSON.parse(fs.readFileSync(INDEX(), "utf8")); } catch { return []; } };
const writeIndex = (l) => { fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(INDEX(), JSON.stringify(l, null, 1)); };
const dataUri = (buf) => "data:image/png;base64," + buf.toString("base64");

/** a PNG buffer is a usable skin when it is 64x64 or 64x32 */
function checkPng(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("Das ist kein PNG-Bild");
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w !== 64 || (h !== 64 && h !== 32)) throw new Error(`Ein Skin muss 64x64 (oder 64x32) Pixel groß sein, dieses Bild ist ${w}x${h}`);
  if (buf.length > 24000) throw new Error("Die Skin-Datei ist zu groß");
}

async function mc(token, method, route, body, headers = {}) {
  const r = await fetch(API + route, { method, headers: { authorization: "Bearer " + token, ...UA, ...headers }, body, signal: AbortSignal.timeout(20000) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* no body */ }
  if (!r.ok) throw new Error((j && (j.errorMessage || j.error || j.path)) ? String(j.errorMessage || j.error) : "Mojang meldet " + r.status);
  return j;
}
async function img(url) { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error("Bild nicht ladbar"); return Buffer.from(await r.arrayBuffer()); }

/** the account's current skin and capes, with the pictures inline */
async function profile(token) {
  const p = await mc(token, "GET", "/minecraft/profile");
  const skin = (p.skins || []).find((s) => s.state === "ACTIVE") || null;
  const capes = [];
  for (const c of p.capes || []) { let pic = ""; try { pic = dataUri(await img(c.url)); } catch { /* shown without picture */ } capes.push({ id: c.id, alias: c.alias, active: c.state === "ACTIVE", pic }); }
  let pic = ""; if (skin) { try { pic = dataUri(await img(skin.url)); } catch { /* none */ } }
  return { name: p.name, skin: skin ? { variant: String(skin.variant || "CLASSIC").toLowerCase(), pic } : null, capes };
}

const library = () => readIndex().map((e) => { let pic = ""; try { pic = dataUri(fs.readFileSync(path.join(DIR(), e.id + ".png"))); } catch { /* file gone */ } return { ...e, pic }; });

function addToLibrary(buf, name, variant) {
  checkPng(buf);
  const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16), list = readIndex();
  if (!list.some((e) => e.id === hash)) { fs.mkdirSync(DIR(), { recursive: true }); fs.writeFileSync(path.join(DIR(), hash + ".png"), buf); list.unshift({ id: hash, name: String(name || "Skin").slice(0, 32), variant: variant === "slim" ? "slim" : "classic" }); writeIndex(list); }
  return hash;
}
function removeFromLibrary(id) { id = String(id).replace(/[^0-9a-f]/g, ""); writeIndex(readIndex().filter((e) => e.id !== id)); fs.rmSync(path.join(DIR(), id + ".png"), { force: true }); }
function setVariant(id, variant) { const l = readIndex(), e = l.find((x) => x.id === id); if (e) { e.variant = variant === "slim" ? "slim" : "classic"; writeIndex(l); } }
function rename(id, name) { const l = readIndex(), e = l.find((x) => x.id === id); if (e) { e.name = String(name || "Skin").slice(0, 32); writeIndex(l); } }

/** upload a skin from the library to the account */
async function apply(token, id, variant) {
  id = String(id).replace(/[^0-9a-f]/g, ""); const buf = fs.readFileSync(path.join(DIR(), id + ".png"));
  variant = variant === "slim" ? "slim" : "classic";
  const fd = new FormData(); fd.append("variant", variant); fd.append("file", new Blob([buf], { type: "image/png" }), "skin.png");
  await mc(token, "POST", "/minecraft/profile/skins", fd);
  setVariant(id, variant);
}
const reset = (token) => mc(token, "DELETE", "/minecraft/profile/skins/active");
const setCape = (token, capeId) => capeId ? mc(token, "PUT", "/minecraft/profile/capes/active", JSON.stringify({ capeId: String(capeId) }), { "content-type": "application/json" }) : mc(token, "DELETE", "/minecraft/profile/capes/active");

/** copy the skin another player wears (by name) into the library */
async function fromName(name) {
  name = String(name || "").trim(); if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error("Ungültiger Name");
  const r = await fetch("https://api.mojang.com/users/profiles/minecraft/" + name, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (r.status !== 200) throw new Error("Spieler nicht gefunden");
  const j = await r.json(), s = await (await fetch("https://sessionserver.mojang.com/session/minecraft/profile/" + j.id, { headers: UA, signal: AbortSignal.timeout(15000) })).json();
  const tex = (s.properties || []).find((p) => p.name === "textures"); if (!tex) throw new Error("Kein Skin gefunden");
  const sk = JSON.parse(Buffer.from(tex.value, "base64").toString("utf8")).textures.SKIN; if (!sk) throw new Error("Dieser Spieler hat keinen eigenen Skin");
  if (!/^https?:\/\/textures\.minecraft\.net\//.test(sk.url)) throw new Error("Unerwartete Skin-Adresse");
  return addToLibrary(await img(sk.url), j.name, sk.metadata && sk.metadata.model === "slim" ? "slim" : "classic");
}

/** the account's own current skin into the library */
async function fromAccount(token) {
  const p = await mc(token, "GET", "/minecraft/profile"), s = (p.skins || []).find((x) => x.state === "ACTIVE"); if (!s) throw new Error("Kein Skin gesetzt");
  return addToLibrary(await img(s.url), p.name, String(s.variant).toLowerCase() === "slim" ? "slim" : "classic");
}

async function nameAvailable(token, name) { if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error("3 bis 16 Zeichen: Buchstaben, Zahlen, _"); return (await mc(token, "GET", `/minecraft/profile/name/${name}/available`)).status === "AVAILABLE"; }
async function changeName(token, name) { if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error("3 bis 16 Zeichen: Buchstaben, Zahlen, _"); return mc(token, "PUT", `/minecraft/profile/name/${name}`); }

const byUuidCache = new Map();
/** any player's current skin by UUID (public data, no login needed): { pic (data URI), slim } */
async function byUuid(uuid) {
  uuid = String(uuid || "").replace(/-/g, "").toLowerCase(); if (!/^[0-9a-f]{32}$/.test(uuid)) throw new Error("Ungültige UUID");
  const hit = byUuidCache.get(uuid); if (hit && Date.now() - hit.t < 60000) return hit.v;
  const s = await (await fetch("https://sessionserver.mojang.com/session/minecraft/profile/" + uuid, { headers: UA, signal: AbortSignal.timeout(15000) })).json();
  const tex = (s.properties || []).find((p) => p.name === "textures"); if (!tex) throw new Error("Kein Skin gefunden");
  const sk = JSON.parse(Buffer.from(tex.value, "base64").toString("utf8")).textures.SKIN; if (!sk || !/^https?:\/\/textures\.minecraft\.net\//.test(sk.url)) throw new Error("Kein Skin gefunden");
  const v = { pic: dataUri(await img(sk.url)), slim: !!(sk.metadata && sk.metadata.model === "slim") }; byUuidCache.set(uuid, { t: Date.now(), v }); return v;
}

module.exports = { byUuid, profile, library, addToLibrary, removeFromLibrary, rename, apply, reset, setCape, fromName, fromAccount, nameAvailable, changeName };

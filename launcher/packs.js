// LAC Modpacks (the registry on the sync service), profile pictures, and the request folder the game uses to talk to the launcher.
const fs = require("fs");
const path = require("path");
const core = require("./core");
const share = require("./share");
const store = require("./store");

const DEFAULT_BASE = "https://lac-sync.lacclient.workers.dev";
const ICONS = () => path.join(core.ROOT, "icons");
const REQ = () => path.join(core.ROOT, "requests");

const base = () => { try { const u = fs.readFileSync(path.join(core.ROOT, "sync.url"), "utf8").trim(); if (/^https:\/\//.test(u)) return u.replace(/\/+$/, ""); } catch { /* default */ } return DEFAULT_BASE; };
const getJson = async (url, opts) => { const r = await fetch(url, { signal: AbortSignal.timeout(20000), ...opts }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Server meldet ${r.status}`); return j; };

/* The registry is mirrored into the GitHub repository (packs/, kept current by .github/workflows/sync-packs.yml): when the sync service is down or its daily limit is used up, the launcher reads the packs from there. */
const RAW = () => `https://raw.githubusercontent.com/${JSON.parse(fs.readFileSync(path.join(__dirname, "update.json"), "utf8")).repo}/main/packs`;
const rawJson = async (f) => { const r = await fetch(`${RAW()}/${f}?t=${Math.floor(Date.now() / 60000)}`, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`GitHub meldet ${r.status}`); return r.json(); };
let via = "server";
/** the registry's packs: from the sync service, else from GitHub */
async function index() {
  try { const l = (await getJson(base() + "/v1/packs")).packs || []; via = "server"; return l; }
  catch (e) { try { const l = (await rawJson("index.json")).packs || []; via = "github"; return l; } catch { throw e; } }
}
/** one pack with its share code, by id or pack code */
async function packData(idOrCode) {
  const key = String(idOrCode).trim();
  try { return await getJson(base() + "/v1/packs/" + encodeURIComponent(key)); }
  catch (e) { try { const hit = ((await rawJson("index.json")).packs || []).find((p) => p.id === key || String(p.code).toUpperCase() === key.toUpperCase()); if (!hit) throw e; return await rawJson(hit.id + ".json"); } catch { throw e; } }
}

const iconFile = (id) => path.join(ICONS(), id + ".png");

/** the profile picture as a PNG buffer (resized by the caller), stored for the profile */
function setIcon(profileId, png) {
  fs.mkdirSync(ICONS(), { recursive: true }); fs.writeFileSync(iconFile(profileId), png);
  const all = core.readProfiles(), p = all.find((x) => x.id === profileId); if (p) { p.icon = profileId + ".png?" + Date.now(); core.writeProfiles(all); }
  return core.readProfiles();
}

async function list() { const l = await index(); return l.map((p) => ({ ...p, iconUrl: p.icon ? (via === "github" ? `${RAW()}/${p.id}.png` : `${base()}/v1/packs/${p.id}/icon`) : "" })); }

/** installs a registry pack (by id or pack code) as a new profile, with its creator and picture */
async function install(idOrCode, send = () => {}) {
  const p = await packData(idOrCode);
  const profiles = await share.importCode(p.share, send), prof = profiles[profiles.length - 1];
  prof.creator = p.creator; prof.fromPack = p.id; prof.name = p.name; prof.desc = p.desc; prof.packVer = p.ver || 1;
  prof.packModIds = (share.decode(p.share).profile.mods || []).filter((m) => !m.dep && m.id).map((m) => String(m.id));   // what the pack had: an update removes only these
  if (p.hasIcon) { try { let r = await fetch(base() + `/v1/packs/${p.id}/icon`, { signal: AbortSignal.timeout(20000) }).catch(() => null); if (!r || !r.ok) r = await fetch(`${RAW()}/${p.id}.png`, { signal: AbortSignal.timeout(20000) }); if (r.ok) { fs.mkdirSync(ICONS(), { recursive: true }); fs.writeFileSync(iconFile(prof.id), Buffer.from(await r.arrayBuffer())); prof.icon = prof.id + ".png?" + Date.now(); } } catch { /* no picture is fine */ } }
  core.writeProfiles(profiles);
  return { profiles, profile: prof };
}

/** the LAC modpacks the player has, and which of them have a newer version in the registry: [{profile, ver, latest}] */
async function updates() {
  const reg = await list(), out = [];
  for (const prof of core.readProfiles()) {
    if (!prof.fromPack) continue;
    const r = reg.find((x) => x.id === prof.fromPack);
    if (r && (r.ver || 1) > (prof.packVer || 1)) out.push({ profile: prof.id, name: prof.name, ver: prof.packVer || 1, latest: r.ver || 1 });
  }
  return out;
}

/** loads the newest version of a LAC modpack into the profile it was installed as; settings, worlds, resource packs and shaders stay */
async function update(profileId, send = () => {}) {
  const all = core.readProfiles(), prof = all.find((x) => x.id === profileId);
  if (!prof || !prof.fromPack) throw new Error("Dieses Profil ist kein LAC Modpack");
  const p = await packData(prof.fromPack);
  const data = share.decode(p.share);
  const ids = await share.applyUpdate(profileId, data, prof.packModIds, send);
  const again = core.readProfiles(), q = again.find((x) => x.id === profileId);
  q.packVer = p.ver || 1; q.packModIds = ids; q.desc = p.desc; if (data.profile.mc) q.mc = data.profile.mc; if (data.profile.loader) q.loader = data.profile.loader;
  core.writeProfiles(again);
  return { profiles: again, version: q.packVer };
}

/** Dev rank: publish (or update) a profile as a LAC Modpack */
async function publish(userUuid, profileId, desc) {
  const me = store.me(userUuid);
  if (!me.dev || !me.devCode) throw new Error("Zum Veröffentlichen brauchst du den Dev-Code: löse ihn unter Rang ein (ein vergebener Rang allein reicht dafür nicht).");
  const all = core.readProfiles(), prof = all.find((x) => x.id === profileId);
  if (!prof) throw new Error("Profil nicht gefunden");
  let icon = ""; try { const b = fs.readFileSync(iconFile(profileId)); if (b.length <= 60000) icon = b.toString("base64"); } catch { /* none */ }
  const body = { code: me.devCode, id: prof.packId || undefined, pack: { name: prof.name, creator: prof.creator || "", desc: String(desc || prof.desc || ""), mc: prof.mc, loader: prof.loader, mods: (prof.mods || []).length, share: share.exportCode(profileId), icon } };
  const r = await getJson(base() + "/v1/packs", { method: "POST", body: JSON.stringify(body) });
  prof.packId = r.id; prof.packCode = r.code; if (desc) prof.desc = String(desc); core.writeProfiles(all);
  return { id: r.id, code: r.code, profiles: all };
}

async function remove(userUuid, id) {
  const me = store.me(userUuid); if (!me.dev || !me.devCode) throw new Error("Zum Veröffentlichen brauchst du den Dev-Code: löse ihn unter Rang ein (ein vergebener Rang allein reicht dafür nicht).");
  await getJson(base() + "/v1/packs", { method: "POST", body: JSON.stringify({ code: me.devCode, remove: id }) });
  return true;
}

/* ---------------- the game talks to the launcher through files ---------------- */
let timer = null;
/** @param handler (request) => void; the launcher answers requests the game wrote into requests/ and tells the game it is alive */
function startBridge(exePath, handler) {
  fs.mkdirSync(REQ(), { recursive: true });
  const beat = () => { try { fs.writeFileSync(path.join(core.ROOT, "launcher.alive"), String(Date.now())); } catch { /* ignore */ } };
  try { if (!/win-unpacked|node_modules/.test(exePath)) fs.writeFileSync(path.join(core.ROOT, "launcher.path"), exePath); } catch { /* ignore */ }
  beat();
  timer = setInterval(() => {
    beat();
    let names = []; try { names = fs.readdirSync(REQ()); } catch { return; }
    for (const n of names.filter((x) => x.endsWith(".json")).sort()) {
      const f = path.join(REQ(), n); let req = null;
      try { req = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* half written: next round */ if (Date.now() - fs.statSync(f).mtimeMs > 10000) fs.rmSync(f, { force: true }); continue; }
      fs.rmSync(f, { force: true });
      try { handler(req); } catch (e) { console.error("[lac] request failed:", e?.message || e); }
    }
  }, 1500);
}

module.exports = { updates, update, base, list, install, publish, remove, setIcon, iconFile, startBridge, base };

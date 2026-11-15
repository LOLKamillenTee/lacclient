// Profile sharing without any server: a text code (mod list + mod settings) or a ZIP (mods, settings), never cosmetics.
// Cosmetics live in lac.dat outside the instance folder, so they cannot end up in either.
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const cp = require("child_process");
const core = require("./core");

const PREFIX = "LACP1:";
const MAX_CONFIG_FILE = 256 * 1024, MAX_CONFIG_TOTAL = 4 * 1024 * 1024;
const instDir = (id) => path.dirname(core.modsDir(id));

/** The profile without machine-specific bits (java path) and without the LAC mod itself. */
function slim(p) {
  return { name: p.name, creator: p.creator || "", loader: p.loader, mc: p.mc, ram: p.ram || "4096M", jvmArgs: p.jvmArgs || "", lac: p.lac !== false,
    servers: core.cleanServers(p.servers),
    mods: (p.mods || []).map((m) => ({ id: m.id, title: m.title, file: m.file, dep: !!m.dep, requiredBy: m.requiredBy || [] })) };
}

/** Text files of the instance's config folder: mod settings, including LAC's own HUD layout (config/lac.json). */
function readConfigs(id) {
  const root = path.join(instDir(id), "config"), out = {};
  let total = 0;
  const walk = (dir) => {
    let names = []; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) {
        const st = fs.statSync(f); if (st.size > MAX_CONFIG_FILE || total + st.size > MAX_CONFIG_TOTAL) continue;
        total += st.size; out[path.relative(root, f).split(path.sep).join("/")] = fs.readFileSync(f).toString("base64");
      }
    }
  };
  walk(root);
  return out;
}

/** Writes config files below config/, refusing any path that would leave that folder. */
function writeConfigs(id, files) {
  const root = path.join(instDir(id), "config");
  for (const [rel, b64] of Object.entries(files || {})) {
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(b64, "base64"));
  }
}

function exportCode(profileId) {
  const p = core.readProfiles().find((x) => x.id === profileId);
  if (!p) throw new Error("Profil nicht gefunden");
  const payload = JSON.stringify({ v: 1, profile: slim(p), config: readConfigs(profileId) });
  return PREFIX + zlib.deflateRawSync(Buffer.from(payload), { level: 9 }).toString("base64url");
}

function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

/** Creates a profile from a decoded share payload. Mods are fetched from Modrinth (code) or already present (zip). */
async function create(data, send, modsFrom) {
  const s = data.profile;
  if (!s || !core.LOADERS.includes(s.loader) || typeof s.mc !== "string" || typeof s.name !== "string") throw new Error("Ungültiges Profil");
  const prof = { id: newId(), creator: typeof s.creator === "string" ? s.creator.slice(0, 24) : "", name: s.name.slice(0, 60), loader: s.loader, mc: s.mc, mods: [], ram: s.ram || "4096M", minRam: "", java: "", jvmArgs: typeof s.jvmArgs === "string" ? s.jvmArgs : "", width: "", height: "", lac: s.lac !== false, playtime: 0 };
  prof.servers = core.cleanServers(s.servers);
  const all = core.readProfiles(); all.push(prof); core.writeProfiles(all);
  fs.mkdirSync(core.modsDir(prof.id), { recursive: true });
  const list = Array.isArray(s.mods) ? s.mods : [];
  if (modsFrom) {   // zip: the jars came along
    for (const m of list) {
      const src = path.join(modsFrom, path.basename(String(m.file)));
      if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(core.modsDir(prof.id), path.basename(src))); prof.mods.push({ id: m.id, title: m.title, file: path.basename(src), dep: !!m.dep, requiredBy: m.requiredBy || [] }); }
    }
    const all2 = core.readProfiles(); all2.find((x) => x.id === prof.id).mods = prof.mods; core.writeProfiles(all2);
  } else {          // code: download the main mods, their dependencies come automatically
    for (const m of list.filter((x) => !x.dep && x.id)) {
      send({ type: "log", line: `Lade ${m.title || m.id}…` });
      try { await core.addMod(prof.id, { id: String(m.id), title: m.title }, send); } catch (e) { send({ type: "log", line: `Übersprungen: ${m.title || m.id} (${e.message})` }); }
    }
  }
  writeConfigs(prof.id, data.config);
  return core.readProfiles();
}

/** the profile data inside a share code */
function decode(code) {
  code = String(code).trim();
  if (!code.startsWith(PREFIX)) throw new Error("Das ist kein LAC-Profilcode");
  try { return JSON.parse(zlib.inflateRawSync(Buffer.from(code.slice(PREFIX.length), "base64url"), { maxOutputLength: 32 * 1024 * 1024 }).toString("utf8")); } catch { throw new Error("Der Code ist beschädigt oder unvollständig"); }
}

/**
 * Brings an existing profile to the state of a newer share code, keeping what the player has: worlds, options, resource packs, shaders,
 * mods they added themselves and every config file they already have. Pack mods that are gone from the pack are removed, new ones installed.
 * @param oldIds the mod ids the pack had when the profile was installed or last updated
 */
async function applyUpdate(profileId, data, oldIds, send = () => {}) {
  const s = data.profile; if (!s || !core.LOADERS.includes(s.loader)) throw new Error("Ungültiges Profil");
  const newMain = (Array.isArray(s.mods) ? s.mods : []).filter((x) => !x.dep && x.id);
  const newIds = new Set(newMain.map((m) => String(m.id)));
  for (const id of oldIds || []) if (!newIds.has(id)) { try { core.removeMod(profileId, id); } catch { /* already gone */ } }
  for (const m of newMain) {
    const have = (core.readProfiles().find((x) => x.id === profileId).mods || []).some((x) => x.id === String(m.id));
    if (have) continue;
    send({ type: "log", line: `Lade ${m.title || m.id}…` });
    try { await core.addMod(profileId, { id: String(m.id), title: m.title }, send); } catch (e) { send({ type: "log", line: `Übersprungen: ${m.title || m.id} (${e.message})` }); }
  }
  { const all = core.readProfiles(), me = all.find((x) => x.id === profileId); if (me) { me.servers = core.cleanServers(s.servers); core.writeProfiles(all); } }   // the modpack's servers follow the modpack
  // config files: only the ones the player does not have yet (their own settings stay)
  const root = path.join(instDir(profileId), "config");
  const fresh = {}; for (const [rel, b64] of Object.entries(data.config || {})) { const t = path.resolve(root, rel); if (t.startsWith(root + path.sep) && !fs.existsSync(t)) fresh[rel] = b64; }
  writeConfigs(profileId, fresh);
  return [...newIds];
}

async function importCode(code, send = () => {}) {
  code = String(code).trim();
  if (!code.startsWith(PREFIX)) throw new Error("Das ist kein LAC-Profilcode");
  let data;
  try { data = JSON.parse(zlib.inflateRawSync(Buffer.from(code.slice(PREFIX.length), "base64url"), { maxOutputLength: 32 * 1024 * 1024 }).toString("utf8")); } catch { throw new Error("Der Code ist beschädigt oder unvollständig"); }
  return create(data, send, null);
}

const ps = (args) => process.platform !== "win32" ? Promise.reject(new Error("nur unter Windows")) : new Promise((resolve, reject) => {
  const p = cp.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ...args], { windowsHide: true });
  let err = ""; p.stderr.on("data", (d) => (err += d)); p.on("error", reject);
  p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(err.trim() || `PowerShell Code ${c}`))));
});

/** ZIP with profile.json, mods/*.jar and config/**. Built in a temp folder, then compressed with Windows' own zip support. */
async function exportZip(profileId, file) {
  const p = core.readProfiles().find((x) => x.id === profileId);
  if (!p) throw new Error("Profil nicht gefunden");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lac-share-"));
  try {
    fs.writeFileSync(path.join(tmp, "lacprofile.json"), JSON.stringify({ v: 1, profile: slim(p) }, null, 2));
    fs.mkdirSync(path.join(tmp, "mods"));
    for (const m of p.mods || []) { const src = path.join(core.modsDir(p.id), m.file); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, "mods", m.file)); }
    const cfg = path.join(instDir(p.id), "config");
    if (fs.existsSync(cfg)) fs.cpSync(cfg, path.join(tmp, "config"), { recursive: true });
    fs.rmSync(file, { force: true });
    if (process.platform !== "win32") { const z = new (require("adm-zip"))(); z.addLocalFolder(tmp); z.writeZip(file); } else await ps(["Compress-Archive", "-Path", `'${tmp.replace(/'/g, "''")}\\*'`, "-DestinationPath", `'${file.replace(/'/g, "''")}'`, "-Force"]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function importZip(file, send = () => {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lac-import-"));
  try {
    if (process.platform !== "win32") new (require("adm-zip"))(file).extractAllTo(tmp, true); else await ps(["Expand-Archive", "-LiteralPath", `'${file.replace(/'/g, "''")}'`, "-DestinationPath", `'${tmp.replace(/'/g, "''")}'`, "-Force"]);
    const meta = path.join(tmp, "lacprofile.json");
    if (!fs.existsSync(meta)) throw new Error("Das ZIP enthält kein LAC-Profil");
    const data = JSON.parse(fs.readFileSync(meta, "utf8"));
    const cfgRoot = path.join(tmp, "config"), files = {};
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files[path.relative(cfgRoot, f).split(path.sep).join("/")] = fs.readFileSync(f).toString("base64"); } };
    if (fs.existsSync(cfgRoot)) walk(cfgRoot);
    data.config = files;
    return await create(data, send, path.join(tmp, "mods"));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

module.exports = { decode, applyUpdate, exportCode, importCode, exportZip, importZip };

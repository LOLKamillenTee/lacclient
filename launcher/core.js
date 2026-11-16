// LAC launcher core: no Electron in here, so it can be tested from a plain Node script (tools/test-launch.js).
const fs = require("fs");
const AdmZip = require("adm-zip");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const { Client } = require("minecraft-launcher-core");
const Handler = require("minecraft-launcher-core/components/handler");

const ROOT = process.env.LAC_ROOT || path.join(process.env.APPDATA || os.homedir(), ".lac");   // shared game root: assets, libraries, versions, instances (LAC_ROOT for tests)
const PROFILES = path.join(ROOT, "profiles.json");
const MODRINTH = "https://api.modrinth.com/v2";
const UA = { "User-Agent": "lac-client/0.2 (launcher)" };               // Modrinth requires a User-Agent
const FABRIC_API = "P7dR8mSH";                                          // Modrinth project id of Fabric API
const LOADERS = ["fabric", "neoforge", "forge"];
const DIST = path.join(__dirname, "dist").replace("app.asar", "app.asar.unpacked"); // built LAC mods per loader + Minecraft version

const j = async (url, opts) => { const r = await fetch(url, { headers: UA, ...opts }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
const text = async (url) => { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.text(); };
const readProfiles = () => { try { return JSON.parse(fs.readFileSync(PROFILES, "utf8")); } catch { return []; } };
const writeProfiles = (p) => { fs.mkdirSync(ROOT, { recursive: true }); fs.writeFileSync(PROFILES, JSON.stringify(p, null, 2)); };
const modsDir = (id) => path.join(ROOT, "instances", id, "mods");
const bundled = () => { try { return JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8")); } catch { return []; } };
// newer LAC mod builds downloaded from the update source live here and win over the ones shipped with the launcher
const MODS = () => path.join(ROOT, "mods-cache");
const cached = () => { try { return JSON.parse(fs.readFileSync(path.join(MODS(), "manifest.json"), "utf8")); } catch { return []; } };
const manifest = () => { const c = cached().filter((b) => fs.existsSync(path.join(MODS(), b.file))); return bundled().filter((b) => !c.some((x) => x.loader === b.loader && x.mc === b.mc)).concat(c); };
const buildFile = (b) => { const c = path.join(MODS(), b.file); return cached().some((x) => x.file === b.file) && fs.existsSync(c) ? c : path.join(DIST, b.file); };
const sha256 = (f) => require("crypto").createHash("sha256").update(fs.readFileSync(f)).digest("hex");
/** "owner/name" of the GitHub repository whose latest release holds the updates (launcher/update.json), or "" for no updates */
const updateRepo = () => { try { const r = JSON.parse(fs.readFileSync(path.join(__dirname, "update.json"), "utf8")).repo; return /^[\w.-]+\/[\w.-]+$/.test(r) ? r : ""; } catch { return ""; } };
/** fetch mods.json from the latest release and download every LAC build that is new or different (checked by SHA-256); never throws */
async function syncMods(send = () => {}) {
  const repo = updateRepo(); if (!repo) return 0;
  try {
    const base = `https://github.com/${repo}/releases/latest/download/`;
    const r = await fetch(base + "mods.json", { signal: AbortSignal.timeout(10000) }); if (!r.ok) return 0;
    const remote = await r.json(), have = cached(); let n = 0;
    fs.mkdirSync(MODS(), { recursive: true });
    for (const b of remote) {
      if (!/^lac-[\w.-]+\.jar$/.test(b.file) || !/^[0-9a-f]{64}$/.test(b.sha256 || "")) continue;
      const dest = path.join(MODS(), b.file), bd = bundled().find((x) => x.file === b.file);
      if (fs.existsSync(dest) && sha256(dest) === b.sha256) continue;
      if (bd && fs.existsSync(path.join(DIST, bd.file)) && sha256(path.join(DIST, bd.file)) === b.sha256) {   // the shipped build is already this one: an older downloaded copy must not win over it any more (it kept old mod builds alive after launcher updates)
        const i = have.findIndex((x) => x.file === b.file); if (i >= 0) { try { fs.rmSync(dest, { force: true }); } catch { /* locked */ } have.splice(i, 1); n++; }
        continue;
      }
      send({ type: "log", line: `LAC-Mod ${b.file} wird aktualisiert` });
      const f = await fetch(base + b.file, { signal: AbortSignal.timeout(60000) }); if (!f.ok) continue;
      const buf = Buffer.from(await f.arrayBuffer());
      if (require("crypto").createHash("sha256").update(buf).digest("hex") !== b.sha256) continue;   // damaged or tampered download: keep what we have
      fs.writeFileSync(dest + ".tmp", buf); fs.renameSync(dest + ".tmp", dest);
      const i = have.findIndex((x) => x.loader === b.loader && x.mc === b.mc); const e = { loader: b.loader, mc: b.mc, file: b.file };
      if (i >= 0) have[i] = e; else have.push(e); n++;
    }
    if (n) fs.writeFileSync(path.join(MODS(), "manifest.json"), JSON.stringify(have, null, 2));
    return n;
  } catch (e) { send({ type: "log", line: "Mod-Update übersprungen: " + (e.message || e) }); return 0; }
}

async function download(url, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`download failed ${r.status}: ${url}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

/* ------------------------------ versions per loader ------------------------------ */
const cmp = (a, b) => { const x = a.split(/[.\-]/).map(Number), y = b.split(/[.\-]/).map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };

// NeoForge versions encode the Minecraft version: 26.3.0.103 -> 26.3, 26.1.2.125 -> 26.1.2, 21.1.266 -> 1.21.1, 21.0.5 -> 1.21
function neoMc(v) {
  const p = v.split(".");
  if (+p[0] >= 26) return p[2] === "0" ? `${p[0]}.${p[1]}` : `${p[0]}.${p[1]}.${p[2]}`;
  return p[1] === "0" ? `1.${p[0]}` : `1.${p[0]}.${p[1]}`;
}
const xmlVersions = (xml) => [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);

const cache = {};
async function loaderBuilds(loader) {
  if (cache[loader]) return cache[loader];
  if (loader === "neoforge") {
    const v = xmlVersions(await text("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml")).filter((x) => !/beta|alpha/i.test(x));
    return (cache[loader] = v.map((x) => ({ mc: neoMc(x), build: x })));
  }
  if (loader === "forge") {
    const v = xmlVersions(await text("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml"));
    return (cache[loader] = v.map((x) => ({ mc: x.split("-")[0], build: x })));
  }
  return [];
}

async function versions(loader) {
  if (loader === "fabric") return (await j("https://meta.fabricmc.net/v2/versions/game")).filter((v) => v.stable).map((v) => v.version);
  const mcs = [...new Set((await loaderBuilds(loader)).map((b) => b.mc))];
  return mcs.sort((a, b) => cmp(b.replace(/^1\./, ""), a.replace(/^1\./, "")));
}

/* ------------------------------ java ------------------------------ */
// MC 26.x needs Java 25, older versions Java 21. The profile's own path wins, else the first matching JDK found.
function findJava(mc, custom, console = false) {
  const exeName = process.platform === "win32" ? (console ? "java.exe" : "javaw.exe") : "java";
  if (custom) return custom;
  const want = parseInt(mc) >= 26 ? "25" : "21";
  const home = process.env.USERPROFILE || os.homedir();   // (on a Mac: the home folder)
  const roots = ["/Library/Java/JavaVirtualMachines", path.join(home, "Library", "Java", "JavaVirtualMachines"), "C:\\Program Files\\Eclipse Adoptium", "C:\\Program Files\\Java", "C:\\Program Files\\Microsoft", path.join(home, ".gradle", "jdks"), path.join(home, ".jdks"), path.join(ROOT, "runtime")];
  for (const r of roots) {
    try {
      for (const d of fs.readdirSync(r)) {
        const exe = [path.join(r, d, "bin", exeName), path.join(r, d, "Contents", "Home", "bin", exeName)].find((x) => fs.existsSync(x));   // the second form is a macOS JDK
        if (exe && new RegExp(`(^|[^0-9])${want}([^0-9]|$)`).test(d)) return exe;
      }
    } catch { /* root does not exist */ }
  }
  return process.platform === "win32" ? (console ? "java.exe" : "javaw.exe") : "java"; // fall back to PATH
}

/** A PC without the right Java (Minecraft 26.x needs 25, older versions 21) gets it from Adoptium into the launcher's own folder. */
async function ensureJava(mc, profile, send) {
  if (profile.java || !["win32", "darwin"].includes(process.platform)) return;
  return ensureJavaVersion(parseInt(mc) >= 26 ? 25 : 21, send);
}
/** First start: everything the launcher and the game need is fetched up front (Java 25 for 26.x, Java 21 for older versions). Returns true when something was downloaded. */
async function ensureRuntimes(send) {
  let got = false;
  for (const want of [25, 21]) { const had = path.isAbsolute(findJava(want + ".0", "", true)) && fs.existsSync(findJava(want + ".0", "", true)); if (!had) { await ensureJavaVersion(want, send); got = true; } }
  return got;
}
async function ensureJavaVersion(want, send) {
  const mc = want >= 25 ? "26.3" : "1.21", have = findJava(mc, "", true);
  if (path.isAbsolute(have) && fs.existsSync(have)) return;
  send({ type: "stage", stage: "prepare", label: `Java ${want} wird heruntergeladen (einmalig)`, pct: 4 });
  send({ type: "log", line: `Kein Java ${want} gefunden: lade Temurin ${want} (JRE) herunter` });
  const mac = process.platform === "darwin", dir = path.join(ROOT, "runtime"), zip = path.join(dir, `temurin-${want}.${mac ? "tar.gz" : "zip"}`);
  fs.mkdirSync(dir, { recursive: true });
  await download(`https://api.adoptium.net/v3/binary/latest/${want}/ga/${mac ? "mac" : "windows"}/${mac && process.arch === "arm64" ? "aarch64" : "x64"}/jre/hotspot/normal/eclipse`, zip);
  send({ type: "stage", stage: "prepare", label: `Java ${want} wird entpackt`, pct: 6 });
  await new Promise((resolve, reject) => {
    const p = mac ? cp.spawn("tar", ["-xzf", zip, "-C", dir]) : cp.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive", "-LiteralPath", `'${zip.replace(/'/g, "''")}'`, "-DestinationPath", `'${dir.replace(/'/g, "''")}'`, "-Force"], { windowsHide: true });
    let err = ""; p.stderr.on("data", (d) => (err += d)); p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("Java konnte nicht entpackt werden: " + err.trim()))));
  });
  fs.rmSync(zip, { force: true });
  const now = findJava(mc, "", true);
  if (!(path.isAbsolute(now) && fs.existsSync(now))) throw new Error(`Java ${want} wurde heruntergeladen, aber nicht gefunden`);
  send({ type: "log", line: "Java bereit: " + now });
}

/* ------------------------------ loaders ------------------------------ */
async function ensureFabric(mc) {
  const loader = (await j(`https://meta.fabricmc.net/v2/versions/loader/${mc}`))[0]?.loader.version;
  if (!loader) throw new Error(`Fabric unterstützt ${mc} noch nicht`);
  const id = `fabric-loader-${loader}-${mc}`;
  const file = path.join(ROOT, "versions", id, `${id}.json`);
  if (!fs.existsSync(file)) await download(`https://meta.fabricmc.net/v2/versions/loader/${mc}/${loader}/profile/json`, file);
  return id;
}

/** NeoForge / Forge: run the official installer once (it downloads libraries and writes versions/<id>/<id>.json). */
async function ensureInstalled(loader, mc, profile, send) {
  const builds = (await loaderBuilds(loader)).filter((b) => b.mc === mc).map((b) => b.build).sort(cmp);
  const build = builds.at(-1);
  if (!build) throw new Error(`${loader} gibt es nicht für Minecraft ${mc}`);
  const tag = loader === "forge" ? build.split("-").slice(1).join("-") : build;   // forge folders are named 26.3-forge-66.1.5
  const known = () => fs.existsSync(path.join(ROOT, "versions")) ? fs.readdirSync(path.join(ROOT, "versions")).filter((d) => d.toLowerCase().includes(loader) && d.includes(tag)) : [];
  if (known().length) return patchVersion(known()[0]);
  const url = loader === "neoforge"
    ? `https://maven.neoforged.net/releases/net/neoforged/neoforge/${build}/neoforge-${build}-installer.jar`
    : `https://maven.minecraftforge.net/net/minecraftforge/forge/${build}/forge-${build}-installer.jar`;
  const jar = path.join(ROOT, "installers", path.basename(url));
  send({ type: "stage", stage: "loader", label: `${loader} ${build} herunterladen`, pct: 5 });
  if (!fs.existsSync(jar)) await download(url, jar);
  if (!fs.existsSync(path.join(ROOT, "launcher_profiles.json"))) fs.writeFileSync(path.join(ROOT, "launcher_profiles.json"), JSON.stringify({ profiles: {}, version: 3 }));
  send({ type: "stage", stage: "loader", label: `${loader} installieren (einmalig, dauert etwas)`, pct: 15 });
  await new Promise((resolve, reject) => {
    const p = cp.spawn(findJava(mc, profile.java, true), ["-jar", jar, "--installClient", ROOT], { cwd: ROOT });
    p.stdout.on("data", (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => send({ type: "log", line: l })));
    p.stderr.on("data", (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => send({ type: "log", line: l })));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${loader}-Installer endete mit Code ${c}`))));
  });
  const id = known()[0];
  if (!id) throw new Error(`${loader}-Installer hat keine Version angelegt`);
  return patchVersion(id);
}

/** The launcher library ignores a version file's own JVM arguments, so hand the plain-string ones (Forge/NeoForge need them) over explicitly. */
function loaderJvmArgs(id) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, "versions", id, `${id}.json`), "utf8"));
    return (j.arguments?.jvm || []).filter((a) => typeof a === "string" && !a.includes("${") && !a.startsWith("-cp") && a !== "-cp");
  } catch { return []; }
}

/** The launcher library does not know the placeholders newer Forge/NeoForge version files use, so fill them in here. */
function patchVersion(id) {
  const file = path.join(ROOT, "versions", id, `${id}.json`);
  let raw = fs.readFileSync(file, "utf8");
  const libs = path.join(ROOT, "libraries").split(path.sep).join("/");   // forward slashes keep the JSON and the JVM both happy
  const fixed = raw.split("${library_directory}").join(libs).split("${classpath_separator}").join(path.delimiter);
  if (fixed !== raw) fs.writeFileSync(file, fixed);
  return id;
}

/* ------------------------------ mods (Modrinth) ------------------------------ */
async function searchMods(query, mc, loader, offset = 0) {
  const facets = JSON.stringify([["project_type:mod"], [`categories:${loader}`], [`versions:${mc}`]]);
  return (await j(`${MODRINTH}/search?limit=20&offset=${Math.max(0, offset | 0)}&query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}`)).hits
    .map((h) => ({ id: h.project_id, title: h.title, description: h.description, icon: h.icon_url, downloads: h.downloads }));
}

/** search for mods, resource packs or shaders on Modrinth (kind: mods | resourcepacks | shaderpacks), 20 at a time */
async function searchContent(query, mc, loader, kind, offset = 0) {
  const type = kind === "resourcepacks" ? "resourcepack" : kind === "shaderpacks" ? "shader" : "mod";
  const facets = [[`project_type:${type}`], [`versions:${mc}`]]; if (type === "mod") facets.splice(1, 0, [`categories:${loader}`]);
  return (await j(`${MODRINTH}/search?limit=20&offset=${Math.max(0, offset | 0)}&index=${query ? "relevance" : "downloads"}&query=${encodeURIComponent(query || "")}&facets=${encodeURIComponent(JSON.stringify(facets))}`)).hits
    .map((h) => ({ id: h.project_id, title: h.title, description: h.description, icon: h.icon_url, downloads: h.downloads }));
}

/**
 * The "+" in a profile: puts content into the profile and marks it as the player's own, so a modpack update leaves it alone.
 * Mods come with their dependencies; resource packs and shaders are single files.
 */
async function addContent(profileId, hit, kind, send = () => {}) {
  const before = new Set((readProfiles().find((p) => p.id === profileId) || {}).mods?.map((m) => m.id) || []);
  if (kind === "mods") {
    const r = await addMod(profileId, hit, send);
    const all = readProfiles(), prof = all.find((p) => p.id === profileId);
    for (const m of prof.mods || []) if (!before.has(m.id)) m.own = true;   // the mod and what it brought along
    writeProfiles(all); return r;
  }
  const all = readProfiles(), prof = all.find((p) => p.id === profileId); if (!prof) throw new Error("Profil nicht gefunden");
  const q = `game_versions=${encodeURIComponent(JSON.stringify([prof.mc]))}`;
  let vs = await j(`${MODRINTH}/project/${hit.id}/version?${q}`); if (!vs.length) vs = await j(`${MODRINTH}/project/${hit.id}/version`);
  const v = vs[0]; if (!v) throw new Error(`${hit.title} gibt es nicht für Minecraft ${prof.mc}`);
  const f = v.files.find((x) => x.primary) || v.files[0], inst = path.dirname(modsDir(profileId)), sub = kind === "shaderpacks" ? "shaderpacks" : "resourcepacks";
  fs.mkdirSync(path.join(inst, sub), { recursive: true }); send({ type: "log", line: `Installiere ${hit.title}…` });
  await download(f.url, path.join(inst, sub, f.filename));
  (prof.ownFiles ||= []).push(sub + "/" + f.filename); writeProfiles(all);
  return { profile: prof, installed: [hit.title] };
}

/** Installs a mod and, recursively, everything it requires. Returns the list of newly installed mods. */
async function addMod(profileId, mod, send = () => {}, requiredBy = null, pins = {}) {
  const all = readProfiles(), prof = all.find((p) => p.id === profileId);
  const installed = [];
  async function install(pid, title, by) {
    const have = (prof.mods ||= []).find((m) => m.id === pid);
    if (have) { if (by && !have.requiredBy?.includes(by)) (have.requiredBy ||= []).push(by); return; }
    const q = `game_versions=${encodeURIComponent(JSON.stringify([prof.mc]))}&loaders=${encodeURIComponent(JSON.stringify([prof.loader]))}`;
    const all = await j(`${MODRINTH}/project/${pid}/version?${q}`), cap = pins[pid];
    const v = cap ? all.find((x) => x.date_published.slice(0, 10) <= cap) : all[0];   // a pin picks the newest build up to that date (the newest Sodium beta breaks Iris)
    if (!v && by) { send({ type: "log", line: `Übersprungen: ${title || pid} gibt es nicht für ${prof.loader} ${prof.mc} (falsch eingetragene Abhängigkeit)` }); return; }   // a dependency that is for another loader (Modrinth lists some by mistake) must not stop the mod itself
    if (!v) throw new Error(`${title || pid} gibt es nicht für ${prof.loader} ${prof.mc}`);
    if (!title) title = (await j(`${MODRINTH}/project/${pid}`)).title;
    const f = v.files.find((x) => x.primary) || v.files[0];
    send({ type: "log", line: `Installiere ${title}…` });
    await download(f.url, path.join(modsDir(profileId), f.filename));
    prof.mods.push({ id: pid, title, file: f.filename, dep: !!by, requiredBy: by ? [by] : [] });
    installed.push(title);
    for (const d of v.dependencies || []) {   // required mods come along automatically; some entries only name a version, then the project is looked up
      if (d.dependency_type !== "required") continue;
      let dp = d.project_id; if (!dp && d.version_id) { try { dp = (await j(`${MODRINTH}/version/${d.version_id}`)).project_id; } catch { /* not resolvable */ } }
      if (dp) await install(dp, null, pid);
    }
  }
  await install(mod.id, mod.title, requiredBy);
  writeProfiles(all);
  if (!inEnsure) { try { installed.push(...(await ensureDeps(profileId, send))); } catch { /* the mod itself is installed */ } }
  return { profile: prof, installed };
}

/* ---- what a mod needs, read from the mod file itself: Modrinth's lists are sometimes incomplete (Biomes O' Plenty needs TerraBlender) ---- */
const SKIP_IDS = new Set(["minecraft", "java", "fabricloader", "fabric-loader", "fabric", "fabric-api", "neoforge", "forge", "fml", "javafml", "lowcodefml", "mixinextras", "mixin", "quilt_loader"]);
let inEnsure = false;
function jarMeta(file) {
  const ids = [], needs = [];
  const readZip = (z) => {
    const fj = z.getEntry("fabric.mod.json");
    if (fj) { const o = JSON.parse(fj.getData().toString("utf8").replace(/^\uFEFF/, "")); ids.push(o.id, ...(o.provides || [])); needs.push(...Object.keys(o.depends || {})); return o; }
    for (const n of ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"]) {
      const e = z.getEntry(n); if (!e) continue;
      for (const sec of e.getData().toString("utf8").split(/^\s*\[\[/m).slice(1)) {
        const head = sec.split("]]")[0].trim(), id = (/modId\s*=\s*"([^"]+)"/.exec(sec) || [])[1];
        if (head === "mods" && id) ids.push(id);
        else if (head.startsWith("dependencies") && id && (/mandatory\s*=\s*true/.test(sec) || /type\s*=\s*"required"/.test(sec))) needs.push(id);
      }
    }
    return null;
  };
  try {
    const z = new AdmZip(file), o = readZip(z);
    for (const jj of (o && o.jars) || []) { try { const e = z.getEntry(jj.file); if (e) { const nz = new AdmZip(e.getData()), no = JSON.parse(nz.getEntry("fabric.mod.json").getData().toString("utf8").replace(/^\uFEFF/, "")); ids.push(no.id, ...(no.provides || [])); } } catch { /* nested jar unreadable */ } }   // bundled mods count as present
  } catch { /* not a mod jar we can read */ }
  return { ids, needs };
}

/** installs every required mod that no jar of the profile provides, looked up on Modrinth by its mod id; returns the titles that came in */
async function ensureDeps(profileId, send = () => {}) {
  const got = [], tried = new Set(); inEnsure = true;
  try {
    for (let pass = 0; pass < 3; pass++) {
      const dir = modsDir(profileId), prof = readProfiles().find((p) => p.id === profileId); if (!prof) return got;
      let jars = []; try { jars = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".jar")); } catch { return got; }
      const have = new Set(), needs = new Map();
      for (const f of jars) { const m = jarMeta(path.join(dir, f)); m.ids.forEach((i) => have.add(i)); for (const n of m.needs) if (!needs.has(n)) needs.set(n, f); }
      const missing = [...needs.keys()].filter((n) => !have.has(n) && !SKIP_IDS.has(n) && !tried.has(n));
      if (!missing.length) break;
      for (const n of missing) {
        tried.add(n);
        try {
          const proj = await j(`${MODRINTH}/project/${encodeURIComponent(n)}`), parent = (prof.mods || []).find((m) => m.file === needs.get(n));
          const r = await addMod(profileId, { id: proj.id, title: proj.title }, send, parent ? parent.id : "auto"); got.push(...r.installed);
        } catch (e) { send({ type: "log", line: `Fehlende Abhängigkeit: ${n} (${String(e.message || e).slice(0, 80)})` }); }
      }
    }
  } finally { inEnsure = false; }
  return got;
}

/** Removes a mod and the dependencies nothing else needs any more. Fabric API stays (it is part of every Fabric profile). */
function removeMod(profileId, modId) {
  const all = readProfiles(), prof = all.find((p) => p.id === profileId);
  const drop = (id) => {
    const m = prof.mods.find((x) => x.id === id); if (!m) return;
    fs.rmSync(path.join(modsDir(profileId), m.file), { force: true });
    prof.mods = prof.mods.filter((x) => x.id !== id);
    for (const d of prof.mods.filter((x) => x.dep && x.requiredBy?.includes(id) && x.id !== FABRIC_API)) {
      d.requiredBy = d.requiredBy.filter((r) => r !== id);
      if (!d.requiredBy.length) drop(d.id);
    }
  };
  drop(modId);
  writeProfiles(all);
  return prof;
}

/* ------------------------------ Modrinth modpacks (.mrpack) ------------------------------ */
// The LAC mod that matches a pack's loader and Minecraft version is copied in at every start (see launch), so every pack gets the right build automatically.
const lacBuilds = () => manifest().map((b) => `${b.loader}:${b.mc}`);

async function searchPacks(query, onlyLac, loader, offset = 0) {
  const sup = manifest(), mcs = [...new Set(sup.map((b) => b.mc))];
  const facets = [["project_type:modpack"], (LOADERS.includes(loader) ? [loader] : LOADERS).map((l) => `categories:${l}`)];
  if (onlyLac && mcs.length) facets.push(mcs.map((m) => `versions:${m}`));
  const res = await j(`${MODRINTH}/search?limit=20&offset=${Math.max(0, offset | 0)}&index=${query ? "relevance" : "downloads"}&query=${encodeURIComponent(query || "")}&facets=${encodeURIComponent(JSON.stringify(facets))}`);
  return res.hits.map((h) => ({ id: h.project_id, title: h.title, description: h.description, icon: h.icon_url, downloads: h.downloads,
    loaders: h.categories.filter((c) => LOADERS.includes(c)), lac: sup.some((b) => h.versions.includes(b.mc) && h.categories.includes(b.loader)) }));
}

const ps = (args) => process.platform !== "win32" ? Promise.reject(new Error("nur unter Windows")) : new Promise((resolve, reject) => {
  const p = cp.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ...args], { windowsHide: true });
  let err = ""; p.stderr.on("data", (d) => (err += d)); p.on("error", reject);
  p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(err.trim() || `PowerShell Code ${c}`))));
});

/** Installs a modpack as a new profile: picks the newest pack version that LAC supports (else the newest), downloads its files, applies the overrides. */
const packVersion = (all, sup) => {
  const loaderOf = (v) => LOADERS.find((l) => v.loaders.includes(l));
  const fits = (v) => loaderOf(v) && v.game_versions.some((m) => sup.includes(`${loaderOf(v)}:${m}`));
  return all.find(fits) || all.find(loaderOf);
};

/** downloads a pack version into the instance folder `inst` (mods, overrides) and returns what it contains */
async function packInto(proj, v, inst, send, keep = []) {
  const file = v.files.find((x) => x.primary) || v.files[0];
  const work = path.join(ROOT, "packs", `${Date.now().toString(36)}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    send({ type: "pack", title: `${proj.title} herunterladen`, done: 0, total: 1 });
    await download(file.url, path.join(work, "pack.zip"));
    const ex = path.join(work, "x");
    if (process.platform === "win32") await ps(["Expand-Archive", "-LiteralPath", `'${path.join(work, "pack.zip").replace(/'/g, "''")}'`, "-DestinationPath", `'${ex.replace(/'/g, "''")}'`, "-Force"]); else new AdmZip(path.join(work, "pack.zip")).extractAllTo(ex, true);
    const idx = JSON.parse(fs.readFileSync(path.join(ex, "modrinth.index.json"), "utf8").replace(/^﻿/, ""));
    const dep = idx.dependencies || {};
    const loader = dep["fabric-loader"] ? "fabric" : dep.neoforge ? "neoforge" : dep.forge ? "forge" : null;
    if (!loader) throw new Error("Dieses Modpack braucht einen nicht unterstützten Loader (z.B. Quilt)");
    fs.mkdirSync(inst, { recursive: true });
    const files = (idx.files || []).filter((f) => !f.env || f.env.client !== "unsupported");
    let done = 0;
    const queue = [...files];
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (let f; (f = queue.shift()); ) {
        const target = path.resolve(inst, f.path);
        if (!target.startsWith(inst + path.sep)) throw new Error(`Unsicherer Pfad im Modpack: ${f.path}`);
        let ok = false, last = null;
        for (const url of f.downloads || []) {
          try {
            await download(url, target);
            const want = f.hashes && f.hashes.sha1;
            if (want && require("crypto").createHash("sha1").update(fs.readFileSync(target)).digest("hex") !== want) throw new Error("Prüfsumme stimmt nicht");
            ok = true; break;
          } catch (e) { last = e; }
        }
        if (!ok) throw new Error(`${f.path}: ${last ? last.message : "keine Download-Adresse"}`);
        send({ type: "pack", title: `${proj.title}: ${path.basename(f.path)}`, done: ++done, total: files.length });
      }
    }));
    // an update leaves the player's own options and server list alone
    for (const dir of ["overrides", "client-overrides"]) if (fs.existsSync(path.join(ex, dir))) fs.cpSync(path.join(ex, dir), inst, { recursive: true, force: true, filter: (src) => !keep.includes(path.basename(src)) || !fs.existsSync(path.join(inst, path.basename(src))) });
    const mods = files.filter((f) => /^mods[\/]/.test(f.path) && /\.jar$/i.test(f.path)).map((f) => ({ id: "pack:" + path.basename(f.path), title: path.basename(f.path).replace(/\.jar$/i, ""), file: path.basename(f.path), dep: false, requiredBy: [] }));
    return { loader, mc: dep.minecraft, mods };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

async function installPack(projectId, send = () => {}) {
  const sup = lacBuilds();
  const proj = await j(`${MODRINTH}/project/${projectId}`), all = await j(`${MODRINTH}/project/${projectId}/version`);
  const v = packVersion(all, sup);
  if (!v) throw new Error("Dieses Modpack läuft auf keinem unterstützten Loader (Fabric, NeoForge, Forge)");
  const id = Date.now().toString(36), inst = path.join(ROOT, "instances", id);
  const r = await packInto(proj, v, inst, send);
  const profile = { id, name: proj.title, loader: r.loader, mc: r.mc, mods: r.mods, ram: "4096M", playtime: 0, lac: true, pack: { project: projectId, version: v.version_number, versionId: v.id } };
  const profiles = readProfiles(); profiles.push(profile); writeProfiles(profiles);
  return { profiles, lac: sup.includes(`${r.loader}:${r.mc}`), loader: r.loader, mc: r.mc };
}

/** is there a newer version of the pack behind this profile? */
async function checkPack(profileId) {
  const p = readProfiles().find((x) => x.id === profileId);
  if (!p || !p.pack) throw new Error("Dieses Profil ist kein Modpack");
  const all = await j(`${MODRINTH}/project/${p.pack.project}/version`), v = packVersion(all, lacBuilds());
  if (!v) throw new Error("Keine Version gefunden");
  return { current: p.pack.version, latest: v.version_number, newer: !!(p.pack.versionId ? v.id !== p.pack.versionId : v.version_number !== p.pack.version) };
}

/** installs the newest pack version over the profile: old pack mods go, new ones come, worlds, options and the server list stay */
async function updatePack(profileId, send = () => {}) {
  const profiles = readProfiles(), p = profiles.find((x) => x.id === profileId);
  if (!p || !p.pack) throw new Error("Dieses Profil ist kein Modpack");
  const proj = await j(`${MODRINTH}/project/${p.pack.project}`), all = await j(`${MODRINTH}/project/${p.pack.project}/version`), v = packVersion(all, lacBuilds());
  if (!v) throw new Error("Keine Version gefunden");
  const inst = path.dirname(modsDir(p.id));
  for (const m of p.mods || []) if (String(m.id).startsWith("pack:") && m.file) fs.rmSync(path.join(modsDir(p.id), m.file), { force: true });
  const r = await packInto(proj, v, inst, send, ["options.txt", "servers.dat", "optionsof.txt", "optionsshaders.txt"]);
  const own = (p.mods || []).filter((m) => !String(m.id).startsWith("pack:"));   // mods the player added on top stay
  Object.assign(p, { loader: r.loader, mc: r.mc, mods: [...r.mods, ...own], pack: { project: p.pack.project, version: v.version_number, versionId: v.id } });
  writeProfiles(profiles);
  return { profiles, version: v.version_number };
}

/** The mods offered at profile creation (Fabric): performance, optics, comfort. Dependencies come automatically. */
const PRESET = [
  ["YL57xq9U", "Iris Shaders"], ["AANobbMI", "Sodium"], ["gvQqBUqZ", "Lithium"], ["uXXizFIs", "FerriteCore"], ["NNAgCjsB", "Entity Culling"], ["5ZwdcRci", "ImmediatelyFast"], ["fQEb0iXm", "Krypton"],
  ["PtjYWJkn", "Sodium Extra"], ["Bh37bMuy", "Reese's Sodium Options"], ["1IjD5062", "Continuity"], ["zV5r3pPn", "3D Skin Layers"],
  ["kYuIpRLv", "Wavey Capes"],
  ["aC3cM3Vq", "Mouse Tweaks"], ["8shC1gFX", "BetterF3"], ["JrrZfsph", "Lightweight Inventory Sorting"], ["w7ThoJFB", "Zoomify"], ["xv94TkTM", "Controlling"], ["nvQzSEkH", "Jade"]];

// Iris 1.11.7 refuses Sodium builds newer than 0.9.2 (More Culling needs a newer one, so it is left out); Sodium Extra and Reese's Options follow Sodium
const PINS = { AANobbMI: "2026-09-19", PtjYWJkn: "2026-09-30", Bh37bMuy: "2026-09-30" };   // Sodium 0.9.2: newer builds are refused by Iris, and Reese's Options needs exactly 0.9.2

const defaultsFile = () => path.join(__dirname, "defaults.json");
const readDefaults = () => { try { return JSON.parse(fs.readFileSync(defaultsFile(), "utf8")); } catch { return null; } };

/** the resource packs and shaders of the standard set: downloaded from Modrinth into the profile and switched on in the same order as in the main profile */
async function installDefaultPacks(profileId, send = () => {}) {
  const d = readDefaults(), prof = readProfiles().find((p) => p.id === profileId); if (!d || !prof) return { packs: [], shaders: [] };
  const inst = path.dirname(modsDir(profileId)), got = { packs: [], shaders: [] }, fileOf = {};
  async function fetchOne(item, sub) {
    const q = `game_versions=${encodeURIComponent(JSON.stringify([prof.mc]))}`;
    let all = await j(`${MODRINTH}/project/${item.id}/version?${q}`); if (!all.length) all = await j(`${MODRINTH}/project/${item.id}/version`);   // packs often work across versions
    const v = all[0]; if (!v) throw new Error("keine Version");
    const f = v.files.find((x) => x.primary) || v.files[0]; fs.mkdirSync(path.join(inst, sub), { recursive: true });
    await download(f.url, path.join(inst, sub, f.filename)); return f.filename;
  }
  for (const it of d.resourcepacks || []) { send({ type: "log", line: `Ressourcenpaket ${it.title}…` }); try { fileOf[it.id] = await fetchOne(it, "resourcepacks"); got.packs.push(it.title); } catch (e) { send({ type: "log", line: `Übersprungen: ${it.title} (${e.message})` }); } }
  for (const it of d.shaders || []) { send({ type: "log", line: `Shader ${it.title}…` }); try { const fn = await fetchOne(it, "shaderpacks"); got.shaders.push(it.title); if (!fs.existsSync(path.join(inst, "config", "iris.properties"))) { fs.mkdirSync(path.join(inst, "config"), { recursive: true }); fs.writeFileSync(path.join(inst, "config", "iris.properties"), `shaderPack=${fn}\nenableShaders=false\n`); } } catch (e) { send({ type: "log", line: `Übersprungen: ${it.title} (${e.message})` }); } }
  const opt = path.join(inst, "options.txt");   // switch the packs on, in the order of the main profile (weakest first)
  if (!fs.existsSync(opt) && Object.keys(fileOf).length) {
    const order = (d.rpOrder || []).filter((id) => fileOf[id]).concat(Object.keys(fileOf).filter((id) => !(d.rpOrder || []).includes(id)));
    fs.writeFileSync(opt, `resourcePacks:${JSON.stringify(["vanilla", ...order.map((id) => "file/" + fileOf[id])])}\n`);
  }
  return got;
}

async function installPreset(profileId, send = () => {}) {
  const prof = readProfiles().find((p) => p.id === profileId);
  if (!prof || prof.loader !== "fabric") return { installed: [], skipped: [] };
  const installed = [], skipped = [];
  const dd = readDefaults(), LIST = dd && dd.mods && dd.mods.length ? dd.mods.map((m) => [m.id, m.title]) : PRESET;   // the mods of the main profile
  for (let i = 0; i < LIST.length; i++) {
    const [id, title] = LIST[i];
    send({ type: "preset", done: i, total: LIST.length, title });
    try { await addMod(profileId, { id, title }, send, null, PINS); installed.push(title); } catch (e) { skipped.push(title); send({ type: "log", line: `Übersprungen: ${title} (${e.message})` }); }
  }
  send({ type: "preset", done: LIST.length, total: LIST.length, title: "Ressourcenpakete und Shader" });
  const extra = await installDefaultPacks(profileId, send).catch(() => ({ packs: [], shaders: [] }));
  send({ type: "preset", done: LIST.length, total: LIST.length, title: "" });
  return { installed: installed.concat(extra.packs, extra.shaders), skipped };
}

/** Fabric profiles always carry Fabric API, otherwise most mods (and LAC) cannot load. */
async function ensureFabricApi(profileId, send = () => {}) {
  const prof = readProfiles().find((p) => p.id === profileId);
  if (prof.loader !== "fabric") return prof;
  const have = (prof.mods || []).find((m) => m.id === FABRIC_API);
  if (have && fs.existsSync(path.join(modsDir(profileId), have.file))) return prof;
  if (have) { const all = readProfiles(); const p = all.find((x) => x.id === profileId); p.mods = p.mods.filter((m) => m.id !== FABRIC_API); writeProfiles(all); }
  try { for (const f of fs.readdirSync(modsDir(profileId))) if (/^fabric-api-.*.jar$/.test(f)) fs.rmSync(path.join(modsDir(profileId), f), { force: true }); } catch { /* no mods dir yet */ }
  send({ type: "stage", stage: "mods", label: "Fabric API installieren", pct: 30 });
  return (await addMod(profileId, { id: FABRIC_API, title: "Fabric API" }, send)).profile;
}

/* ------------------------------ launching ------------------------------ */
// Faster start: after a version has launched once, trust the files that already exist instead of re-hashing thousands of assets.
let FAST = false;
const origCheck = Handler.prototype.checkSum;
Handler.prototype.checkSum = function (hash, file) { return FAST && fs.existsSync(file) ? Promise.resolve(true) : origCheck.call(this, hash, file); };

/**
 * Minecraft's ~5000 asset files used to be fetched by minecraft-launcher-core's own downloader: every file with its own old-style request, all at
 * once. That is slow (thousands of connections fighting each other, no connection reuse). This replaces the asset step: files that already exist with
 * the right size are skipped without hashing, the missing ones come through a pool of 48 keep-alive connections, each written to a temp file and
 * checked by size, with retries. Set LAC_OLD_ASSETS=1 to get the old behaviour back.
 */
const origGetAssets = Handler.prototype.getAssets;
Handler.prototype.getAssets = async function () {
  if (process.env.LAC_OLD_ASSETS || this.version.assets === "legacy" || this.version.assets === "pre-1.6") return origGetAssets.call(this);
  const dir = path.resolve(this.options.overrides.assetRoot || path.join(this.options.root, "assets"));
  const assetId = this.options.version.custom || this.options.version.number, idx = path.join(dir, "indexes", `${assetId}.json`);
  if (!fs.existsSync(idx)) await this.downloadAsync(this.version.assetIndex.url, path.join(dir, "indexes"), `${assetId}.json`, true, "asset-json");
  const objects = Object.values(JSON.parse(fs.readFileSync(idx, "utf8")).objects), total = objects.length, base = this.options.overrides.url.resource;
  const todo = objects.filter((o) => { try { return fs.statSync(path.join(dir, "objects", o.hash.slice(0, 2), o.hash)).size !== o.size; } catch { return true; } });
  let done = total - todo.length, lastEmit = 0;
  const emit = (force) => { const now = Date.now(); if (force || now - lastEmit > 120) { lastEmit = now; this.client.emit("progress", { type: "assets", task: done, total }); } };
  emit(true);
  const queue = [...todo];
  await Promise.all(Array.from({ length: Math.min(48, queue.length) }, async () => {
    for (let o; (o = queue.shift()); ) {
      const sub = path.join(dir, "objects", o.hash.slice(0, 2)), file = path.join(sub, o.hash);
      fs.mkdirSync(sub, { recursive: true });
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const r = await fetch(`${base}/${o.hash.slice(0, 2)}/${o.hash}`, { headers: UA });
          if (!r.ok) throw new Error(String(r.status));
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length !== o.size) throw new Error("size");
          fs.writeFileSync(file + ".part", buf); fs.renameSync(file + ".part", file);
          break;
        } catch (e) { if (attempt === 3) this.client.emit("debug", `[LAC]: asset ${o.hash} failed: ${e.message}`); else await new Promise((res) => setTimeout(res, 300 * (attempt + 1))); }
      }
      done++; emit(false);
    }
  }));
  emit(true);
  this.client.emit("debug", "[MCLC]: Downloaded assets");
};
const verifiedMarker = (prof) => path.join(ROOT, "verified", `${prof.loader}-${prof.mc}.ok`);

// One background worker: with several, Minecraft 26.3 loads font glyphs from different threads at once and the native FreeType code crashes (0xC0000005) now and then, worst on NeoForge.
const SAFE = ["-Dmax.bg.threads=1"];
const AIKAR = ["-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled", "-XX:MaxGCPauseMillis=200", "-XX:+UnlockExperimentalVMOptions", "-XX:+DisableExplicitGC",
  "-XX:G1NewSizePercent=30", "-XX:G1MaxNewSizePercent=40", "-XX:G1HeapRegionSize=8M", "-XX:G1ReservePercent=20", "-XX:G1HeapWastePercent=5", "-Xshare:auto"];

/** Only a maximum is configured. "unlimited" = all physical RAM except 2 GB for Windows; the minimum is just a small fixed start size. */
function ramFor(profile) {
  const totalMb = Math.floor(os.totalmem() / 1048576);
  const r = String(profile.ram || "4096M").toLowerCase();
  let max = r === "unlimited" ? totalMb - 2048 : /g$/.test(r) ? parseFloat(r) * 1024 : parseFloat(r);
  if (!(max >= 512)) max = 4096;
  max = Math.round(Math.min(max, totalMb));
  return { max: `${max}M`, min: `${Math.min(512, max)}M` };
}

/**
 * @param {object} o { profile, auth (MCLC authorization object), consent (bool), send (event callback), onClose }
 * stages: prepare > loader > mods > files > starting > running > closed
 */
/** the window size the game opens with: the one of the game this one replaces (a profile switch, see window.json from the mod), else the profile's own */
function startWindow(profile) {
  try {
    const f = path.join(ROOT, "window.json"), o = JSON.parse(fs.readFileSync(f, "utf8"));
    if (Date.now() - o.t < 180000 && o.mode === "windowed" && o.w > 200 && o.h > 200) return { width: o.w, height: o.h };
  } catch { /* no hand-over */ }
  return profile.width && profile.height ? { width: +profile.width, height: +profile.height } : undefined;
}

/* ------------------------------ servers of a modpack ------------------------------ */
// A Dev can save servers in a modpack (profile.servers = [{name, ip}], they travel inside the modpack's share code): everybody who has the modpack gets them in the server list of THIS profile.
// servers.dat is shared by all profiles, so they are added to the profile's copy at the start and taken out of the copy that goes back to the shared list.
const nbtRead = (buf) => {
  let o = 0; const u8 = () => buf[o++], i16 = () => { const v = buf.readInt16BE(o); o += 2; return v; }, i32 = () => { const v = buf.readInt32BE(o); o += 4; return v; };
  const str = () => { const n = buf.readUInt16BE(o); o += 2; const s = buf.toString("utf8", o, o + n); o += n; return s; };
  const payload = (t) => {
    switch (t) {
      case 1: return buf.readInt8(o++);
      case 2: return i16();
      case 3: return i32();
      case 4: { const v = buf.readBigInt64BE(o); o += 8; return v; }
      case 5: { const v = buf.readFloatBE(o); o += 4; return v; }
      case 6: { const v = buf.readDoubleBE(o); o += 8; return v; }
      case 7: { const n = i32(); const v = buf.subarray(o, o + n); o += n; return v; }
      case 8: return str();
      case 9: { const et = u8(), n = i32(), items = []; for (let k = 0; k < n; k++) items.push(payload(et)); return { et, items }; }
      case 10: { const m = new Map(); for (;;) { const tt = u8(); if (tt === 0) break; const name = str(); m.set(name, { t: tt, v: payload(tt) }); } return m; }
      case 11: { const n = i32(), a = []; for (let k = 0; k < n; k++) a.push(i32()); return a; }
      case 12: { const n = i32(), a = []; for (let k = 0; k < n; k++) { a.push(buf.readBigInt64BE(o)); o += 8; } return a; }
      default: throw new Error("NBT: unbekannter Typ " + t);
    }
  };
  const t = u8(); if (t !== 10) throw new Error("NBT: kein Compound"); str(); return { t, v: payload(10) };
};
const nbtWrite = (root) => {
  const parts = []; const w = (b) => parts.push(b);
  const u8 = (n) => w(Buffer.from([n & 255])), i16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); w(b); }, i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); w(b); };
  const str = (s) => { const b = Buffer.from(s, "utf8"); i16(b.length); w(b); };
  const payload = (t, v) => {
    switch (t) {
      case 1: u8(v); break; case 2: i16(v); break; case 3: i32(v); break;
      case 4: { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); w(b); break; }
      case 5: { const b = Buffer.alloc(4); b.writeFloatBE(v); w(b); break; }
      case 6: { const b = Buffer.alloc(8); b.writeDoubleBE(v); w(b); break; }
      case 7: i32(v.length); w(Buffer.from(v)); break;
      case 8: str(v); break;
      case 9: u8(v.items.length ? v.et : 0); i32(v.items.length); for (const it of v.items) payload(v.et, it); break;
      case 10: for (const [name, e] of v) { u8(e.t); str(name); payload(e.t, e.v); } u8(0); break;
      case 11: i32(v.length); for (const x of v) i32(x); break;
      case 12: i32(v.length); for (const x of v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(x)); w(b); } break;
    }
  };
  u8(root.t); str(""); payload(root.t, root.v); return Buffer.concat(parts);
};
const serverList = (root) => { let e = root.v.get("servers"); if (!e || e.t !== 9) { e = { t: 9, v: { et: 10, items: [] } }; root.v.set("servers", e); } if (e.v.items.length === 0) e.v.et = 10; return e.v; };
const cleanServers = (list) => (Array.isArray(list) ? list : []).map((s) => ({ name: String((s && s.name) || "").slice(0, 40).trim(), ip: String((s && s.ip) || "").slice(0, 80).trim() })).filter((s) => s.name && /^[A-Za-z0-9_.:\-\[\]]+$/.test(s.ip)).slice(0, 20);
const serversFile = (gameDir) => path.join(gameDir, "servers.dat");
function addPackServers(gameDir, list) {
  list = cleanServers(list); if (!list.length) return;
  const f = serversFile(gameDir); let root;
  try { root = fs.existsSync(f) ? nbtRead(fs.readFileSync(f)) : null; } catch { root = null; }
  if (!root) root = { t: 10, v: new Map() };
  const sl = serverList(root), have = new Set(sl.items.map((c) => { const e = c.get("ip"); return e && e.v; }));
  const add = list.filter((s) => !have.has(s.ip)).map((s) => new Map([["ip", { t: 8, v: s.ip }], ["name", { t: 8, v: s.name }]]));
  if (!add.length) return; sl.items.unshift(...add); fs.writeFileSync(f, nbtWrite(root));
}
/** the copy that goes back to the shared list: without the servers of this profile's modpack */
function removePackServers(file, list) {
  list = cleanServers(list); if (!list.length || !fs.existsSync(file)) return; const ips = new Set(list.map((s) => s.ip));
  try { const root = nbtRead(fs.readFileSync(file)), sl = serverList(root); sl.items = sl.items.filter((c) => { const e = c.get("ip"); return !(e && ips.has(e.v)); }); root.v.get("servers").v = sl; fs.writeFileSync(file, nbtWrite(root)); } catch { /* an unreadable list stays as it is */ }
}

/* ------------------------------ shared between all profiles ------------------------------ */
// Worlds, shader packs and resource packs are folders: every profile gets a link to one common folder. Settings, the server list, the shader settings and the LAC mod
// settings are single files: the common copy is put into the profile before the game starts and the profile's copy goes back when it closes (a link would break
// whenever the game rewrites a file).
const SHARED = () => path.join(ROOT, "shared");
const SHARED_DIRS = ["saves", "shaderpacks", "resourcepacks"];
const SHARED_FILES = ["options.txt", "servers.dat", "optionsshaders.txt", "optionsof.txt", path.join("config", "lac.json")];
const sameFile = (a, b) => { try { const x = fs.statSync(a), y = fs.statSync(b); if (x.isDirectory() || y.isDirectory()) return false; return x.size === y.size && fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; } };
/** earlier versions kept both copies of a pack that two profiles had ("Name (id).zip"): identical ones are removed */
function dropDuplicates(dir) {
  let names = []; try { names = fs.readdirSync(dir); } catch { return; }
  for (const f of names) {
    const m = /^(.*) \(((?=[a-z0-9]*\d)[a-z0-9]{6,12}|profil)\)(\.[^.]*)?$/i.exec(f); if (!m) continue;   // the suffix is a profile id, not a name like (1)
    const base = path.join(dir, m[1] + (m[3] || ""));
    if (!fs.existsSync(base)) continue;
    try {   // the same pack twice: the newer copy stays under the real name
      const copy = path.join(dir, f), keepCopy = !sameFile(base, copy) && fs.statSync(copy).mtimeMs > fs.statSync(base).mtimeMs;
      if (keepCopy) fs.renameSync(copy, base); else fs.rmSync(copy, { recursive: true, force: true });
    } catch { /* in use: the next start tries again */ }
  }
}
function linkShared(gameDir, tag = "") {
  for (const d of SHARED_DIRS) {
    dropDuplicates(path.join(SHARED(), d));
    const link = path.join(gameDir, d), target = path.join(SHARED(), d); fs.mkdirSync(target, { recursive: true });
    let st = null; try { st = fs.lstatSync(link); } catch { /* not there yet */ }
    if (st && st.isSymbolicLink()) continue;   // already joined (a junction counts as a link)
    if (st && st.isDirectory()) {   // what this profile already has moves into the common folder, nothing is overwritten (a clash keeps both)
      for (const f of fs.readdirSync(link)) {
        let to = path.join(target, f);
        if (fs.existsSync(to)) {
          const mine = path.join(link, f), newer = !sameFile(to, mine) && fs.statSync(mine).mtimeMs > fs.statSync(to).mtimeMs;   // the same pack twice: only the newer copy stays
          if (!newer) { fs.rmSync(mine, { recursive: true, force: true }); continue; }
          fs.rmSync(to, { recursive: true, force: true });
        }
        fs.renameSync(path.join(link, f), to);
      }
      fs.rmdirSync(link);
    } else if (st) fs.rmSync(link, { force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  }
}
/** how many servers a servers.dat holds (-1 when it cannot be read): an empty list must never replace a full one */
function serverCount(file) {
  try { const root = nbtRead(fs.readFileSync(file)), e = root.v.get("servers"); return e && e.t === 9 ? e.v.items.length : 0; } catch { return -1; }
}
/** copy that keeps the time of the source, so "which one is newer" stays true */
function copyKeep(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let extra = "";   // options files: settings that only the target knows (a mod that is only in that profile) are kept and added, not wiped
  if (/^options.*\.txt$/.test(path.basename(to)) && fs.existsSync(to)) try {
    const keys = new Set(fs.readFileSync(from, "utf8").split(/\r?\n/).map((l) => l.split(":")[0]));
    extra = fs.readFileSync(to, "utf8").split(/\r?\n/).filter((l) => l.includes(":") && !keys.has(l.split(":")[0])).join("\n");
  } catch { /* plain copy */ }
  fs.copyFileSync(from, to); if (extra) fs.appendFileSync(to, (fs.readFileSync(to, "utf8").endsWith("\n") ? "" : "\n") + extra + "\n");
  try { const st = fs.statSync(from); fs.utimesSync(to, st.atime, st.mtime); } catch { /* time stays */ }
}
/** @param changedOnly (running game) only a file that is newer than the common copy goes out: every change of the settings reaches the other profiles within seconds */
function syncSharedFiles(gameDir, direction, changedOnly) {
  fs.mkdirSync(SHARED(), { recursive: true });
  for (const f of SHARED_FILES) {
    const common = path.join(SHARED(), f), mine = path.join(gameDir, f);
    try {
      const hasC = fs.existsSync(common), hasM = fs.existsSync(mine);
      const emptyVsFull = (a, b) => f === "servers.dat" && serverCount(a) === 0 && serverCount(b) > 0;   // a list without servers does not replace one with servers
      if (direction === "in") {   // the newer copy wins (a profile that was not started for a while does not undo what you set in another one); the first profile to have one seeds it
        if (hasC && hasM) { const cm = fs.statSync(common).mtimeMs, mm = fs.statSync(mine).mtimeMs; if (mm > cm + 1000 && !emptyVsFull(mine, common)) copyKeep(mine, common); else if (!emptyVsFull(common, mine) || true) { if (!emptyVsFull(common, mine)) copyKeep(common, mine); } }
        else if (hasC) copyKeep(common, mine); else if (hasM) copyKeep(mine, common);
      } else if (hasM) {
        if (changedOnly && hasC && fs.statSync(mine).mtimeMs <= fs.statSync(common).mtimeMs) continue;
        if (hasC && emptyVsFull(mine, common)) continue;
        copyKeep(mine, common);
      }
    } catch { /* a locked file: the next start tries again */ }
  }
}

async function launch({ profile, auth, send = () => {}, onClose = () => {}, rejoin = null }) {
  const stage = (s, label, pct) => send({ type: "stage", stage: s, label, pct });
  stage("prepare", "Vorbereiten", 3);
  if (!LOADERS.includes(profile.loader)) throw new Error(`Unbekannter Loader ${profile.loader}`);
  fs.mkdirSync(modsDir(profile.id), { recursive: true });
  try { linkShared(path.dirname(modsDir(profile.id)), profile.id); syncSharedFiles(path.dirname(modsDir(profile.id)), "in"); addPackServers(path.dirname(modsDir(profile.id)), profile.servers); } catch (e) { send({ type: "log", line: "Gemeinsame Daten: " + e.message }); }
  await ensureJava(profile.mc, profile, send);

  stage("loader", `${profile.loader} prüfen`, 8);
  const custom = profile.loader === "fabric" ? await ensureFabric(profile.mc) : await ensureInstalled(profile.loader, profile.mc, profile, send);

  stage("mods", "Mods prüfen", 25);
  try {   // mods switched off in the game's menu: renamed to .disabled while off
    const off = new Set((profile.disabled || []).map(String));
    for (const f of fs.readdirSync(modsDir(profile.id))) {
      const bare = f.replace(/\.disabled$/, "");
      if (bare === "cc-mod.jar" || bare === "lac-mod.jar" || !/\.jar$/i.test(bare)) continue;
      const isOff = f.endsWith(".disabled");
      if (off.has(bare) && !isOff) fs.renameSync(path.join(modsDir(profile.id), f), path.join(modsDir(profile.id), f + ".disabled"));
      else if (!off.has(bare) && isOff) fs.renameSync(path.join(modsDir(profile.id), f), path.join(modsDir(profile.id), bare));
    }
  } catch (e) { send({ type: "log", line: "Mods ein-/ausschalten: " + e.message }); }
  await syncMods(send);
  try { await ensureDeps(profile.id, send); } catch { /* offline: start anyway */ }
  if (profile.loader === "fabric" && !profile.pack) await ensureFabricApi(profile.id, send);   // a modpack brings its own Fabric API
  const lacTarget = path.join(modsDir(profile.id), "lac-mod.jar");
  const build = manifest().find((x) => x.loader === profile.loader && x.mc === profile.mc);
  if (profile.lac === false || !build) { fs.rmSync(lacTarget, { force: true }); if (profile.lac !== false) send({ type: "log", line: `Den LAC-Mod gibt es für ${profile.loader} ${profile.mc} noch nicht: Start ohne ihn` }); }
  else fs.copyFileSync(buildFile(build), lacTarget);

  FAST = fs.existsSync(verifiedMarker(profile));
  const jvm = [...SAFE, ...(process.env.LAC_NOAIKAR ? [] : AIKAR), ...(process.env.LAC_JVM || "").split(" ").filter(Boolean), ...(profile.loader === "fabric" ? [] : loaderJvmArgs(custom)), ...(profile.jvmArgs || "").split(/\s+/).filter(Boolean)];
  const gameDir = path.dirname(modsDir(profile.id));
  const mclc = new Client();
  let running = false, assetsPct = 0;
  mclc.on("progress", (p) => { if (p.total) { assetsPct = Math.max(assetsPct, Math.round(40 + (p.task / p.total) * 45)); stage("files", `Dateien laden (${p.type || ""} ${p.task}/${p.total})`, assetsPct); } });
  mclc.on("download-status", (d) => { if (d && d.name) send({ type: "log", line: `Lade ${d.name}` }); });
  const onLine = (line) => {
    send({ type: "log", line: String(line) });
    if (!running && /Setting user:/.test(line)) stage("starting", "Minecraft startet", 88);
    if (!running && /Reloading ResourceManager/.test(line)) stage("starting", "Ressourcen werden geladen", 93);
    if (!running && /Sound engine started|OpenAL initialized|Created: \d+x\d+x\d+ minecraft:textures/.test(line)) {
      running = true; stage("running", "Läuft", 100);
      fs.mkdirSync(path.dirname(verifiedMarker(profile)), { recursive: true }); fs.writeFileSync(verifiedMarker(profile), new Date().toISOString());
    }
  };
  mclc.on("debug", onLine); mclc.on("data", onLine);
  const settingsTimer = setInterval(() => { try { syncSharedFiles(gameDir, "out", true); } catch { /* next round */ } }, 15000);   // settings are saved while playing, not only when the game closes (also after a crash)
  mclc.on("close", (code) => { clearInterval(settingsTimer); try { syncSharedFiles(gameDir, "out"); removePackServers(path.join(SHARED(), "servers.dat"), profile.servers); } catch { /* next time */ } stage("closed", code === 0 ? "Beendet" : `Beendet (Code ${code})`, 0); onClose(code); });

  stage("files", "Dateien prüfen und laden", 40);
  const child = await mclc.launch({
    authorization: auth, root: ROOT, javaPath: findJava(profile.mc, profile.java),
    version: { number: profile.mc, type: "release", custom },
    memory: ramFor(profile), overrides: { gameDirectory: gameDir },
    quickPlay: rejoin ? { type: rejoin.type, identifier: rejoin.id } : process.env.LAC_QUICKPLAY ? { type: "singleplayer", identifier: process.env.LAC_QUICKPLAY } : undefined,   // come back to the world or server
    customArgs: jvm, window: startWindow(profile),
  });
  if (!child) throw new Error("Minecraft konnte nicht gestartet werden (siehe Protokoll)");
  stage("starting", "Minecraft wird gestartet", 85);
  return { kill: () => child.kill() };
}

module.exports = { searchContent, addContent, ensureDeps, checkPack, updatePack, syncMods, updateRepo, buildFile, ROOT, LOADERS, FABRIC_API, readProfiles, writeProfiles, modsDir, manifest, versions, searchMods, addMod, removeMod, ensureFabricApi, installPreset, PRESET, searchPacks, installPack, ensureFabric, ensureInstalled, findJava, ensureJava, ensureRuntimes, launch, linkShared, syncSharedFiles, SHARED, nbtRead, nbtWrite, addPackServers, removePackServers, cleanServers, ramFor, DIST };

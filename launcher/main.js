const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require("electron");

// started without a console (from the start menu, or by the game) the standard output is a broken pipe: writing to it must never raise an error dialog
for (const st of [process.stdout, process.stderr]) { try { st.on("error", () => {}); } catch { /* no stream */ } }
process.on("uncaughtException", (e) => { if (e && (e.code === "EPIPE" || /EPIPE/.test(String(e.message)))) return; console.error("[lac] uncaught:", e && e.stack || e); });

// only one launcher window ever: a second start (also the game starting the launcher for a request) just brings the first to the front
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on("second-instance", () => { /* the launcher never pulls itself to the front */ });
const fs = require("fs");
const path = require("path");
const { Auth } = require("msmc");
const core = require("./core");
const store = require("./store");
const share = require("./share");
const packs = require("./packs");
const discord = require("./discord");
const skins = require("./skins");
const os = require("os");

// log every failing IPC call to stdout so problems can be read from the launcher's console
const _handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (ch, fn) => _handle(ch, async (...a) => { try { return await fn(...a); } catch (e) { console.error(`[lac] ${ch} failed:`, e?.stack || e); throw e; } });

const SETTINGS = () => path.join(core.ROOT, "settings.json");
const readSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS(), "utf8")); } catch { return {}; } };
const writeSettings = (s) => { fs.mkdirSync(core.ROOT, { recursive: true }); fs.writeFileSync(SETTINGS(), JSON.stringify(s, null, 2)); };

let session = null;   // { mclc, uuid, name } while logged in; cosmetics also work offline for the last account
let current = null;   // running game handle

const dash = (id) => id.replace(/-/g, "").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
const user = () => session ? { uuid: session.uuid, name: session.name } : readSettings().lastUser || null;
const uuid = () => { const u = user(); if (!u) throw new Error("Bitte einmal mit Microsoft anmelden: LAC speichert alles pro Account"); return u.uuid; };

/* ---------- account ---------- */
ipcMain.handle("user", () => ({ ...(user() || {}), online: !!session }));
// Staying signed in: the refresh token is kept encrypted with Windows' own key store (safeStorage), never as plain text.
async function establish(xbox) {
  const token = await xbox.getMinecraft(), p = token.profile;
  session = { xbox, mclc: token.mclc(), uuid: dash(p.id), name: p.name };
  const st = { ...readSettings(), lastUser: { uuid: session.uuid, name: session.name } };
  try { if (safeStorage.isEncryptionAvailable()) st.refresh = safeStorage.encryptString(xbox.save()).toString("base64"); } catch { /* keep the session in memory only */ }
  writeSettings(st);
  return { uuid: session.uuid, name: session.name, online: true };
}
/** Only a real "no" from Microsoft ends the saved login. A slow or missing network at start (or a short outage) must not: that was why people had to sign in again after updates and restarts. */
const rejected = (e) => /invalid_grant|AADSTS70000|AADSTS700082|AADSTS50173|AADSTS50078|expired|revoked|unauthorized|40[01]/i.test(String((e && e.message) || e));
let silentRetry = null;
async function silentLogin() {
  const st = readSettings();
  if (!st.refresh) return;
  let token; try { token = safeStorage.decryptString(Buffer.from(st.refresh, "base64")); } catch (e) { console.error("[lac] saved login cannot be read now, kept:", e?.message || e); return; }
  const attempt = async () => { await establish(await new Auth("select_account").refresh(token)); };
  for (let i = 0; i < 3; i++) {
    try { await attempt(); return; }
    catch (e) {
      if (rejected(e)) { console.error("[lac] Microsoft refused the saved login:", e?.message || e); const { refresh, ...rest } = readSettings(); writeSettings(rest); return; }
      console.error("[lac] silent login failed (network?), trying again:", e?.message || e);
      await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
    }
  }
  // still no network: the login stays saved and is tried again every minute until it works
  if (!silentRetry) silentRetry = setInterval(async () => {
    try { await attempt(); clearInterval(silentRetry); silentRetry = null; try { tellWindow({ type: "rank", quiet: true }); } catch { /* window not ready */ } }
    catch (e) { if (rejected(e)) { clearInterval(silentRetry); silentRetry = null; const { refresh, ...rest } = readSettings(); writeSettings(rest); } }
  }, 60000);
}
ipcMain.handle("login", async () => establish(await new Auth("select_account").launch("electron")));
// Sign-in with a code (Microsoft's own device flow, same app id as above): no e-mail or SMS code is needed when the browser is already signed in to Microsoft.
let deviceCancel = false;
ipcMain.handle("login:cancel", () => { deviceCancel = true; return true; });
ipcMain.handle("login:device", async (e) => {
  const H = { "content-type": "application/x-www-form-urlencoded" }, CID = "00000000402b5328";
  const r = await fetch("https://login.live.com/oauth20_connect.srf", { method: "POST", headers: H, signal: AbortSignal.timeout(15000), body: new URLSearchParams({ client_id: CID, scope: "XboxLive.signin offline_access", response_type: "device_code" }).toString() });
  const d = await r.json().catch(() => ({}));
  if (!d.device_code) throw new Error("Microsoft hat keinen Code geschickt. Bitte gleich nochmal versuchen.");
  deviceCancel = false; e.sender.send("login:code", { code: d.user_code, url: d.verification_uri }); shell.openExternal(d.verification_uri);
  const end = Date.now() + (d.expires_in || 900) * 1000; let wait = (d.interval || 5) * 1000;
  while (Date.now() < end && !deviceCancel) {
    await new Promise((ok) => setTimeout(ok, wait));
    const t = await (await fetch("https://login.live.com/oauth20_token.srf", { method: "POST", headers: H, signal: AbortSignal.timeout(15000), body: new URLSearchParams({ client_id: CID, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: d.device_code }).toString() })).json().catch(() => ({}));
    if (t.refresh_token) return establish(await new Auth("select_account").refresh(t.refresh_token));
    if (t.error === "authorization_pending") continue;
    if (t.error === "slow_down") { wait += 5000; continue; }
    if (t.error) throw new Error(t.error_description || t.error);
  }
  throw new Error(deviceCancel ? "Anmeldung abgebrochen" : "Der Code ist abgelaufen. Bitte nochmal starten.");
});
const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
ipcMain.handle("win:min", (e) => { const w = winOf(e); if (w) w.minimize(); });
ipcMain.handle("win:max", (e) => { const w = winOf(e); if (w) (w.isMaximized() ? w.unmaximize() : w.maximize()); });
ipcMain.handle("win:close", (e) => { const w = winOf(e); if (w) w.close(); });
ipcMain.handle("logout", () => { session = null; const { refresh, ...rest } = readSettings(); writeSettings(rest); return true; });

/* ---------- local store (cosmetics, coins, LAC+): no server ---------- */
ipcMain.handle("store:catalog", () => store.catalog());
ipcMain.handle("store:me", () => store.me(uuid()));
const act = (fn) => (_e, ...a) => { const err = fn(uuid(), ...a); if (err) throw new Error(err); return store.me(uuid()); };
ipcMain.handle("store:redeem", async (_e, code) => {
  const u = uuid(); code = String(code).trim();
  let err = store.redeem(u, code);
  if (err === "Ungültiger Code") {   // not one of the fixed codes: maybe a one-time code made by a Dev, which only the sync service can check
    const r = await fetch(packs.base() + "/v1/redeem", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ uuid: u.replace(/-/g, ""), key: store.syncKey(u), code: code.toUpperCase() }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Server meldet " + r.status);
    err = store.grantRank(u, j.rank);
  }
  if (err) throw new Error(err);
  return store.me(u);
});
ipcMain.handle("store:cancel", act((u) => store.cancel(u)));
ipcMain.handle("store:cancelpro", act((u) => store.cancelPro(u)));
ipcMain.handle("store:tofree", act((u) => store.toFree(u)));
ipcMain.handle("store:buy", act((u, id) => store.buy(u, id)));
ipcMain.handle("store:equip", act((u, id, chroma) => store.equip(u, id, chroma)));
ipcMain.handle("store:unequip", act((u, type) => store.unequip(u, type)));
ipcMain.handle("store:chatpal", () => store.chatPalette(uuid()));
ipcMain.handle("store:chatcolor", act((u, hex) => store.setChatColor(u, String(hex || ""))));
ipcMain.handle("store:tag", act((u, c1, c2, eff) => store.setTag(u, c1, c2, eff)));
ipcMain.handle("store:name", act((u, c1, c2, eff, font) => store.setName(u, c1, c2, eff, font)));
ipcMain.handle("store:halo", act((u, f) => store.setHaloFollow(u, f)));
ipcMain.handle("store:uifont", act((u, font) => store.setUiFont(u, font)));
ipcMain.handle("store:adjust", act((u, id, s, x, y, z) => store.setAdjust(u, id, s, x, y, z)));

/* ---------- profiles and mods ---------- */
ipcMain.handle("versions", (_e, loader) => core.versions(loader));
ipcMain.handle("profiles", () => core.readProfiles());
ipcMain.handle("profile:save", (_e, prof) => {
  prof.creator = prof.creator || (user() && user().name) || "";
  const all = core.readProfiles(), i = all.findIndex((p) => p.id === prof.id);
  if (!core.LOADERS.includes(prof.loader)) throw new Error("Unbekannter Loader");
  prof.id ||= Date.now().toString(36);
  i >= 0 ? (all[i] = prof) : all.push(prof);
  core.writeProfiles(all);
  return all;
});
ipcMain.handle("profile:delete", (_e, id) => { const all = core.readProfiles().filter((p) => p.id !== id); core.writeProfiles(all); return all; });
ipcMain.handle("mods:search", (_e, query, profileId, offset) => { const p = core.readProfiles().find((x) => x.id === profileId); return core.searchMods(query, p.mc, p.loader, Number(offset) || 0); });
ipcMain.handle("content:search", (_e, query, profileId, kind, offset) => { const p = core.readProfiles().find((x) => x.id === profileId); if (!p) throw new Error("Profil nicht gefunden"); return core.searchContent(String(query || ""), p.mc, p.loader, String(kind), Number(offset) || 0); });
ipcMain.handle("content:add", (e, profileId, hit, kind) => { if (current) throw new Error("Minecraft läuft: Mods lassen sich erst nach dem Beenden ändern"); return core.addContent(profileId, hit, String(kind), (ev) => e.sender.send("launch", ev)); });
ipcMain.handle("mods:add", (e, profileId, mod) => core.addMod(profileId, mod, (ev) => e.sender.send("launch", ev)));
ipcMain.handle("preset:install", (e, id) => core.installPreset(id, (ev) => e.sender.send("launch", ev)));
ipcMain.handle("pack:search", (_e, q, onlyLac, loader, offset) => core.searchPacks(String(q || ""), !!onlyLac, String(loader || ""), Number(offset) || 0));
ipcMain.handle("pack:install", (e, id) => core.installPack(String(id), (ev) => e.sender.send("launch", ev)));
ipcMain.handle("pack:check", (_e, id) => core.checkPack(String(id)));
ipcMain.handle("pack:update", (e, id) => core.updatePack(String(id), (ev) => e.sender.send("launch", ev)));
ipcMain.handle("update:check", async () => {   // the settings button: launcher and LAC mod builds
  const repo = core.updateRepo(); if (!repo) throw new Error("Kein Update-Ort eingetragen (update.json)");
  let launcher = "aktuell";
  if (app.isPackaged) { const { autoUpdater } = require("electron-updater"); const r = await autoUpdater.checkForUpdates(); if (r && r.updateInfo && r.updateInfo.version !== app.getVersion()) launcher = `Version ${r.updateInfo.version} wird geladen und beim Schließen installiert`; }
  const mods = await core.syncMods();
  return { version: app.getVersion(), launcher, mods };
});
ipcMain.handle("mods:remove", (_e, profileId, modId) => core.removeMod(profileId, modId));

/* ---------- launching ---------- */
const LOGFILE = () => path.join(core.ROOT, "launcher.log");
const logLine = (s) => { try { fs.appendFileSync(LOGFILE(), String(s).replace(/(--accessToken|--uuid|--clientId|--xuid)\s+\S+/g, "$1 ***") + "\n"); } catch { /* no log is better than no game */ } };
ipcMain.handle("log:read", () => { try { const t = fs.readFileSync(LOGFILE(), "utf8"); return t.length > 400000 ? t.slice(-400000) : t; } catch { return "Noch kein Protokoll."; } });
ipcMain.handle("log:folder", () => { shell.showItemInFolder(LOGFILE()); return true; });
const addPlaytime = (id, sec) => { const all = core.readProfiles(), p = all.find((x) => x.id === id); if (p && sec > 0) { p.playtime = (p.playtime || 0) + sec; core.writeProfiles(all); } };
/** starts a profile; `tell` gets the progress events (the window, or nothing when the game asked the launcher in the background) */
async function startProfile(profileId, tell, opts = {}) {
  if (!session) throw new Error("Zum Spielen bitte mit Microsoft anmelden");
  if (current) throw new Error("Minecraft läuft schon");
  const profile = core.readProfiles().find((p) => p.id === profileId);
  if (!profile) throw new Error("Profil nicht gefunden");
  try { fs.mkdirSync(core.ROOT, { recursive: true }); fs.writeFileSync(LOGFILE(), `LAC Launcher ${app.getVersion()} · ${new Date().toISOString()} · ${process.platform} ${os.release()} · Profil ${profile.name} (${profile.loader} ${profile.mc})\n`); } catch { /* see logLine */ }
  const send = (ev) => { if (ev.type === "log") logLine(ev.line); else if (ev.type === "stage") { logLine(`[${ev.stage}] ${ev.label}`); writeStatus({ stage: ev.stage, label: ev.label, pct: ev.pct || 0, name: profile.name }); } else if (ev.type === "pack") writeStatus({ stage: "pack", label: ev.title, pct: ev.total ? Math.round(100 * ev.done / ev.total) : 0 }); tell({ ...ev, pid: profileId }); };
  cancelFlag = false;
  try { discord.launching(profile); } catch { /* presence is optional */ }
  let startedAt = 0, startedAtPlaced = false;
  const watch = (ev) => { if (ev.type === "stage" && ev.stage === "running" && !startedAt) { startedAt = Date.now(); try { discord.playing(profile, startedAt); } catch { /* optional */ } if (!startedAtPlaced) { startedAtPlaced = true; placeGame(); } if (opts.onRunning && !cancelFlag) try { opts.onRunning(); } catch { /* the other game is gone already */ } } send(ev); };
  try { session.mclc = (await session.xbox.getMinecraft()).mclc(); } catch { /* token still fine or offline: use what we have */ }
  let self = { kill() {} }; current = self;   // reserve the slot while preparing
  try {
    const h = await core.launch({ profile, rejoin: opts.rejoin || null, auth: session.mclc, send: watch, onClose: () => { if (startedAt) addPlaytime(profileId, Math.round((Date.now() - startedAt) / 1000)); const wasCurrent = current === self; if (wasCurrent) { current = null; try { discord.idle(); } catch { /* optional */ } } send({ type: "playtime" }); if (wasCurrent && !cancelFlag) { writeStatus({ stage: "closed", label: "", pct: 0 }); showLauncher(); } } });
    self = h; current = h;
    if (cancelFlag) h.kill();
  } catch (err) { if (current === self) { current = null; try { discord.idle(); } catch { /* optional */ } } logLine("FEHLER: " + (err && err.stack || err)); send({ type: "stage", stage: "error", label: err.message, pct: 0 }); throw err; }
}
let cancelFlag = false;
/** while the game restarts for mod changes, a LAC loading screen sits exactly where the game window was, so the window seems to stay open */
const cleanRejoin = (r) => (r && (r.type === "singleplayer" || r.type === "multiplayer") && typeof r.id === "string" && r.id.length < 200 && r.id.split(String.fromCharCode(10)).length === 1 && r.id.split(String.fromCharCode(13)).length === 1 ? { type: r.type, id: r.id } : null);
let splash = null;
function showSplash(win) {
  closeSplash();
  try {
    const { screen } = require("electron"), b = Array.isArray(win) && win.length === 4 && win.every(Number.isFinite) ? { x: win[0], y: win[1], width: win[2], height: win[3] } : screen.getPrimaryDisplay().bounds;
    splash = new BrowserWindow({ ...b, frame: false, alwaysOnTop: false, focusable: false, skipTaskbar: true, resizable: false, movable: false, backgroundColor: "#0B0F1E", show: false, focusable: false });
    splash.loadFile("splash.html"); splash.once("ready-to-show", () => { try { splash.showInactive(); } catch { /* closed */ } });
  } catch { splash = null; }
}
const splashText = (t) => { try { splash && splash.webContents.executeJavaScript(`document.getElementById("t").textContent=${JSON.stringify(String(t))}`); } catch { /* closed */ } };
const closeSplash = () => { try { splash && splash.destroy(); } catch { /* gone */ } splash = null; };
/** the launcher steps out of the way (minimized) while the game runs; it comes back when the game closes */
function placeGame() { if (mainWin && readSettings().keepLauncher !== true) try { mainWin.minimize(); } catch { /* window closed */ } }
const showLauncher = () => { /* on purpose empty: the launcher never comes to the front by itself */ };
const writeStatus = (o) => { try { fs.writeFileSync(path.join(core.ROOT, "status.json"), JSON.stringify({ ...o, t: Date.now() })); } catch { /* the game just shows no details */ } };
const tellWindow = (ev) => { try { mainWin && mainWin.webContents.send("launch", ev); } catch { /* window closed */ } };
ipcMain.handle("launch", (e, profileId) => startProfile(profileId, (ev) => e.sender.send("launch", ev)));
const waitForExit = async () => { for (let i = 0; i < 60 && current; i++) await new Promise((r) => setTimeout(r, 500)); };
ipcMain.handle("launch:kill", () => { current?.kill(); });

/* ---------- sync service address (read by the game's LacRemote) ---------- */
const SYNCFILE = () => path.join(core.ROOT, "sync.url");
/* ---------- skin changer: Mojang's API, the token never leaves this process except to Mojang ---------- */
const mcToken = async () => {
  if (!session) throw new Error("Zum Ändern des Skins bitte mit Microsoft anmelden");
  try { session.mclc = (await session.xbox.getMinecraft()).mclc(); } catch { /* the token we have may still be fine */ }
  return session.mclc.access_token;
};
ipcMain.handle("skin:profile", async () => skins.profile(await mcToken()));
/* the live meshes: a small Java process runs the game's own cosmetic art (launcher/helper/art.jar); it needs a Java that is already installed, else the viewer keeps its stills */
let meshProc = null, meshQ = [], meshBuf = "", adjCache = null, adjAt = 0;
function meshStart() {
  if (meshProc) return true;
  const j = core.findJava("26.3", "", true); if (!path.isAbsolute(j) || !fs.existsSync(j)) return false;
  try {
    const jar = path.join(__dirname, "helper", "art.jar").replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
    meshProc = require("child_process").spawn(j, ["-Xshare:auto", "-XX:TieredStopAtLevel=1", "-cp", jar, "MeshServer"], { windowsHide: true });
    meshProc.stdout.setEncoding("utf8"); meshProc.stdout.on("data", (d) => { meshBuf += d; let i; while ((i = meshBuf.indexOf("\n")) >= 0) { const line = meshBuf.slice(0, i); meshBuf = meshBuf.slice(i + 1); const r = meshQ.shift(); if (r) r(line); } });
    meshProc.on("exit", () => { meshProc = null; meshBuf = ""; for (const r of meshQ.splice(0)) r("null"); }); meshProc.on("error", () => { meshProc = null; }); meshProc.stdin.on("error", () => {});
    return true;
  } catch { meshProc = null; return false; }
}
const meshAsk = (line) => new Promise((res) => { if (!meshStart()) return res(null); meshQ.push(res); meshProc.stdin.write(line + "\n"); });
async function adjustments() {   // the shared default size/position of every cosmetic: catalog plus what the Devs saved
  if (adjCache && Date.now() - adjAt < 300000) return adjCache; adjAt = Date.now(); const out = {};
  for (const it of store.catalog().items || []) { const d = it.def || [1, 0, 0, 0]; out[it.id] = [d[0], d[1], d[2], d[3], it.id === "halo_magma" ? 0.55 : 1]; }
  try { const g = await (await fetch(packs.base() + "/v1/defaults", { signal: AbortSignal.timeout(6000) })).json(); for (const [id, a] of Object.entries(g)) if (Array.isArray(a) && a.length >= 4) out[id] = a.length >= 5 ? a : [...a, 1]; } catch { /* the catalog values */ }
  return (adjCache = out);
}
ipcMain.handle("mesh:frames", async (_e, items, t) => {
  if (!meshStart()) return null;
  const adj = await adjustments(), type = (id) => ((store.catalog().items || []).find((x) => x.id === id) || {}).type || "wings";
  const rs = await Promise.all(items.map((it) => { const a = adj[it.id] || [1, 0, 0, 0, 1]; return meshAsk([it.id.replace(/[^a-z0-9_]/gi, ""), type(it.id), it.variant | 0, ...a.slice(0, 5), Number(t) || 0].join("\t")); }));
  return rs.some((r) => r === null) ? null : rs;
});
app.on("before-quit", () => { try { meshProc && meshProc.kill(); } catch { /* gone */ } });
const entCache = new Map();
/** a creature model of the game (Transform forms and pets) for the viewer */
ipcMain.handle("entity:get", (_e, id) => {
  id = String(id).replace(/[^a-z0-9_]/gi, ""); if (entCache.has(id)) return entCache.get(id);
  let json = "", png = ""; try { json = fs.readFileSync(path.join(__dirname, "entities", id + ".json"), "utf8"); png = "data:image/png;base64," + fs.readFileSync(path.join(__dirname, "entities", id + ".png")).toString("base64"); } catch { /* none */ }
  const r = { json, png }; entCache.set(id, r); return r;
});
const meshCache = new Map();
/** the exported 3D model of a cosmetic (and its sprite when it has one) for the launcher's skin viewer */
ipcMain.handle("mesh:get", (_e, id) => {
  id = String(id).replace(/[^a-z0-9_]/gi, ""); if (meshCache.has(id)) return meshCache.get(id);
  let json = "", png = null; try { json = fs.readFileSync(path.join(__dirname, "meshes", id + ".json"), "utf8"); } catch { /* no model */ }
  try { png = "data:image/png;base64," + fs.readFileSync(path.join(__dirname, "meshes", id + ".png")).toString("base64"); } catch { /* no sprite */ }
  const r = { json, png }; meshCache.set(id, r); return r;
});
ipcMain.handle("skin:byuuid", (_e, id) => skins.byUuid(String(id)));
ipcMain.handle("skin:lib", () => skins.library());
ipcMain.handle("skin:add", async (e, variant) => {
  const r = await dialog.showOpenDialog(mainWin, { title: "Skin auswählen", filters: [{ name: "Skin (PNG)", extensions: ["png"] }], properties: ["openFile"] });
  if (r.canceled || !r.filePaths[0]) return null;
  return skins.addToLibrary(fs.readFileSync(r.filePaths[0]), path.basename(r.filePaths[0], ".png"), variant);
});
ipcMain.handle("skin:fromname", (e, name) => skins.fromName(name));
ipcMain.handle("skin:fromaccount", async () => skins.fromAccount(await mcToken()));
ipcMain.handle("skin:remove", (e, id) => skins.removeFromLibrary(id));
ipcMain.handle("skin:rename", (e, id, name) => skins.rename(String(id), name));
ipcMain.handle("skin:apply", async (e, id, variant) => skins.apply(await mcToken(), id, variant));
ipcMain.handle("skin:reset", async () => skins.reset(await mcToken()));
ipcMain.handle("skin:cape", async (e, id) => skins.setCape(await mcToken(), id));
ipcMain.handle("skin:namecheck", async (e, name) => skins.nameAvailable(await mcToken(), String(name)));
ipcMain.handle("skin:namechange", async (e, name) => { const r = await skins.changeName(await mcToken(), String(name)); if (session) session.name = r.name || session.name; return r; });

/* ---------- friends (read-only view of the same service the game uses; chat and invites stay in the game) ---------- */
/** the status chosen in the launcher (online, afk, offline); while the game runs, the game reports it */
const myStatus = () => { const s = readSettings().friendStatus; return s === "afk" || s === "offline" ? s : "online"; };
/**
 * Signed in on a new PC: the account proves itself with the chat key pair Mojang certifies for it (the token goes to Mojang only), and the sync service
 * moves the account's claim to this PC's key. Without this a new PC would be locked out of its own friends and cosmetics.
 */
let lastTakeover = 0, takeoverWhy = "";   // takeoverWhy: why the last attempt failed (shown to the user, so a failure is never a silent "key does not match")
async function takeover(u) {
  if (!session) { takeoverWhy = "nicht mit Microsoft angemeldet"; return false; }
  if (Date.now() - lastTakeover < 60000) return false; lastTakeover = Date.now(); takeoverWhy = "";
  try {
    const cres = await fetch("https://api.minecraftservices.com/player/certificates", { method: "POST", headers: { authorization: "Bearer " + (await mcToken()) }, signal: AbortSignal.timeout(15000) });
    if (!cres.ok) { takeoverWhy = "Mojang-Zertifikat: HTTP " + cres.status; return false; }
    const cr = await cres.json();
    const pem = (s) => s.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const nonce = (await (await fetch(packs.base() + "/v1/nonce", { signal: AbortSignal.timeout(10000) })).json()).nonce;
    const sign = require("crypto").createSign("RSA-SHA256"); sign.update(nonce);
    const nsig = sign.sign(require("crypto").createPrivateKey({ key: Buffer.from(pem(cr.keyPair.privateKey), "base64"), format: "der", type: "pkcs8" })).toString("base64");
    const r = await fetch(packs.base() + "/v1/takeover", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ uuid: u.uuid.replace(/-/g, ""), key: store.syncKey(u.uuid), nonce, expiresAt: Date.parse(cr.expiresAt), pub: pem(cr.keyPair.publicKey), sig: cr.publicKeySignatureV2, nsig }) });
    if (!r.ok) takeoverWhy = "Server: " + ((await r.json().catch(() => ({}))).error || "HTTP " + r.status);
    return r.ok;
  } catch (e) { takeoverWhy = String((e && e.message) || e); return false; }
}
async function friendsCall(ops, presence, again) {
  const u = user(); if (!u) throw new Error("Bitte einmal mit Microsoft anmelden");
  const r = await fetch(packs.base() + "/v1/f", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ uuid: u.uuid.replace(/-/g, ""), name: u.name, key: store.syncKey(u.uuid), ops, ...(presence ? { presence } : {}) }) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 403 && !again && /Gerät|Schlüssel passt/.test(j.error || "") && (await takeover(u))) return friendsCall(ops, presence, true);   // another PC held the claim
  if (!r.ok) throw new Error((j.error || "Server meldet " + r.status) + (r.status === 403 && takeoverWhy ? ` (Übernahme dieses Geräts fehlgeschlagen: ${takeoverWhy})` : ""));
  return j;
}
const beat = () => (current ? friendsCall([]) : friendsCall([], { status: myStatus(), server: "Im Launcher", addr: "" }));
ipcMain.handle("friends:get", async () => { const j = await beat(); return { code: j.code, friends: j.friends, status: myStatus() }; });
ipcMain.handle("friends:status", async (e, s) => { writeSettings({ ...readSettings(), friendStatus: ["online", "afk", "offline"].includes(s) ? s : "online" }); await beat(); return myStatus(); });
setInterval(() => { if (session) beat().catch(() => {}); }, 60000);   // friends see you while the launcher is open
ipcMain.handle("friends:add", async (e, code) => { const j = await friendsCall([{ op: "add", code: String(code) }]); const res = (j.results || [])[0] || {}; if (res.error) throw new Error(res.error); return { name: res.name || "" }; });

/* ---------- profile overview: everything inside one profile (mods, resource packs, shaders) with pictures ---------- */
function zipIcon(file, kind) {
  try {
    const AdmZip = require("adm-zip"), z = new AdmZip(file); let name = null;
    if (kind === "mod") {
      const fm = z.getEntry("fabric.mod.json");
      if (fm) { const o = JSON.parse(z.readAsText(fm)); const ic = o.icon; if (typeof ic === "string") name = ic; else if (ic && typeof ic === "object") { let best = -1; for (const [k, v] of Object.entries(ic)) { const s = +k || 0; if ((s > best && s <= 256) || !name) { best = s; name = v; } } } }
      if (!name) for (const t of ["META-INF/neoforge.mods.toml", "META-INF/mods.toml"]) { const e = z.getEntry(t); if (e) { const m = /logoFile\s*=\s*["']([^"']+)["']/.exec(z.readAsText(e)); if (m) { name = m[1]; break; } } }
    }
    const e = z.getEntry((name || "pack.png").replace(/^\//, "")); if (!e) return "";
    const d = e.getData(); return d.length > 250000 ? "" : "data:image/png;base64," + d.toString("base64");
  } catch { return ""; }
}
const niceMod = (f) => { const n = f.replace(/\.jar(\.disabled)?$/i, "").replace(/[-_+ ](v?\d|fabric|forge|neoforge|mc\d|quilt|universal|modern|build).*$/i, "").replace(/[-_]/g, " ").trim(); return n ? n[0].toUpperCase() + n.slice(1) : f; };
ipcMain.handle("profile:contents", (e, id) => {
  const prof = core.readProfiles().find((p) => p.id === String(id)); if (!prof) throw new Error("Profil nicht gefunden");
  const inst = path.dirname(core.modsDir(prof.id)), ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  const known = new Map((prof.mods || []).map((m) => [m.file, m]));
  const mods = ls(core.modsDir(prof.id)).filter((f) => /\.jar(\.disabled)?$/i.test(f)).sort((a, b) => a.localeCompare(b)).map((f) => {
    const bare = f.replace(/\.disabled$/, ""), k = known.get(bare);
    return { file: bare, title: k ? k.title : niceMod(f), enabled: !f.endsWith(".disabled"), src: k && !k.own ? "pack" : "own", dep: !!(k && k.dep), locked: /^(lac-mod|fabric-api)/.test(bare), icon: zipIcon(path.join(core.modsDir(prof.id), f), "mod") };
  });
  let active = []; try { const o = fs.readFileSync(path.join(inst, "options.txt"), "utf8").split(/\r?\n/).find((l) => l.startsWith("resourcePacks:")); active = JSON.parse(o.slice("resourcePacks:".length)); } catch { /* none */ }
  const packs = ls(path.join(inst, "resourcepacks")).filter((f) => /\.zip$/i.test(f) || fs.existsSync(path.join(inst, "resourcepacks", f, "pack.png"))).map((f) => ({ file: f, title: f.replace(/\.zip$/i, ""), enabled: active.includes("file/" + f), icon: /\.zip$/i.test(f) ? zipIcon(path.join(inst, "resourcepacks", f), "pack") : "" }));
  let shaderOn = ""; try { shaderOn = (fs.readFileSync(path.join(inst, "config", "iris.properties"), "utf8").match(/^shaderPack=(.*)$/m) || [])[1] || ""; } catch { /* none */ }
  const shaders = ls(path.join(inst, "shaderpacks")).filter((f) => /\.zip$/i.test(f) || fs.existsSync(path.join(inst, "shaderpacks", f, "shaders"))).map((f) => ({ file: f, title: f.replace(/\.zip$/i, ""), enabled: f === shaderOn, icon: "" }));
  const own = new Set(prof.ownFiles || []); for (const x of packs) x.src = own.has("resourcepacks/" + x.file) ? "own" : "pack"; for (const x of shaders) x.src = own.has("shaderpacks/" + x.file) ? "own" : "pack";
  return { isPack: !!(prof.pack || prof.fromPack), name: prof.name, loader: prof.loader, mc: prof.mc, creator: prof.creator || "", ram: prof.ram, playtime: prof.playtime || 0, lac: prof.lac !== false, mods, packs, shaders };
});
ipcMain.handle("profile:togglemod", (e, id, file, on) => {
  if (current) throw new Error("Minecraft läuft: Mods lassen sich erst nach dem Beenden ändern");
  const all = core.readProfiles(), prof = all.find((p) => p.id === String(id)); if (!prof) throw new Error("Profil nicht gefunden");
  const f = path.basename(String(file)), dir = core.modsDir(prof.id), from = path.join(dir, on ? f + ".disabled" : f), to = path.join(dir, on ? f : f + ".disabled");
  if (fs.existsSync(from)) fs.renameSync(from, to);
  prof.disabled = (prof.disabled || []).filter((x) => x !== f); if (!on) prof.disabled.push(f); core.writeProfiles(all); return true;
});

/* ---------- screenshots: a gallery of the newest pictures of all profiles, and a link to share one ---------- */
const INSTANCES = () => path.join(core.ROOT, "instances");
const insideInstances = (f) => { const r = path.resolve(f), b = path.resolve(INSTANCES()) + path.sep; return r.startsWith(b) && r.toLowerCase().endsWith(".png"); };
ipcMain.handle("shots:list", () => {
  const { nativeImage } = require("electron"), out = [];
  try {
    for (const inst of fs.readdirSync(INSTANCES())) {
      const dir = path.join(INSTANCES(), inst, "screenshots");
      let names = []; try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) if (n.toLowerCase().endsWith(".png")) { const f = path.join(dir, n); try { out.push({ file: f, name: n, t: fs.statSync(f).mtimeMs }); } catch { /* gone */ } }
    }
  } catch { /* no instances yet */ }
  out.sort((a, b) => b.t - a.t);
  return out.slice(0, 24).map((o) => { let thumb = ""; try { thumb = nativeImage.createFromPath(o.file).resize({ width: 320 }).toDataURL(); } catch { /* no preview */ } return { ...o, thumb }; });
});
ipcMain.handle("shots:share", async (e, file) => {
  throw new Error("tba (to be announced)");   // photos are not stored on the server for now
  if (!insideInstances(String(file))) throw new Error("Datei nicht erlaubt");
  const { nativeImage } = require("electron"), u = user(); if (!u) throw new Error("Bitte einmal mit Microsoft anmelden");
  let img = nativeImage.createFromPath(String(file)); if (img.isEmpty()) throw new Error("Bild nicht lesbar");
  const sz = img.getSize(); if (sz.width > 1600) img = img.resize({ width: 1600 });
  let jpg = null; for (const q of [88, 75, 60, 45]) { jpg = img.toJPEG(q); if (jpg.length <= 1400000) break; }
  if (jpg.length > 1400000) throw new Error("Bild zu groß");
  const r = await fetch(packs.base() + "/v1/shot", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(25000), body: JSON.stringify({ uuid: u.uuid.replace(/-/g, ""), key: store.syncKey(u.uuid), jpg: jpg.toString("base64") }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "Server meldet " + r.status);
  require("electron").clipboard.writeText(j.url); return j.url;
});
ipcMain.handle("shots:folder", (e, file) => { if (insideInstances(String(file))) shell.showItemInFolder(path.resolve(String(file))); return true; });

/* ---------- Dev: roles of players ---------- */
ipcMain.handle("codes:make", async (_e, rank, count) => {   // every Dev may make one-time codes; the service keeps only their hashes
  const code = store.devCode(uuid()); if (!code) throw new Error("Nur mit Dev-Rang");
  const r = await fetch(packs.base() + "/v1/codes", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ code, rank, count: Math.max(1, Math.min(20, count | 0)), by: user() && user().name }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "Server meldet " + r.status); return j.codes;
});
ipcMain.handle("founder:get", async () => {   // is the Founder program on (the sync service decides)
  try { const r = await fetch(packs.base() + "/v1/founder", { signal: AbortSignal.timeout(8000) }); return !!(await r.json()).on; } catch { return false; }
});
ipcMain.handle("founder:set", async (_e, on) => {   // a Dev switches it
  const code = store.devCode(uuid()); if (!code) throw new Error("Nur mit Dev-Rang");
  const r = await fetch(packs.base() + "/v1/founder", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ code, on: !!on, by: "Launcher" }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "Server meldet " + r.status); return !!j.on;
});
ipcMain.handle("devlog:get", async () => {
  const code = store.devCode(uuid()); if (!code) throw new Error("Nur mit Dev-Rang");
  const r = await fetch(packs.base() + "/v1/devlog", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10000), body: JSON.stringify({ code }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "Server meldet " + r.status); return j.log;
});
/** A fresh install starts with the profile "Main" (Fabric 26.3 with the standard mods, shaders and resource packs), so the game can be started right after signing in.
 *  It is made once: an install that already has profiles gets nothing added, and a Main the player deleted does not come back. */
async function ensureMainProfile() {
  const done = () => writeSettings({ ...readSettings(), mainDone: true });
  if (readSettings().mainDone) return;
  if (core.readProfiles().length) return done();
  const prof = { id: "main", name: "Main", loader: "fabric", mc: "26.3", mods: [], ram: "4096M", playtime: 0, lac: true, creator: (user() && user().name) || "" };
  core.writeProfiles([prof]); done(); tellWindow({ type: "playtime" });
  tellWindow({ type: "update", line: "Profil Main wird eingerichtet (Mods, Shader, Ressourcenpakete)" });
  try {
    await core.ensureFabric("26.3");
    const r = await core.installPreset("main", (ev) => tellWindow(ev));
    await core.ensureFabricApi("main", () => {});
    tellWindow({ type: "update", line: `Profil Main ist bereit (${r.installed.length} Mods und Pakete)` });
  } catch (e) { tellWindow({ type: "update", line: "Profil Main: Einrichtung nicht abgeschlossen, was fehlt, wird beim Start nachgeholt (" + e.message + ")" }); }
  tellWindow({ type: "playtime" });
}

/** every 5 seconds: the role list of the sync service. A rank a Dev gave counts here too, and the screens refresh when it changed. */
let rolesFirst = true;
async function pollRoles() {
  try {
    const roles = await packs.roles(), u = user();
    const before = u ? store.grantedOf(u.uuid) : ""; store.setGranted(roles);
    if (u && store.grantedOf(u.uuid) !== before) tellWindow({ type: "rank", quiet: rolesFirst });
    rolesFirst = false;
  } catch { /* offline: next round */ }
}
const retryDev = () => { try { packs.retryPending(uuid()).catch(() => {}); } catch { /* not signed in */ } };
setInterval(retryDev, 10 * 60_000); setTimeout(retryDev, 90_000);   // Dev actions that could not be sent
setInterval(pollRoles, 10 * 60_000); setTimeout(pollRoles, 3000);   // every 10 minutes, from the GitHub copy: the sync service has a daily limit
ipcMain.handle("mc:lang", () => {   // "de" or "en" from the language Minecraft is set to, "" while there is no options.txt yet
  const files = [path.join(core.SHARED(), "options.txt"), ...core.readProfiles().map((p) => path.join(core.ROOT, "instances", p.id, "options.txt"))];
  for (const f of files) { try { const m = /^lang:(\S+)/m.exec(fs.readFileSync(f, "utf8")); if (m) return /^de/i.test(m[1]) ? "de" : "en"; } catch { /* next */ } }
  return "";
});
ipcMain.handle("roles:get", async () => (await fetch(packs.base() + "/v1/roles", { signal: AbortSignal.timeout(10000) })).json());
ipcMain.handle("roles:set", async (e, name, rank) => {
  return packs.postRole(uuid(), name, rank, user() && user().name);
});
ipcMain.handle("sync:get", () => { try { return fs.readFileSync(SYNCFILE(), "utf8").trim(); } catch { return ""; } });
ipcMain.handle("sync:set", (_e, url) => {
  url = String(url || "").trim();
  if (url && !/^https:\/\/[A-Za-z0-9.\-]+(:\d+)?(\/[A-Za-z0-9._~\-\/]*)?$/.test(url)) throw new Error("Bitte eine https-Adresse eingeben");
  fs.mkdirSync(core.ROOT, { recursive: true }); if (url) fs.writeFileSync(SYNCFILE(), url); else fs.rmSync(SYNCFILE(), { force: true });
  return url;
});

/* ---------- system, sharing ---------- */
ipcMain.handle("sys:ram", () => ({ totalMb: Math.floor(os.totalmem() / 1048576) }));
ipcMain.handle("share:code", (_e, id) => share.exportCode(id));
ipcMain.handle("share:import-code", (e, code) => share.importCode(code, (ev) => e.sender.send("launch", ev)));
ipcMain.handle("share:zip", async (_e, id) => {
  const p = core.readProfiles().find((x) => x.id === id); if (!p) throw new Error("Profil nicht gefunden");
  const r = await dialog.showSaveDialog({ defaultPath: `${p.name.replace(/[^\w.-]+/g, "_")}.lacprofile.zip`, filters: [{ name: "LAC Profil", extensions: ["zip"] }] });
  if (r.canceled) return null;
  await share.exportZip(id, r.filePath); return r.filePath;
});
ipcMain.handle("share:import-zip", async (e) => {
  const r = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "LAC Profil", extensions: ["zip"] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return share.importZip(r.filePaths[0], (ev) => e.sender.send("launch", ev));
});

/* ---------- LAC mod downloads (for your own modpacks) ---------- */
ipcMain.handle("dist:list", () => core.manifest());
ipcMain.handle("dist:save", async (_e, entry) => {   // look the build up again, never trust a renderer-supplied path
  const m = core.manifest().find((x) => x.loader === entry.loader && x.mc === entry.mc);
  if (!m) throw new Error(`Für ${entry.loader} ${entry.mc} gibt es noch keinen Build`);
  const r = await dialog.showSaveDialog({ defaultPath: m.file, filters: [{ name: "Mod", extensions: ["jar"] }] });
  if (r.canceled) return null;
  fs.copyFileSync(core.buildFile(m), r.filePath);
  return r.filePath;
});

/* ---------- updates: the launcher itself (electron-updater, from the GitHub release named in update.json) and newer LAC mod builds ---------- */
/** state of the launcher's own update, shown as a popup and on the settings page: { state: idle|checking|downloading|ready, version, percent } */
let upd = { state: "idle" }, upTimer = null;
const setUpd = (o) => { upd = { ...upd, ...o }; try { mainWin && mainWin.webContents.send("lupdate", upd); } catch { /* window closed */ } };
ipcMain.handle("update:state", () => upd);
ipcMain.handle("update:install", () => { const { autoUpdater } = require("electron-updater"); clearTimeout(upTimer); autoUpdater.quitAndInstall(true, true); });
function startUpdates(w) {
  const repo = core.updateRepo(); if (!repo || !app.isPackaged) return;
  const tell = (line) => { try { w.webContents.send("launch", { type: "update", line }); } catch { /* window closed */ } };
  if (process.platform === "darwin") {   // shortcut: unsigned Mac builds cannot self-update, so only say that a newer version exists (upgrade: sign the app and use electron-updater here too)
    fetch(`https://github.com/${repo}/releases/latest/download/latest-mac.yml`, { signal: AbortSignal.timeout(8000) }).then((r) => r.text()).then((t) => {
      const v = (/^version:\s*(\S+)/m.exec(t) || [])[1], cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
      if (v && cmp(v, app.getVersion()) > 0) { tell(`Neue Launcher-Version ${v}: bitte von GitHub laden (Releases, Datei ...-mac.dmg)`); setUpd({ state: "idle" }); }
    }).catch(() => { /* offline */ });
    core.syncMods().then((n) => { if (n) tell(`${n} neue(r) LAC-Mod-Build(s) geladen`); });
    return;
  }
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.setFeedURL({ provider: "generic", url: `https://github.com/${repo}/releases/latest/download` });
    autoUpdater.logger = null;   // its log lines go nowhere: no console to write to
    autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => setUpd({ state: "checking" }));
    autoUpdater.on("update-not-available", () => setUpd({ state: "idle" }));
    autoUpdater.on("update-available", (i) => { tell(`Launcher-Update ${i.version} wird geladen`); setUpd({ state: "downloading", version: i.version, percent: 0 }); });
    autoUpdater.on("download-progress", (p) => setUpd({ state: "downloading", percent: Math.round(p.percent || 0) }));
    autoUpdater.on("update-downloaded", (i) => {
      tell(`Launcher-Update ${i.version} ist bereit`); setUpd({ state: "ready", version: i.version, percent: 100 });
      clearTimeout(upTimer);   // installs right away and restarts, but never while the game runs
      upTimer = setTimeout(function again() { if (current) upTimer = setTimeout(again, 30000); else autoUpdater.quitAndInstall(true, true); }, 2000);   // silent install, then the launcher starts again
    });
    autoUpdater.on("error", (e) => { console.error("[lac] launcher update:", e?.message || e); if (upd.state !== "ready") setUpd({ state: "idle" }); });
    autoUpdater.checkForUpdates().catch(() => {});
  } catch (e) { console.error("[lac] updater unavailable:", e?.message || e); }
  core.syncMods().then((n) => { if (n) tell(`${n} neue(r) LAC-Mod-Build(s) geladen`); });
}

/* ---------- LAC Modpacks, profile pictures, requests from the game ---------- */
ipcMain.handle("packs:list", () => packs.list());
ipcMain.handle("packs:updates", () => packs.updates());
ipcMain.handle("packs:update", async (e, id) => packs.update(String(id), (ev) => e.sender.send("launch", ev)));
ipcMain.handle("packs:install", async (e, id) => packs.install(id, (ev) => e.sender.send("launch", ev)));
ipcMain.handle("packs:publish", (_e, profileId, desc) => packs.publish(uuid(), String(profileId), String(desc || "")));
ipcMain.handle("packs:remove", (_e, id) => packs.remove(uuid(), String(id)));
ipcMain.handle("profile:folder", async (_e, id, which) => {   // opens the profile's mods folder (or the whole instance) in the file explorer
  const inst = path.dirname(core.modsDir(String(id))), dir = which === "instance" ? inst : ["resourcepacks", "shaderpacks"].includes(which) ? path.join(inst, which) : core.modsDir(String(id));
  fs.mkdirSync(dir, { recursive: true }); const err = await shell.openPath(dir); if (err) throw new Error(err); return true;
});
ipcMain.handle("sys:root", () => core.ROOT);
ipcMain.handle("profile:icon", async (_e, profileId) => {   // choose a picture, make it a 128x128 PNG
  const r = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "Bild", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const { nativeImage } = require("electron"); let img = nativeImage.createFromPath(r.filePaths[0]);
  if (img.isEmpty()) throw new Error("Das Bild konnte nicht gelesen werden");
  const { width, height } = img.getSize(), side = Math.min(width, height);
  img = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side }).resize({ width: 128, height: 128, quality: "best" });
  return packs.setIcon(String(profileId), img.toPNG());
});

if (process.env.LAC_UISHOT) app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion,WinRetrieveSuggestionsOnlyOnDemand");   // test screenshots of a window nobody looks at
app.commandLine.appendSwitch("enable-gpu-rasterization"); app.commandLine.appendSwitch("enable-zero-copy");
app.whenReady().then(async () => {
  try { discord.start(); } catch { /* optional */ }
  await silentLogin();
  const w = new BrowserWindow({ width: 1240, height: 780, minWidth: 980, minHeight: 640, backgroundColor: "#07070c", autoHideMenuBar: true, frame: false,
    icon: path.join(__dirname, "build", "icon.png"), title: "LAC Launcher",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, spellcheck: false } });
  mainWin = w;
  packs.startBridge(process.execPath, async (req) => {   // what the game asks for: switch profile, install a pack, apply mods
    if (req.type === "switch" || req.type === "mods") {
      const id = String(req.profile || "");
      if (req.type === "mods") { const all = core.readProfiles(), p = all.find((x) => x.id === id); if (p && Array.isArray(req.disabled)) { p.disabled = req.disabled.map((f) => path.basename(String(f))); core.writeProfiles(all); } }
      if (req.type === "switch" && current) {   // the new game starts while this one stays open; this one is closed when the new one is up
        const old = current; current = null;
        await startProfile(id, tellWindow, { onRunning: () => old.kill() }).catch((e) => { console.error("[lac] switch failed:", e.message); if (!current) current = old; });
      } else if (req.type === "mods") {   // the game must close first (it holds the mod files); a loading screen takes its place until the new one is up
        showSplash(req.win);
        if (current) { current.kill(); await waitForExit(); }
        await startProfile(id, (ev) => { tellWindow(ev); if (ev.type === "stage" && ev.label) splashText(ev.label); }, { onRunning: () => setTimeout(closeSplash, 7000), rejoin: cleanRejoin(req.rejoin) }).catch((e) => { console.error("[lac] restart failed:", e.message); closeSplash(); });
      } else {
        if (current) { current.kill(); await waitForExit(); }
        await startProfile(id, tellWindow).catch((e) => console.error("[lac] switch failed:", e.message));
      }
    } else if (req.type === "cancel") {
      cancelFlag = true; if (current && current.kill) current.kill();
    } else if (req.type === "installpack") {
      const r = await core.installPack(String(req.project || ""), tellWindow).then(() => true).catch((e) => { tellWindow({ type: "update", line: "Modpack konnte nicht installiert werden: " + e.message }); return false; });
      if (r) tellWindow({ type: "update", line: `${req.title || "Modpack"} wurde installiert` });
    } else if (req.type === "addmod") {
      const r = await core.addMod(String(req.profile || ""), { id: String(req.project || ""), title: String(req.title || "") }, tellWindow).then(() => true).catch((e) => { tellWindow({ type: "update", line: "Mod konnte nicht hinzugefügt werden: " + e.message }); return false; });
      if (r) tellWindow({ type: "update", line: `${req.title || "Mod"} wurde dem Profil hinzugefügt` });
    } else if (req.type === "install") {
      const r = await packs.install(String(req.pack || ""), tellWindow).catch((e) => { tellWindow({ type: "update", line: "Modpack-Installation fehlgeschlagen: " + e.message }); return null; });
      if (r) { tellWindow({ type: "update", line: `Modpack ${r.profile.name} installiert` }); if (req.launch) { const old = current; current = null; await startProfile(r.profile.id, tellWindow, { onRunning: () => old && old.kill() }).catch(() => { if (!current) current = old; }); } }
    }
  });
  w.loadFile("index.html");
  w.webContents.once("did-finish-load", () => {
    startUpdates(w);
    // every start: whatever the game needs and is missing (Java 25 / 21) is installed in the background
    core.ensureRuntimes((ev) => { if (ev.type === "stage" && ev.label) tellWindow({ type: "update", line: ev.label }); })
      .then((got) => { if (got) tellWindow({ type: "update", line: "Java ist installiert, alles bereit" }); })
      .catch((e) => tellWindow({ type: "update", line: "Java konnte nicht installiert werden: " + e.message }))
      .then(() => core.ensureFabric("26.3")).catch(() => { /* offline: it is fetched when the game starts */ })
      .then(() => ensureMainProfile()).catch((e) => console.error("[lac] main profile:", e && e.message))
      .then(async () => {   // every start: the LAC modpacks the player has are brought to their newest version (from the sync service, else from the GitHub copy)
        for (const u of await packs.updates().catch(() => [])) {
          if (current) break;
          try { await packs.update(u.profile, () => {}); tellWindow({ type: "update", line: `Modpack ${u.name} aktualisiert (Version ${u.latest})` }); } catch (e) { tellWindow({ type: "update", line: `Modpack ${u.name}: Update fehlgeschlagen (${e.message})` }); }
        }
      }).catch(() => {});
  });
  if (process.env.LAC_UISHOT) require("./devshot")(w, process.env.LAC_UISHOT);   // dev tool, off unless the variable is set
});

// Discord Rich Presence for the launcher (works before Minecraft is open): talks to the Discord app over its local IPC pipe, no extra package.
// It needs the application id of a Discord application (https://discord.com/developers/applications): put it into launcher/discord.json {"clientId": "..."},
// or into a file discord.id in the LAC folder (that one wins). Without an id nothing happens. The large picture is the asset "lac" of that application.
const net = require("net");
const fs = require("fs");
const path = require("path");
const core = require("./core");

let sock = null, ready = false, want = null, timer = null, clientId = "", nonce = 0, started = Date.now(), enabled = true;

function readId() {
  try { const f = fs.readFileSync(path.join(core.ROOT, "discord.id"), "utf8").trim(); if (/^\d{15,25}$/.test(f)) return f; } catch { /* the shipped one */ }
  try { const j = JSON.parse(fs.readFileSync(path.join(__dirname, "discord.json"), "utf8")); if (j && /^\d{15,25}$/.test(String(j.clientId || ""))) return String(j.clientId); } catch { /* none */ }
  return "";
}
const pipeName = (i) => process.platform === "win32" ? `\\\\?\\pipe\\discord-ipc-${i}` : path.join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || "/tmp", `discord-ipc-${i}`);

function frame(op, obj) { const j = Buffer.from(JSON.stringify(obj)), b = Buffer.alloc(8 + j.length); b.writeInt32LE(op, 0); b.writeInt32LE(j.length, 4); j.copy(b, 8); return b; }

function tryPipe(i, done) {
  if (i > 9) return done(null);
  const s = net.createConnection(pipeName(i));
  s.once("error", () => tryPipe(i + 1, done));
  s.once("connect", () => { s.removeAllListeners("error"); done(s); });
}

function connect() {
  if (!enabled || sock || !clientId) return;
  tryPipe(0, (s) => {
    if (!s) return;
    sock = s; ready = false; let buf = Buffer.alloc(0);
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0), len = buf.readInt32LE(4); if (buf.length < 8 + len) break;
        let msg = {}; try { msg = JSON.parse(buf.subarray(8, 8 + len).toString("utf8")); } catch { /* ignore */ }
        buf = buf.subarray(8 + len);
        if (op === 1 && msg.evt === "READY") { ready = true; push(); }
        if (op === 2) { try { s.destroy(); } catch { /* closed */ } }
      }
    });
    const gone = () => { if (sock === s) { sock = null; ready = false; } };
    s.on("close", gone); s.on("error", gone);
    s.write(frame(0, { v: 1, client_id: clientId }));
  });
}

function push() {
  if (!ready || !sock) return;
  const activity = want ? { details: want.details, state: want.state, timestamps: { start: Math.floor((want.start || started) / 1000) }, assets: { large_image: "lac", large_text: "LAC Client" } } : null;
  try { sock.write(frame(1, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity }, nonce: String(++nonce) })); } catch { /* reconnect later */ }
}

/** what is shown now; null clears it */
function set(a) { want = a; push(); }

function start() {
  clientId = readId(); if (!clientId) return false;
  started = Date.now(); connect(); timer = setInterval(connect, 15000);   // Discord may be started after the launcher
  idle(); return true;
}
function stop() { if (timer) clearInterval(timer); timer = null; try { set(null); if (sock) sock.destroy(); } catch { /* ignore */ } sock = null; ready = false; }
function setEnabled(on) { enabled = !!on; if (!enabled) { try { set(null); } catch { /* ignore */ } } else { connect(); idle(); } }

/** in the launcher, no game running */
function idle() { set(enabled ? { details: "Im LAC Launcher", state: "Bereit zum Spielen", start: started } : null); }
function launching(profile) { set(enabled ? { details: "Startet Minecraft " + profile.mc, state: profile.name + " · " + (profile.loader || ""), start: Date.now() } : null); }
function playing(profile, since) { set(enabled ? { details: "Spielt Minecraft " + profile.mc + " mit LAC", state: profile.name, start: since || Date.now() } : null); }

module.exports = { start, stop, set, idle, launching, playing, setEnabled };

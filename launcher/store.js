// LAC's local store, shared with the Minecraft mod (mod/src/client/java/dev/lac/LacStore.java): same file, same format.
// %APPDATA%/.lac/lac.dat, AES-256-GCM: "LAC1" | iv(12) | ciphertext | tag(16). No network, works offline.
// Honest limit: the key is embedded, so this stops casual editing and detects damage, not a determined reverse engineer.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PEPPER = "lac-store-v1:7f3a91c2e5b84d06";
const CODE_HASH = "6579677e08cee86e29cb6c97bfe05ecd9bf1ef996f397955073cbc0e90901d71"; // sha256("lac-code:" + code)
const DEV_HASH = "e571ebc85c3c49cebaf117e556f1edfa653a47abf878ba2dbdcf40f1e3d1808f";   // Dev rank: everything, and the only rank that sets cosmetic sizes (in the game)
const PRO_HASH = "d3dd9ca618d84642e0e01f81f6a8d4ecf9934db3ee524ffe306d391c733279f3";   // LAC Pro: badge and name only
const KEY = crypto.createHash("sha256").update(PEPPER).digest();
const EFFECTS = ["solid", "gradient", "rainbow", "pulse", "glow", "shimmer", "wave", "twist"];
const UI_FONTS = ["poppins", "righteous", "audiowide", "pressstart"];
const NAME_FONTS = ["default", "poppins", "righteous", "audiowide", "pressstart"];

const dataDir = () => path.join(process.env.APPDATA || require("os").homedir(), ".lac");
const file = () => process.env.LAC_STORE || path.join(dataDir(), "lac.dat");

function catalog() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "catalog.json"), "utf8").replace(/^﻿/, "")); } catch { return { types: [], items: [], chromas: 6 }; }
}

function read() {
  try {
    const raw = fs.readFileSync(file());
    if (raw.subarray(0, 4).toString() !== "LAC1") throw new Error("bad magic");
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, raw.subarray(4, 16));
    d.setAuthTag(raw.subarray(raw.length - 16));
    const json = Buffer.concat([d.update(raw.subarray(16, raw.length - 16)), d.final()]).toString("utf8");
    const f = JSON.parse(json);
    return f && f.users ? f : { users: {} };
  } catch (e) { return { users: {} }; } // missing, damaged or edited: start clean instead of trusting it
}

function write(f) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(f), "utf8"), c.final()]);
  const out = Buffer.concat([Buffer.from("LAC1"), iv, enc, c.getAuthTag()]);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + ".tmp";
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file()); // atomic: never a half-written file
}

const NAME_FX = ["shaking", "waving", "iterating", "flipping", "skewing", "growing", "gradient", "rainbow", "metallic", "fade", "shimmer", "blinking", "chromatic", "fire", "outline", "glowing", "aurora", "sweep", "breathe", "neon"];
const BADGE_FX = ["shaking", "waving", "flipping", "gradient", "rainbow", "metallic", "fade", "shimmer", "blinking", "chromatic", "fire", "glowing", "aurora", "sweep", "breathe", "neon"];
const EXCL = [["gradient", "rainbow", "metallic", "chromatic", "fire", "aurora"], ["shaking", "waving", "flipping", "iterating"], ["skewing", "growing"], ["fade", "blinking", "glowing", "breathe"], ["glowing", "outline", "neon"]];
const validFx = (fx, allowed) => Array.isArray(fx) && fx.length <= 5 && new Set(fx).size === fx.length && fx.every((e) => allowed.includes(e)) && !fx.some((a, i) => fx.some((b, j) => j > i && EXCL.some((g) => g.includes(a) && g.includes(b))));
const blank = () => ({ giftUntil: 0, giftedTo: [], giftUsed: [], chatColor: "", pro: false, advances: [], xp: 0, haloFollow: true, coins: 0, plus: false, owned: [], equipped: [], chroma: {}, tag: { color: "#7c5cff", color2: "#00d4ff", effect: "gradient" }, name: { color: "#ffffff", color2: "#7c5cff", effect: "solid", font: "default" }, uiFont: "poppins", adjust: {}, ticksPlayed: 0 });
const P = (d) => d.plus || d.creator || (d.giftUntil || 0) > Date.now();   // a Creator has everything LAC+ gives
const styled = (d) => P(d) || d.pro || d.dev;
const isRed = (hex) => { const m = /^#([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return false; const c = parseInt(m[1], 16), r = (c >> 16 & 255) / 255, g = (c >> 8 & 255) / 255, b = (c & 255) / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), dl = mx - mn; if (mx < 0.35 || mx === 0 || dl / mx < 0.5) return false; let h = mx === r ? ((g - b) / dl) * 60 : mx === g ? (2 + (b - r) / dl) * 60 : (4 + (r - g) / dl) * 60; h = ((h % 360) + 360) % 360; return h <= 20 || h >= 340; };
/** Free: nothing; Pro: colours, no animations; Plus: everything but red colours; Dev: everything */
const styleCheck = (d, c1, c2, effects) => { if (d.dev) return null; if (effects.includes("fire")) return "Feuer gibt es nur mit Dev-Rang"; if (effects.length && !P(d)) return "Animationen gibt es ab LAC+"; if (isRed(c1) || isRed(c2)) return "Rote Farben gibt es nur mit Dev-Rang"; return null; };
const rankOk = (d, id) => { const r = item(id) && item(id).rank; return !r || d.dev || (r === "pro" ? d.pro || P(d) : r === "plus" && P(d)); };
const inBundle = (id) => (catalog().bundles || []).some((b) => b.items.includes(id));   // bundle items need their achievement, LAC+ included
const ownsBase = (d, id) => (item(id) && item(id).plus ? !!(P(d) || d.dev) : false) || (!(item(id) && item(id).plus) && (d.dev || d.owned.includes(id) || (P(d) && !inBundle(id)))) || (catalog().bundles || []).some((b) => b.items.includes(id) && (d.advances || []).includes(b.adv));
const owns = (d, id) => { const it = item(id); return it && it.rank ? rankOk(d, id) : ownsBase(d, id); };
const item = (id) => catalog().items.find((i) => i.id === id);

const GRANTED = {};   // dashless uuid -> the rank a Dev gave ("dev", "plus", "pro", "creator", "free"), from the sync service's role list
const FLAGS = ["dev", "plus", "pro", "creator"], plainId = (u) => String(u || "").replace(/-/g, "").toLowerCase();
const applyGranted = (d, uuid) => { const g = GRANTED[plainId(uuid)], before = {}; for (const k of FLAGS) before[k] = !!d[k]; if (FLAGS.includes(g)) d[g] = true; return before; };
/** run fn on a user's record, then save. Returns fn's result (null = ok, string = error shown in the UI). */
function edit(uuid, fn) {
  const f = read();
  const d = (f.users[uuid] ||= blank());
  const before = applyGranted(d, uuid), applied = {}; for (const k of FLAGS) applied[k] = !!d[k];   // fn sees the granted rank ...
  const err = fn(d);
  for (const k of FLAGS) if (!!d[k] === applied[k]) d[k] = before[k];   // ... but only what fn itself changed is saved
  if (!err) write(f);
  return err || null;
}

module.exports = {
  file, catalog,
  /** this PC's secret for the sync service; the game keeps it in the same store, so launcher and game are the same device */
  syncKey(uuid) { edit(uuid, (d) => { if (!d.syncKey || d.syncKey.length < 32) d.syncKey = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, ""); }); return read().users[uuid].syncKey; },
  devCode(uuid) { const d = read().users[uuid]; return d && d.dev ? d.devCode || "" : ""; },
  setGranted(map) { for (const k of Object.keys(GRANTED)) delete GRANTED[k]; for (const [id, v] of Object.entries(map || {})) GRANTED[plainId(id)] = v && v.rank; },
  grantedOf(uuid) { return GRANTED[plainId(uuid)] || ""; },
  me(uuid) { const f = read(), m = Object.assign(blank(), f.users[uuid] || {}); applyGranted(m, uuid); m.creator = !!m.creator; m.plus = !!(m.plus || m.creator || (m.giftUntil || 0) > Date.now()); return m; },   // for the screens a Creator counts as LAC+
  /** the chat colours a rank may use (the sync service checks it again): Free and Pro a short list, Plus and Creator a long one without red, Dev also the reds */
  chatPalette(uuid) {
    const d = this.me(uuid), l = ["#ffffff", "#aaaaaa", "#55ffff", "#55ff55"], paid = d.dev || d.plus || d.pro;   // me(): a Creator counts as plus
    if (paid) l.push("#ffff55", "#ff55ff", "#5555ff", "#ffaa00");
    if (d.dev || d.plus) l.push("#00d4ff", "#7c5cff", "#4dff88", "#ffd24a", "#c04dff", "#ff8ad8", "#8affd2", "#b9a2ff");
    if (d.dev) l.push("#ff4d6d", "#ff5555", "#ff0000");
    return l;
  },
  setChatColor(uuid, hex) { const pal = this.chatPalette(uuid); return edit(uuid, (d) => { if (hex && !pal.includes(hex)) return "Diese Farbe gibt es mit deinem Rang nicht"; d.chatColor = hex || ""; }); },
  /** a rank the sync service confirmed for a one-time code (it keeps the rank for good, there is no code to show again) */
  grantRank(uuid, rank) { return edit(uuid, (d) => { if (rank === "pro") d.pro = true; else if (rank === "plus") d.plus = true; else if (rank === "creator") d.creator = true; }); },
  /** a gift code from a Creator (see the game's LacStore.giftCode): 7 days of LAC+, kept only in this file */
  redeemGift(uuid, code) {
    const plain = (u) => String(u || "").replace(/-/g, "").toLowerCase();
    let p; try { p = Buffer.from(String(code).trim().slice(5), "base64url").toString("utf8").split("|"); } catch { return "Ungültiges Geschenk"; }
    if (p.length !== 3 || p[1] !== plain(uuid)) return "Dieses Geschenk ist für jemand anderen";
    if (p[0] === p[1]) return "Ungültiges Geschenk";
    return edit(uuid, (d) => { d.giftUsed ||= []; if (d.giftUsed.includes(p[2])) return "Dieses Geschenk wurde schon eingelöst"; d.giftUsed.push(p[2]); d.giftUntil = Math.max(d.giftUntil || 0, Date.now()) + 7 * 24 * 3600 * 1000; });
  },
  redeem(uuid, code) {
    if (/^GIFT-/i.test(String(code).trim())) return this.redeemGift(uuid, "GIFT-" + String(code).trim().slice(5));
    const h = crypto.createHash("sha256").update("lac-code:" + code).digest("hex");
    if (h === DEV_HASH) return edit(uuid, (d) => { if (d.dev) return "Dev-Rang ist schon aktiv"; d.dev = true; d.devCode = String(code); });
    if (h === PRO_HASH) return edit(uuid, (d) => { if (d.pro) return "LAC Pro ist schon aktiv"; d.pro = true; });
    if (h !== CODE_HASH) return "Ungültiger Code";
    return edit(uuid, (d) => { if (d.plus) return "LAC+ ist schon aktiv"; d.plus = true; });
  },
  cancel(uuid) { return edit(uuid, (d) => { d.plus = false; if (!d.pro && !d.creator) { d.tag = blank().tag; d.name = blank().name; } d.equipped = d.equipped.filter((e) => owns(d, e)); }); },
  /** the single downgrade, same as in the game: every paid rank ends */
  toFree(uuid) { return edit(uuid, (d) => { d.plus = false; d.creator = false; d.pro = false; d.dev = false; d.devCode = ""; d.tag = blank().tag; d.name = blank().name; d.equipped = d.equipped.filter((e) => owns(d, e)); }); },
  cancelPro(uuid) { return edit(uuid, (d) => { d.pro = false; if (!P(d)) { d.tag = blank().tag; d.name = blank().name; } }); },
  buy(uuid, id) {
    const it = item(id);
    return edit(uuid, (d) => {
      if (!it) return "Unbekannt"; if (owns(d, id)) return "Schon freigeschaltet"; if (it.plus) return "Nur mit LAC+"; if (d.coins < it.price) return "Zu wenig Coins";
      d.coins -= it.price; d.owned.push(id);
    });
  },
  equip(uuid, id, chroma = 0) {
    const it = item(id);
    return edit(uuid, (d) => {
      if (!it) return "Unbekannt"; if (!owns(d, id)) return "Gesperrt";
      if (!Number.isInteger(chroma) || chroma < 0 || chroma >= (it.chroma ? catalog().chromas : 1)) return "Ungültige Farbe";
      d.equipped = d.equipped.filter((e) => item(e) && item(e).type !== it.type); d.equipped.push(id); d.chroma[id] = chroma;
    });
  },
  unequip(uuid, type) { return edit(uuid, (d) => { d.equipped = d.equipped.filter((e) => item(e) && item(e).type !== type); }); },
  setName(uuid, color, color2, effects, font) {
    return edit(uuid, (d) => {
      if (!styled(d)) return "Nur mit LAC+ oder LAC Pro";
      { const e = styleCheck(d, color, color2, effects); if (e) return e; }
      if (!validFx(effects, NAME_FX)) return "Ungültig";
      if (!/^#[0-9a-fA-F]{6}$/.test(color) || !/^#[0-9a-fA-F]{6}$/.test(color2) || !NAME_FONTS.includes(font)) return "Ungültig";
      d.name = { color, color2, effect: effects[0] || "solid", font, effects };
    });
  },
  setHaloFollow(uuid, follow) { return edit(uuid, (d) => { d.haloFollow = !!follow; }); },
  setUiFont(uuid, font) { return edit(uuid, (d) => { if (!UI_FONTS.includes(font)) return "Ungültig"; d.uiFont = font; }); },
  setAdjust(uuid, id, scale, x, y, z) {
    const cl = (v) => Math.max(-12, Math.min(12, +v || 0));
    return edit(uuid, (d) => { if (!d.dev) return "Nur mit Dev-Rang (im Spiel)"; if (!item(id)) return "Unbekannt"; d.adjust ||= {}; d.adjust[id] = [Math.max(0.1, Math.min(4, +scale || 1)), cl(x), cl(y), cl(z)]; });
  },
  setTag(uuid, color, color2, effects) {
    return edit(uuid, (d) => {
      if (!styled(d)) return "Nur mit LAC+ oder LAC Pro";
      { const e = styleCheck(d, color, color2, effects); if (e) return e; }
      if (!/^#[0-9a-fA-F]{6}$/.test(color) || !/^#[0-9a-fA-F]{6}$/.test(color2) || !validFx(effects, BADGE_FX)) return "Ungültig";
      d.tag = { color, color2, effect: effects[0] || "solid", effects };
    });
  },
};

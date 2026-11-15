// LAC Modpacks: modpacks that players with the Dev rank publish for everybody. A pack is the profile's share code (mod list and settings,
// see launcher/share.js) plus a name, creator, description, a small icon and a short pack code. Stored in KV (rarely written, so the free tier is plenty).
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_SHARE = 1_500_000, MAX_ICON = 90_000, MAX_PACKS = 200;

const rand = (n) => { const r = crypto.getRandomValues(new Uint8Array(n)); let s = ""; for (const b of r) s += CODE_CHARS[b % CODE_CHARS.length]; return s; };
const clip = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

/** the public summary of a pack (no share code, no icon bytes) */
const summary = (p) => ({ id: p.id, code: p.code, name: p.name, creator: p.creator, desc: p.desc, mc: p.mc, loader: p.loader, mods: p.mods, ts: p.ts, ver: p.ver || 1, icon: !!p.hasIcon });

export async function listPacks(env) { return JSON.parse((await env.LAC.get("packs:index")) || "[]"); }

export async function getPack(env, idOrCode) {
  const key = String(idOrCode).toUpperCase();
  const id = (await env.LAC.get("pkc:" + key)) || String(idOrCode);
  const raw = /^[A-Za-z0-9]{4,12}$/.test(id) ? await env.LAC.get("pk:" + id) : null;
  return raw ? JSON.parse(raw) : null;
}

export async function getIcon(env, id) { return /^[A-Za-z0-9]{4,12}$/.test(id) ? env.LAC.get("pki:" + id) : null; }

/** @param b {code, id?, pack:{name, creator, desc, mc, loader, mods, share, icon}}  @param isDev (code was checked by the caller) */
export async function publish(env, b) {
  const p = b.pack || {};
  const name = clip(p.name, 40), creator = clip(p.creator, 24);
  if (!name || !creator) return { status: 400, error: "Name und Ersteller fehlen" };
  if (typeof p.share !== "string" || !/^LACP1:[A-Za-z0-9_\-]+$/.test(p.share) || p.share.length > MAX_SHARE) return { status: 400, error: "Modpack-Code ungültig oder zu groß" };
  let icon = typeof p.icon === "string" && /^[A-Za-z0-9+/=]+$/.test(p.icon) && p.icon.length <= MAX_ICON ? p.icon : "";
  const index = await listPacks(env);
  let existing = b.id ? await getPack(env, b.id) : null;
  if (existing && existing.id !== b.id) existing = null;
  if (!existing && index.length >= MAX_PACKS) return { status: 400, error: "Zu viele Modpacks" };
  let id = existing ? existing.id : rand(6), code = existing ? existing.code : "LP-" + rand(5);
  const ver = existing ? (existing.ver || 1) + 1 : 1;   // every publish of the same pack is a new version: players who have it see the update
  const pack = { id, code, name, ver, creator, desc: clip(p.desc, 300), mc: clip(p.mc, 12), loader: clip(p.loader, 10), mods: Math.max(0, Math.min(999, Number(p.mods) || 0)), ts: Date.now(), hasIcon: !!icon || (existing && existing.hasIcon && !p.icon), share: p.share };
  await env.LAC.put("pk:" + id, JSON.stringify(pack));
  await env.LAC.put("pkc:" + code, id);
  if (icon) await env.LAC.put("pki:" + id, icon);
  const next = index.filter((x) => x.id !== id); next.unshift(summary(pack));
  await env.LAC.put("packs:index", JSON.stringify(next));
  return { status: 200, ok: true, id, code };
}

export async function removePack(env, id) {
  const p = await getPack(env, id); if (!p) return { status: 404, error: "Nicht gefunden" };
  await env.LAC.delete("pk:" + p.id); await env.LAC.delete("pkc:" + p.code); await env.LAC.delete("pki:" + p.id);
  await env.LAC.put("packs:index", JSON.stringify((await listPacks(env)).filter((x) => x.id !== p.id)));
  return { status: 200, ok: true };
}

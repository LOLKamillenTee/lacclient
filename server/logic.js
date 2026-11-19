// Validation for the public LAC profile: what other players are allowed to see. Pure functions, no I/O (tested by test.js).
export const NAME_FX = ["shaking", "waving", "iterating", "flipping", "skewing", "growing", "gradient", "rainbow", "metallic", "fade", "shimmer", "blinking", "chromatic", "fire", "outline", "glowing", "aurora", "sweep", "breathe", "neon", "sunset", "ocean", "galaxy", "toxic", "sparkle", "heartbeat", "bouncing"];
export const BADGE_FX = ["shaking", "waving", "flipping", "gradient", "rainbow", "metallic", "fade", "shimmer", "blinking", "chromatic", "fire", "glowing", "aurora", "sweep", "breathe", "neon", "sunset", "ocean", "galaxy", "toxic", "sparkle", "heartbeat", "bouncing"];
const EXCL = [["gradient", "rainbow", "metallic", "chromatic", "fire", "aurora"], ["shaking", "waving", "flipping", "iterating"], ["skewing", "growing"], ["fade", "blinking", "glowing", "breathe"], ["glowing", "outline", "neon"]];
const HEX = /^#[0-9a-fA-F]{6}$/;

const validFx = (fx, allowed) => Array.isArray(fx) && fx.length <= 5 && new Set(fx).size === fx.length && fx.every((e) => allowed.includes(e))
  && !fx.some((a, i) => fx.some((b, j) => j > i && EXCL.some((g) => g.includes(a) && g.includes(b))));

const style = (s, allowed) => (s && HEX.test(s.color) && HEX.test(s.color2) && validFx(s.effects || [], allowed) ? { color: s.color, color2: s.color2, effects: s.effects || [] } : null);

/**
 * @param raw     the profile as uploaded by a client
 * @param items   [{id, type}] from the catalog: only known cosmetics, one per slot
 * @returns the cleaned profile, or null if it is unusable
 */
export function sanitize(raw, items) {
  if (!raw || typeof raw !== "object") return null;
  const types = new Map(items.map((i) => [i.id, i.type])), seen = new Set(), equipped = [], chroma = {};
  for (const id of Array.isArray(raw.equipped) ? raw.equipped.slice(0, 16) : []) {
    const type = types.get(id);
    if (!type || seen.has(type)) continue;
    seen.add(type); equipped.push(id);
    const c = raw.chroma && raw.chroma[id];
    if (Number.isInteger(c) && c >= 0 && c <= 5) chroma[id] = c;
  }
  const tag = style(raw.tag, BADGE_FX), name = style(raw.name, NAME_FX);
  const chat = typeof raw.chat === "string" && HEX.test(raw.chat) ? raw.chat.toLowerCase() : "";
  return { v: 1, rank: "free", chat, styled: !!raw.styled && !!tag && !!name, equipped, chroma, tag: tag || { color: "#ffffff", color2: "#ffffff", effects: [] }, name: name || { color: "#ffffff", color2: "#ffffff", effects: [] } };
}

export const dashless = (u) => String(u || "").replace(/-/g, "").toLowerCase();
export const validUuid = (u) => /^[0-9a-f]{32}$/.test(dashless(u));

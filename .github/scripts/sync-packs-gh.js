// Mirrors the LAC modpack registry (sync service) into packs/ of this repository, so the launcher can load the modpacks from GitHub when the service is down or at its daily limit.
// Runs in GitHub Actions (.github/workflows/sync-packs.yml, a copy of this file lives in .github/scripts/) and by hand: node tools/sync-packs-gh.js [folder]
// When the service cannot be reached nothing is touched: the old mirror stays.
const fs = require("fs"), path = require("path");
const BASE = process.env.SYNC_URL || "https://lac-sync.lacclient.workers.dev", OUT = path.resolve(process.argv[2] || "packs");
const get = async (u, bin) => { const r = await fetch(BASE + u, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(u + " -> " + r.status); return bin ? Buffer.from(await r.arrayBuffer()) : r.json(); };
(async () => {
  let index; try { index = (await get("/v1/packs")).packs; if (!Array.isArray(index)) throw new Error("no list"); } catch (e) { console.log("service not reachable, mirror unchanged:", e.message); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const keep = new Set(["index.json", "roles.json", "defaults.json"]);
  for (const [file, url] of [["roles.json", "/v1/roles"], ["defaults.json", "/v1/defaults"]]) { try { fs.writeFileSync(path.join(OUT, file), JSON.stringify(await get(url))); } catch (e) { console.log(file, "not updated:", e.message); } }   // the game reads these from here, not from the service
  for (const p of index) {
    const f = path.join(OUT, p.id + ".json"); keep.add(p.id + ".json");
    let have = null; try { have = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* new */ }
    if (!have || (have.ver || 1) !== (p.ver || 1)) { fs.writeFileSync(f, JSON.stringify(await get("/v1/packs/" + p.id))); console.log("pack", p.id, p.name, "v" + (p.ver || 1)); }
    if (p.icon) { keep.add(p.id + ".png"); if (!have || (have.ver || 1) !== (p.ver || 1) || !fs.existsSync(path.join(OUT, p.id + ".png"))) { try { fs.writeFileSync(path.join(OUT, p.id + ".png"), await get(`/v1/packs/${p.id}/icon`, true)); } catch { /* no picture */ } } }
  }
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ packs: index }));
  for (const n of fs.readdirSync(OUT)) if (!keep.has(n)) { fs.rmSync(path.join(OUT, n)); console.log("removed", n); }
})().catch((e) => { console.error(e); process.exit(1); });

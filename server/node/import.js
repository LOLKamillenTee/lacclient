// node import.js dump.json [lac.db]   : loads what tools/export-from-cloudflare.js saved into the SQLite file (run once, with the service stopped)
import fs from "node:fs";
import Database from "better-sqlite3";
const dump = JSON.parse(fs.readFileSync(process.argv[2], "utf8")), db = new Database(process.argv[3] || "./lac.db");
db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER); CREATE TABLE IF NOT EXISTS st (k TEXT PRIMARY KEY, v TEXT NOT NULL);");
const kv = db.prepare("INSERT INTO kv (k, v, exp) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp"), st = db.prepare("INSERT INTO st (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
let a = 0, b = 0;
db.transaction(() => {
  for (const it of dump.kv || []) { kv.run(it.k, it.v, it.exp || null); a++; }
  for (const part of ["live", "main"]) for (const [k, v] of (dump[part] && dump[part].items) || []) { st.run(k, JSON.stringify(v)); b++; }
})();
console.log("kv rows:", a, "storage rows:", b);

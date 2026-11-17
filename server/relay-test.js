// End-to-end check of the relay against `wrangler dev --local --port 8799` (k:<uuid> seeded with sha256(key)):
// a fake world (echo server) + host side + guest side, the same protocol as LacRelay.java. node relay-test.js
import net from "node:net";
const BASE = process.env.BASE || `ws://127.0.0.1:${process.env.PORT || 8799}/v1/relay`, room = "r".repeat(32);
const headers = { "x-lac-uuid": "0123456789abcdef0123456789abcdef", "x-lac-key": "ab".repeat(32) };
const open = (q, h = headers) => new Promise((res, rej) => { const w = new WebSocket(`${BASE}?room=${room}&${q}`, { headers: h }); w.binaryType = "arraybuffer"; w.onopen = () => res(w); w.onerror = (e) => rej(new Error("ws error " + q)); });
const fail = (m) => { console.log("FAIL", m); process.exit(1); };
setTimeout(() => fail("timeout"), 20000);

// a fake world: echoes upper-case
const world = net.createServer((s) => s.on("data", (d) => s.write(d.toString().toUpperCase()))).listen(0, "127.0.0.1");
await new Promise((r) => world.once("listening", r));
const wport = world.address().port;

// bad key is refused
try { await open("role=host", { ...headers, "x-lac-key": "cd".repeat(32) }); fail("wrong key accepted"); } catch { console.log("ok: wrong key refused"); }

// host
const host = await open("role=host");
host.onmessage = async (e) => {
  const id = JSON.parse(e.data).conn, tcp = net.connect(wport, "127.0.0.1"), data = await open(`role=data&conn=${id}`);
  data.onmessage = (m) => tcp.write(Buffer.from(m.data)); tcp.on("data", (d) => data.send(d)); tcp.on("close", () => data.close());
};

// two guests at the same time
const guest = async (txt) => {
  const g = await open("role=guest"); g.send(Buffer.from(txt));   // sent before the host has opened its data socket: buffered
  return new Promise((res) => (g.onmessage = (m) => res(Buffer.from(m.data).toString())));
};
const [a, b] = await Promise.all([guest("hello"), guest("lac")]);
if (a !== "HELLO" || b !== "LAC") fail(`echo ${a} ${b}`);
console.log("ok: two guests through the relay:", a, b);
process.exit(0);

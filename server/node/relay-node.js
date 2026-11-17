// The relay rooms of relay.js for the Node server (same protocol, plain `ws` sockets): host control socket, guest sockets, data sockets; nothing is stored.
import { WebSocketServer } from "ws";

const rooms = new Map();   // room name -> { host, guests, data, buf, n }
const room = (name) => { let r = rooms.get(name); if (!r) rooms.set(name, (r = { host: null, guests: new Map(), data: new Map(), buf: new Map(), n: 0 })); return r; };
const quiet = (f) => { try { f(); } catch { /* socket already gone */ } };

/** upgrade requests for /v1/relay: the Worker route decides (room name, profile id + key, Founder rank for hosts; it answers 426 to a request that is fine but is not a WebSocket), then the same pairing as relay.js */
export function attachRelay(server, worker, env) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/v1/relay") { socket.destroy(); return; }
    const name = url.searchParams.get("room") || "", h = new Headers(); for (const k of ["x-lac-uuid", "x-lac-key"]) if (typeof req.headers[k] === "string") h.set(k, req.headers[k]);
    const ok = await worker.fetch(new Request("http://x" + req.url, { headers: h }), env);
    if (ok.status !== 426) { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => pair(room(name), name, url.searchParams.get("role"), Number(url.searchParams.get("conn")), ws));
  });
}

function pair(r, name, role, connId, ws) {
  const send = (to, data, isBinary) => quiet(() => to.send(data, { binary: isBinary }));
  if (role === "host") {
    if (r.host) quiet(() => r.host.close(1000, "ersetzt"));
    r.host = ws;
    ws.on("close", () => { if (r.host === ws) { r.host = null; for (const g of r.guests.values()) quiet(() => g.close(1001, "Host weg")); } });
    ws.on("error", () => {});
  } else if (role === "guest") {
    if (!r.host) { ws.close(1013, "Host offline"); return; }
    const id = ++r.n; r.guests.set(id, ws); r.buf.set(id, []);
    try { r.host.send(JSON.stringify({ conn: id })); } catch { ws.close(1011, "Host nicht erreichbar"); return; }
    setTimeout(() => { if (!r.data.has(id) && r.guests.has(id)) quiet(() => ws.close(1011, "Host antwortet nicht")); }, 10000);
    ws.on("message", (d, bin) => { const t = r.data.get(id); if (t) send(t, d, bin); else { const b = r.buf.get(id); if (b && b.length < 2000) b.push([d, bin]); } });
    const end = () => { r.guests.delete(id); r.buf.delete(id); const t = r.data.get(id); r.data.delete(id); if (t) quiet(() => t.close(1000, "Gast weg")); if (!r.host && !r.guests.size) rooms.delete(name); };
    ws.on("close", end); ws.on("error", end);
  } else if (role === "data") {
    const g = r.guests.get(connId);
    if (!g) { ws.close(1008, "Verbindung unbekannt"); return; }
    r.data.set(connId, ws);
    for (const [d, bin] of r.buf.get(connId) || []) send(ws, d, bin);
    r.buf.set(connId, []);
    ws.on("message", (d, bin) => send(g, d, bin));
    const end = () => { r.data.delete(connId); quiet(() => g.close(1000, "Host hat geschlossen")); };
    ws.on("close", end); ws.on("error", end);
  } else ws.close(1008, "Rolle");
}

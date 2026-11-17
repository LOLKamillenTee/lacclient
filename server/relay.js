// A relay room for hosted worlds: the host's PC and its guests all connect OUT to this service, so nobody has to open a port on a router.
// The host keeps one control socket per room. Every Minecraft connection of a guest is one "guest" socket; the service tells the host ("conn": id), the host opens one "data" socket for that
// connection, and from then on the bytes are passed on untouched in both directions. The room name is the secret (a friend only gets it after the host accepted him), and the white list of the
// world decides who may play. Nothing is stored: a room lives as long as its sockets.
export class Relay {
  constructor() { this.host = null; this.guests = new Map(); this.data = new Map(); this.buf = new Map(); this.n = 0; }

  async fetch(req) {
    if (req.headers.get("upgrade") !== "websocket") return new Response("WebSocket nötig", { status: 426 });
    const url = new URL(req.url), role = url.searchParams.get("role");
    const { 0: client, 1: server } = new WebSocketPair(); server.accept();
    const ok = new Response(null, { status: 101, webSocket: client });

    if (role === "host") {
      if (this.host) { try { this.host.close(1000, "ersetzt"); } catch { /* gone */ } }
      this.host = server;
      server.addEventListener("close", () => { if (this.host === server) { this.host = null; for (const g of this.guests.values()) { try { g.close(1001, "Host weg"); } catch { /* gone */ } } } });
      return ok;
    }
    if (role === "guest") {
      if (!this.host) { server.close(1013, "Host offline"); return ok; }
      const id = ++this.n; this.guests.set(id, server); this.buf.set(id, []);
      try { this.host.send(JSON.stringify({ conn: id })); } catch { server.close(1011, "Host nicht erreichbar"); return ok; }
      setTimeout(() => { if (!this.data.has(id) && this.guests.has(id)) { try { server.close(1011, "Host antwortet nicht"); } catch { /* gone */ } } }, 10000);
      server.addEventListener("message", (e) => { const d = this.data.get(id); if (d) { try { d.send(e.data); } catch { /* closing */ } } else { const b = this.buf.get(id); if (b && b.length < 2000) b.push(e.data); } });
      const end = () => { this.guests.delete(id); this.buf.delete(id); const d = this.data.get(id); this.data.delete(id); if (d) { try { d.close(1000, "Gast weg"); } catch { /* gone */ } } };
      server.addEventListener("close", end); server.addEventListener("error", end);
      return ok;
    }
    if (role === "data") {
      const id = Number(url.searchParams.get("conn")), g = this.guests.get(id);
      if (!g) { server.close(1008, "Verbindung unbekannt"); return ok; }
      this.data.set(id, server);
      for (const m of this.buf.get(id) || []) server.send(m);
      this.buf.set(id, []);
      server.addEventListener("message", (e) => { try { g.send(e.data); } catch { /* closing */ } });
      const end = () => { this.data.delete(id); try { g.close(1000, "Host hat geschlossen"); } catch { /* gone */ } };
      server.addEventListener("close", end); server.addEventListener("error", end);
      return ok;
    }
    server.close(1008, "Rolle"); return ok;
  }
}

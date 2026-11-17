// node hub-test.js : friends logic with an in-memory store
import assert from "node:assert/strict";
import { Hub } from "./hub.js";

const mem = () => { const m = new Map(); return { get: async (k) => m.get(k), put: async (k, v) => void m.set(k, JSON.parse(JSON.stringify(v))), m }; };
let clock = 1_000_000; const store = mem(), kv = mem(), hub = new Hub(store, kv, () => clock);
const A = "a".repeat(32), B = "b".repeat(32), KA = "1".repeat(40), KB = "2".repeat(40);
const call = (uuid, key, extra = {}) => hub.sync({ uuid, key, name: uuid === A ? "Alice" : "Bob", ...extra });

let a = await call(A, KA, { presence: { status: "online", server: "Survival", addr: "play.example.com:25565" } });
let b = await call(B, KB, { presence: { status: "online", server: "Lobby", addr: "other.example.com" } });
assert.equal(a.status, 200); assert.equal(a.code.length, 8);
assert.equal((await call(A, KB)).status, 403, "wrong key is refused");

let r = await call(B, KB, { ops: [{ op: "add", code: a.code }] });
assert.equal(r.results[0].ok, true); assert.equal(r.friends.length, 1);
assert.equal((await call(B, KB, { ops: [{ op: "add", code: a.code }] })).results[0].error, "Ihr seid schon befreundet");
assert.equal((await call(B, KB, { ops: [{ op: "add", code: b.code }] })).results[0].error, "Das ist dein eigener Code");
assert.equal((await call(B, KB, { ops: [{ op: "add", code: "ZZZZZZZZ" }] })).results[0].error, "Code nicht gefunden");

a = await call(A, KA, { presence: { status: "online", server: "Survival", addr: "play.example.com:25565" } });
assert.equal(a.friends[0].name, "Bob"); assert.equal(a.friends[0].server, "Lobby");
assert.ok(!JSON.stringify(a.friends).includes("example.com"), "the address is never part of a friend's presence");

// chat
await call(A, KA, { ops: [{ op: "msg", to: B, text: "hi bob" }] });
b = await call(B, KB, { presence: { status: "online", server: "Lobby", addr: "other.example.com" } });
const msg = b.events.find((e) => e.type === "msg"); assert.equal(msg.text, "hi bob");
b = await call(B, KB, { ack: [msg.id] }); assert.ok(!b.events.some((e) => e.id === msg.id), "acked events are gone");
assert.equal((await call(A, KA, { ops: [{ op: "msg", to: "c".repeat(32), text: "x" }] })).results[0].error, "Kein Freund");

// join request -> accept hands out the address, but only after the request
assert.equal((await call(B, KB, { ops: [{ op: "join_ok", to: A }] })).results[0].error, "Anfrage abgelaufen");
await call(B, KB, { presence: { status: "online", server: "Lobby", addr: "other.example.com" }, ops: [{ op: "join_req", to: A }] });
a = await call(A, KA, { presence: { status: "online", server: "Survival", addr: "play.example.com:25565" } });
assert.ok(a.events.some((e) => e.type === "join_req" && e.name === "Bob" && !e.addr));
await call(A, KA, { ops: [{ op: "join_ok", to: B }] });
b = await call(B, KB, {});
const ok = b.events.find((e) => e.type === "join_ok"); assert.equal(ok.addr, "play.example.com:25565");
clock += 11 * 60_000; await call(B, KB, { presence: { status: "online", server: "Lobby", addr: "other.example.com" }, ops: [{ op: "join_req", to: A }] });
clock += 11 * 60_000; await call(A, KA, { presence: { status: "online", server: "Survival", addr: "x.example.com" } });
assert.equal((await call(A, KA, { ops: [{ op: "join_ok", to: B }] })).results[0].error, "Anfrage abgelaufen");

// invite, status
await call(A, KA, { presence: { status: "online", server: "Survival", addr: "play.example.com" }, ops: [{ op: "invite", to: B }] });
b = await call(B, KB, { presence: { status: "afk", server: "Lobby", addr: "o.example.com" } });
assert.ok(b.events.some((e) => e.type === "invite" && e.addr === "play.example.com"));
a = await call(A, KA, { presence: { status: "online", server: "Survival", addr: "play.example.com" } });
assert.equal(a.friends[0].status, "afk");
await call(B, KB, { presence: { status: "offline", server: "", addr: "" } });
assert.equal((await call(A, KA, {})).friends[0].status, "offline");
clock += 60_000; assert.equal((await call(A, KA, {})).friends[0].status, "offline", "no heartbeat counts as offline");

// stats reach friends (numbers only)
await call(A, KA, { presence: { status: "online", server: "S", addr: "x.example.com", stats: { lvl: 5, minutes: 120, walked: 4500, junk: 9, mined: -1 } } });
const st = (await call(B, KB, {})).friends[0].stats;
assert.equal(st.lvl, 5); assert.equal(st.walked, 4500); assert.ok(!("junk" in st) && !("mined" in st), "only known, non-negative numbers");

await call(A, KA, { ops: [{ op: "remove", uuid: B }] });
assert.equal((await call(B, KB, {})).friends.length, 0);
console.log("hub tests ok");

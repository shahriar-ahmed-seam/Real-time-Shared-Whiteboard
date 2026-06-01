// Ad-hoc end-to-end smoke test against the running server.
// Two clients join the same room; one draws, the other should receive the
// broadcast in order; a late joiner should get the full history; a resync
// from a sinceSeq should return only the delta.
import { io } from "socket.io-client";

const URL = "http://localhost:3001";
const ROOM = "demo-" + Math.random().toString(36).slice(2, 8);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name) {
  const s = io(URL, { transports: ["websocket"], forceNew: true, reconnection: false });
  return new Promise((res, rej) => {
    s.on("connect", () => res(s));
    s.on("connect_error", rej);
    setTimeout(() => rej(new Error(name + " connect timeout")), 5000);
  });
}

function joinRoom(sock, username) {
  return new Promise((res) => {
    sock.once("room-history", (h) => res(h));
    sock.emit("join-room", { roomId: ROOM, username, sinceSeq: 0 });
  });
}

const log = (...a) => console.log("[demo]", ...a);

const alice = await connect("alice");
const bob = await connect("bob");
log("both clients connected; room =", ROOM);

const received = [];
bob.on("draw", (s) => received.push(s.seq));

const aliceHist = await joinRoom(alice, "Alice");
const bobHist = await joinRoom(bob, "Bob");
log("alice join history strokes:", aliceHist.strokes.length, "| bob join history strokes:", bobHist.strokes.length);

// Alice draws 5 strokes.
for (let i = 0; i < 5; i++) {
  alice.emit("draw", {
    roomId: ROOM,
    stroke: { x0: i, y0: i, x1: i + 1, y1: i + 1, color: "#3b82f6", width: 4 },
  });
  await wait(40);
}
await wait(500);
log("bob received broadcast seqs:", JSON.stringify(received));

// A late joiner (Carol) should get full history.
const carol = await connect("carol");
const carolHist = await joinRoom(carol, "Carol");
log("carol late-join history seqs:", JSON.stringify(carolHist.strokes.map((s) => s.seq)));

// Resync from seq 3 should return only strokes 4,5.
const delta = await new Promise((res) => {
  carol.once("room-history", (h) => res(h));
  carol.emit("request-resync", { roomId: ROOM, sinceSeq: 3 });
});
log("carol resync(sinceSeq=3) delta seqs:", JSON.stringify(delta.strokes.map((s) => s.seq)));

// Presence: who's in the room.
const presence = await new Promise((res) => {
  carol.once("users-update", (u) => res(u));
  // trigger a presence broadcast by having bob re-join briefly is overkill;
  // instead just wait for any pending users-update, else time out with last known.
  setTimeout(() => res(null), 800);
});
if (presence) log("presence members:", presence.map((u) => u.username + "/" + u.cursorColor).join(", "));

alice.disconnect();
bob.disconnect();
carol.disconnect();
log("done");
process.exit(0);

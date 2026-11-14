import net from "node:net";
import crypto from "node:crypto";

const key = crypto.randomBytes(16).toString("base64");
const sock = net.connect(8080, "localhost", () => {
  sock.write(
    "GET / HTTP/1.1\r\nHost: localhost:8080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n"
  );
});

let handshook = false;
let buf = Buffer.alloc(0);

function sendText(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  sock.write(Buffer.concat([header, mask, masked]));
}

function decode() {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  let len = buf[1] & 0x7f; let off = 2;
  if (len === 126) { len = buf.readUInt16BE(off); off += 2; }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(off)); off += 8; }
  if (buf.length < off + len) return null;
  const payload = buf.slice(off, off + len);
  buf = buf.slice(off + len);
  return { opcode, payload: payload.toString() };
}

let joined = false;
sock.on("data", (d) => {
  if (!handshook) {
    const s = d.toString();
    const idx = s.indexOf("\r\n\r\n");
    if (s.startsWith("HTTP/1.1 101")) {
      handshook = true;
      const rest = d.slice(Buffer.byteLength(s.slice(0, idx + 4)));
      buf = Buffer.concat([buf, rest]);
      sendText({ t: "hello", name: "Bot" });
    }
  } else {
    buf = Buffer.concat([buf, d]);
  }
  for (;;) {
    const f = decode();
    if (!f) break;
    if (f.opcode === 0x8) { console.log("server closed"); process.exit(0); }
    let m; try { m = JSON.parse(f.payload); } catch { continue; }
    if (m.t === "hello_ok") sendText({ t: "join", code: "2WTNB" });
    else if (m.t === "room" && !joined) {
      joined = true;
      sendText({ t: "choose", charIndex: 3 });
      console.log("BOT joined:", m.players.map((p) => p.name + ":" + p.charIndex).join(","));
    } else if (m.t === "world") {
      console.log("BOT world -> pendulums:", m.world.pendulums.length, "birds:", m.world.birds.length);
    }
  }
});
sock.on("error", (e) => console.log("sock error", e.message));
setInterval(() => {}, 1000);

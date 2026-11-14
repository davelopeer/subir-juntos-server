/* ============================================================
   index.js — Servidor do jogo Grudados.
   HTTP (health check para keep-alive) + WebSocket (ws).
   Gerencia conexões, salas e o loop de simulação global.
   ============================================================ */

import http from "node:http";
import { WebSocketServer } from "ws";
import { initDb, reserveCode, releaseCode, usingDatabase } from "./db.js";
import { Room, MAX_PLAYERS } from "./room.js";

const PORT = process.env.PORT || 8080;

// Taxa de simulação (física) e de rede (broadcast).
const SIM_HZ = 60; // física igual ao jogo original
const NET_EVERY = 2; // envia estado a cada 2 ticks → ~30 Hz

// code -> Room
const rooms = new Map();
// cada socket ganha metadados em ws.meta = { id, name, roomCode }
let nextId = 1;

function roomExists(code) {
  return rooms.has(code);
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastRoom(code, obj) {
  const str = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    if (c.readyState === c.OPEN && c.meta && c.meta.roomCode === code) {
      c.send(str);
    }
  });
}

function sendRoomLobby(code) {
  const room = rooms.get(code);
  if (room) broadcastRoom(code, room.lobbyInfo());
}

async function destroyRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  rooms.delete(code);
  await releaseCode(code); // garante que o código some do registro
}

// --- Servidor HTTP: health check + CORS simples -------------------
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        rooms: rooms.size,
        db: usingDatabase() ? "postgres" : "memory",
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.meta = { id: "p" + nextId++, name: null, roomCode: null };
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  send(ws, { t: "welcome", id: ws.meta.id });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    handleMessage(ws, msg).catch((err) => {
      console.error("[ws] erro ao tratar mensagem:", err.message);
      send(ws, { t: "error", msg: "Erro interno no servidor." });
    });
  });

  ws.on("close", () => handleLeave(ws));
});

async function handleMessage(ws, msg) {
  const meta = ws.meta;
  switch (msg.t) {
    case "hello":
      meta.name = String(msg.name || "Jogador").slice(0, 16);
      send(ws, { t: "hello_ok", name: meta.name });
      break;

    case "create": {
      if (!meta.name)
        return send(ws, { t: "error", msg: "Escolha um nome primeiro." });
      if (meta.roomCode) return; // já está numa sala
      const code = await reserveCode(roomExists);
      const seed = Math.floor(Math.random() * 1e9);
      const room = new Room(code, seed, (o) => broadcastRoom(code, o));
      rooms.set(code, room);
      room.addPlayer(meta.id, meta.name);
      meta.roomCode = code;
      send(ws, { t: "created", code });
      sendRoomLobby(code);
      break;
    }

    case "join": {
      if (!meta.name)
        return send(ws, { t: "error", msg: "Escolha um nome primeiro." });
      if (meta.roomCode) return;
      const code = String(msg.code || "")
        .toUpperCase()
        .trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: "error", msg: "Sala não encontrada." });
      if (room.phase !== "lobby")
        return send(ws, { t: "error", msg: "Esse jogo já começou." });
      if (room.isFull)
        return send(ws, {
          t: "error",
          msg: "Sala cheia (máx. " + MAX_PLAYERS + ").",
        });
      room.addPlayer(meta.id, meta.name);
      meta.roomCode = code;
      send(ws, { t: "joined", code });
      sendRoomLobby(code);
      break;
    }

    case "start": {
      const room = rooms.get(meta.roomCode);
      if (!room) return;
      if (!room.canStart(meta.id))
        return send(ws, {
          t: "error",
          msg: "Precisa de 2+ jogadores, todos com personagem escolhido (e você é o host).",
        });
      // O código é descartado do registro ao iniciar o jogo.
      await releaseCode(room.code);
      room.start();
      // envia o mundo para todos desenharem, com o id de cada um.
      wss.clients.forEach((c) => {
        if (
          c.readyState === c.OPEN &&
          c.meta &&
          c.meta.roomCode === room.code
        ) {
          send(c, room.worldInfo(c.meta.id));
        }
      });
      break;
    }

    case "choose": {
      const room = rooms.get(meta.roomCode);
      if (!room) return;
      const res = room.setChar(meta.id, msg.charIndex);
      if (res === "taken")
        return send(ws, {
          t: "error",
          msg: "Esse personagem já foi escolhido por outro jogador.",
        });
      // só rebroadcasta se a escolha realmente mudou algo
      if (res === true) sendRoomLobby(room.code);
      break;
    }

    case "input": {
      const room = rooms.get(meta.roomCode);
      if (room) room.setInput(meta.id, msg);
      break;
    }

    case "restart": {
      const room = rooms.get(meta.roomCode);
      if (!room || room.hostId !== meta.id || room.phase !== "win") return;
      room.start();
      wss.clients.forEach((c) => {
        if (
          c.readyState === c.OPEN &&
          c.meta &&
          c.meta.roomCode === room.code
        ) {
          send(c, room.worldInfo(c.meta.id));
        }
      });
      break;
    }

    case "leave":
      handleLeave(ws);
      break;

    case "ping":
      send(ws, { t: "pong" });
      break;
  }
}

async function handleLeave(ws) {
  const meta = ws.meta;
  if (!meta || !meta.roomCode) return;
  const code = meta.roomCode;
  const room = rooms.get(code);
  meta.roomCode = null;
  if (!room) return;
  room.removePlayer(meta.id);
  if (room.isEmpty) {
    await destroyRoom(code);
  } else {
    sendRoomLobby(code); // atualiza lista/host para quem ficou
  }
}

// --- Loop global de simulação -------------------------------------
let simCounter = 0;
setInterval(() => {
  simCounter++;
  for (const [code, room] of rooms) {
    if (room.phase === "playing") {
      room.step();
      if (simCounter % NET_EVERY === 0 || room.phase === "win") {
        broadcastRoom(code, room.snapshot());
      }
      if (room.phase === "win") {
        broadcastRoom(code, { t: "win", time: room.winTime });
      }
    }
  }
}, 1000 / SIM_HZ);

// Ping periódico: derruba conexões mortas (libera salas órfãs).
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

async function main() {
  await initDb();
  server.listen(PORT, () => {
    console.log(`[grudados] servidor ouvindo em :${PORT}`);
  });
}

main();

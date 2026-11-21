# Server Architecture — Grudados

The backend of **Grudados**, a cooperative online platformer. The server is the
**authoritative** game simulation: it owns the physics, holds all rooms in
memory, receives only player inputs over WebSocket, and streams position
snapshots back to every client.

This document covers the technical and architectural specification of the
backend. For the frontend, see [`client/ARCHITECTURE.md`](../client/ARCHITECTURE.md).

---

## 1. Overview

```
        Browser (desktop / mobile)                 Fly.io — region "gru" (São Paulo)
┌──────────────────────────────────────┐      ┌──────────────────────────────┐        ┌──────────────┐
│  client/  (Cloudflare Workers assets) │      │  server/  (Node + ws)        │        │  Neon        │
│  - lobby / canvas / input             │◄──── │  - rooms kept in memory      │        │  Postgres    │
│  - local prediction + interpolation   │ WSS  │  - authoritative physics 60Hz│◄──────►│  room_codes  │
│  - sends inputs only                  │ ───► │  - broadcast snapshots ~30Hz │  SQL   │  (uniqueness)│
└──────────────────────────────────────┘      └──────────────────────────────┘ (TLS)  └──────────────┘
          HTTPS static                              WebSocket (wss) + HTTP /health
```

**Mental model:** real-time state lives in the **process memory** on Fly.io;
**Neon** only stores what must survive restarts/scale — here, the set of active
room codes, to guarantee no two rooms share a code at the same time. Game state
is **never** written to the database.

---

## 2. Technology Stack

| Concern   | Choice                                                    | Notes                                               |
| --------- | --------------------------------------------------------- | --------------------------------------------------- |
| Runtime   | Node.js ≥ 18 (ES modules)                                 | `"type": "module"` in `package.json`                |
| HTTP      | `node:http` (built-in)                                    | Health check + permissive CORS only                 |
| WebSocket | [`ws`](https://github.com/websockets/ws) `^8.18`          | Attached to the HTTP server                         |
| Database  | PostgreSQL via [`pg`](https://node-postgres.com/) `^8.13` | Neon in production; optional                        |
| Container | `node:20-alpine` (Dockerfile)                             | Single-process image                                |
| Hosting   | **Fly.io**, region `gru`                                  | Chosen over Render for a São Paulo region (low RTT) |

Only two runtime dependencies: `ws` and `pg`.

---

## 3. File Layout

```
server/
  src/
    index.js    # HTTP (health) + WebSocket server + global simulation loop
    room.js     # A single room: players, lobby state, authoritative physics
    world.js    # Deterministic map generation (seeded) + hazard position math
    db.js       # Unique room-code registry (Postgres/Neon, or in-memory fallback)
  Dockerfile    # node:20-alpine image, EXPOSE 8080
  fly.toml      # Fly.io app config (region gru, always-on machine, health check)
  package.json  # scripts: start / dev; deps: pg, ws
  .env.example  # DATABASE_URL, PORT template
../migrations/
  001_room_codes.sql   # room_codes table (also auto-created on boot)
```

---

## 4. Process Model (`index.js`)

A single Node process does everything:

1. **HTTP server** (`node:http`) — responds to `/` and `/health` with a small
   JSON status (`{ ok, rooms, db }`) used by Fly's health check and keep-alive
   pings. Sets `Access-Control-Allow-Origin: *`. All other paths return 404.
2. **WebSocket server** (`ws`) — attached to the same HTTP server, so one port
   (default `8080`, overridable via `PORT`) serves both.
3. **Global simulation loop** — a single `setInterval` at **60 Hz** that steps
   every `playing` room's physics and broadcasts snapshots.
4. **Liveness ping** — a separate 30 s `setInterval` that pings every socket and
   terminates dead ones (`isAlive` flag toggled on `pong`), which frees orphaned
   rooms.

### 4.1 Connection & session state

Each socket gets `ws.meta = { id, name, roomCode }`. `id` is a server-assigned
`"p<N>"` sent immediately as a `welcome` frame. There is **no authentication** —
names are arbitrary and nothing about a player persists.

### 4.2 Rooms registry

A module-level `Map<code, Room>` holds live rooms. Helpers broadcast to every
socket whose `meta.roomCode` matches. When a room empties it is deleted and its
code released from the registry.

---

## 5. Simulation Rates

| Rate          | Value         | Purpose                                            |
| ------------- | ------------- | -------------------------------------------------- |
| `SIM_HZ`      | 60 Hz         | Physics step — identical feel to the original game |
| `NET_EVERY`   | every 2 ticks | Snapshot broadcast → effectively **~30 Hz**        |
| Liveness ping | every 30 s    | Detect & terminate dead sockets                    |

Snapshots are sent at ~30 Hz to halve bandwidth; the client interpolates between
them. A `win` transition is broadcast immediately regardless of the cadence.

---

## 6. Authoritative Physics & Rooms (`room.js`)

The `Room` class is the heart of the server. Each room owns its players, its
generated world, a phase, a host, and a tick counter.

### 6.1 Lifecycle / phases

```
lobby  ──start──►  playing  ──door reached──►  win
  ▲                                             │
  └──────────────── restart (host) ◄────────────┘
```

- **lobby** — up to `MAX_PLAYERS` (4) can join; `MIN_PLAYERS_TO_START` (2) are
  required to begin; everyone must have picked a character; only the **host**
  (first player in, auto-promoted if the host leaves) may `start`.
- **playing** — the global loop calls `step()` each tick.
- **win** — set when any player touches the door; records clear time in seconds.

### 6.2 Players & the rope "chain"

Players are stored in an **ordered array**; that order defines the rope chain.
Each consecutive pair is linked by a spring (`ROPE_LEN = 120`, `ROPE_K = 0.06`,
`ROPE_DAMP = 0.12`) that only pulls once stretched beyond the slack. There is
**no player–player collision**, so players can stack behind one another without
pushing — but the rope forces the group to climb together.

### 6.3 Physics step (`step()`), 60 Hz

Ported verbatim from the original single-player game so the feel is identical:

1. Per-player horizontal accel (ground vs air), friction, speed clamp.
2. Edge-triggered jump (only when grounded); gravity with terminal fall speed.
   Constants: `GRAVITY 0.35`, `MOVE_ACCEL 0.9`, `AIR_ACCEL 0.6`,
   `MAX_SPEED 4.3`, `FRICTION 0.78`, `JUMP_VEL -10.7`, `MAX_FALL 12.8`.
3. Rope spring between consecutive players (force + damping).
4. Integrate positions; clamp to world width; resolve **one-way** platform
   collisions (land only when falling onto the top).
5. Apply hazards (pendulums, birds) — see §7.
6. Fall check: if anyone drops below the world, **everyone respawns** together
   (they're roped) at the spawn points.
7. Win check: any player overlapping the door → phase `win`, record time.

### 6.4 Character selection

Each joining player is auto-assigned the first free character. In the lobby they
may change or deselect (`choose`), but **no two players may share a character**
(`MAX_PLAYERS === number of characters`, so there is always one free).

### 6.5 Messages a room produces

- `lobbyInfo()` → `room` frame (code, phase, host, roster with chosen characters).
- `worldInfo(forId)` → `world` frame (full map, roster, "you" id) sent on start.
- `snapshot()` → `state` frame (tick, phase, elapsed, per-player x/y/facing/bob/
  grounded/jumped) — positions rounded to 2 decimals to shrink payloads.

---

## 7. World Generation & Hazards (`world.js`)

The map is **deterministic from a seed** (a `mulberry32` PRNG), so each room
generates it once and ships it to clients to draw. Nothing about the geometry
needs to be re-sent.

- **Units:** `PX_PER_METER = 12`; `WORLD_W = 1280` (matches the client's internal
  world width). The exit door sits around **300 m** — the map grows upward until
  it reaches that altitude.
- **Platforms:** a wide solid ground, then zig-zag platforms that stay within
  jump range, plus a final top platform with the door above it. Decorative trees
  are scattered on top.
- **Hazards (≈150 m → 300 m):**
  - **Pendulums** — an iron weight swings over some platforms; touching it knocks
    the player sideways in the direction the weight is moving.
  - **Birds** — a few cross the screen and wrap around; touching a player knocks
    them aside (and, via the rope, drags neighbors).
- **Determinism of motion:** `pendulumPos(pend, tick)` and `birdX(bird, tick, w)`
  are pure functions of the tick. The **same functions run on the client**, so
  hazards stay in sync with only the `tick` shared in snapshots — their positions
  are never transmitted.
- Knockbacks: `KNOCK_VX = 7` sideways, `KNOCK_VY = -6` upward (lifts off ground).

---

## 8. Room-Code Registry (`db.js`)

The only persistent data is the set of **active room codes**, used to guarantee
uniqueness across restarts/instances.

- **Codes:** up to 5 chars from an alphabet that excludes visually ambiguous
  characters (`I, O, 0, 1`).
- **Storage:**
  - If `DATABASE_URL` is set → PostgreSQL (Neon). SSL is enabled automatically
    when the connection string requires it (`sslmode=require` or a `*.neon.tech`
    host); plain local Postgres runs without SSL. Connection pool capped at 5.
    The `room_codes` table is created on boot (`CREATE TABLE IF NOT EXISTS`).
  - If `DATABASE_URL` is absent → an **in-memory `Set`** fallback, useful for
    local/dev. `usingDatabase()` reports which mode is active (surfaced in
    `/health`).
- **Lifecycle of a code:**
  1. `reserveCode()` on room **creation** — inserts the code (retries on the
     `23505` unique-violation up to 20 times; also avoids colliding with live
     rooms in memory).
  2. `releaseCode()` when the game **starts** (the code can be reused) or when the
     room **empties**.

So a code is only "taken" while a room is in the lobby waiting for players.

---

## 9. Message Protocol

All frames are JSON text with a `t` (type) discriminator.

**Client → server:** `hello`, `create`, `join`, `start`, `choose`, `input`,
`restart`, `leave`, `ping`.

**Server → client:** `welcome`, `hello_ok`, `created`, `joined`, `room`,
`world`, `state`, `win`, `error`, `pong`.

| Type (C→S) | Effect                                                                                  |
| ---------- | --------------------------------------------------------------------------------------- |
| `hello`    | set display name (≤16 chars) → replies `hello_ok`                                       |
| `create`   | reserve a unique code, create room, join as host → `created` + `room`                   |
| `join`     | join an existing lobby by code → `joined` + `room` (errors if full / started / missing) |
| `choose`   | pick/deselect a character (rejected if taken) → rebroadcast `room`                      |
| `start`    | host-only; releases the code, spawns players, sends `world` to all                      |
| `input`    | update the player's `{left,right,jump}` (sent only on change)                           |
| `restart`  | host-only, in `win` phase; re-spawns and re-sends `world`                               |
| `leave`    | remove from room (also triggered on socket close)                                       |
| `ping`     | → `pong` (latency / keep-alive)                                                         |

Malformed JSON or unknown types are ignored; handler errors reply with a generic
`error` frame and are logged server-side.

---

## 10. Deployment

### 10.1 Fly.io (`fly.toml`)

- **App:** `estudio-elemental-subir-presos`, **region `gru`** (São Paulo).
  Rationale: Render has no South-American region (~150–250 ms RTT for Brazilian
  players); `gru` cuts that to tens of ms, which matters for an authoritative
  real-time simulation.
- **Service:** `internal_port = 8080`, `force_https = true`.
- **Always-on:** `auto_stop_machines = false`, `min_machines_running = 1` — a
  real-time game cannot tolerate cold starts. `auto_start_machines = true`.
- **Health check:** `GET /health` every 30 s (5 s timeout, 10 s grace).
- **VM:** `shared-cpu-1x`, 256 MB.

### 10.2 Container (`Dockerfile`)

`node:20-alpine`; installs production deps first for layer caching
(`npm install --omit=dev`), copies `src`, exposes 8080, runs `node src/index.js`.

### 10.3 CI/CD

`.github/workflows/deploy.yml` deploys on every push to `main` via
`flyctl deploy --remote-only`. Requires the repo secret `FLY_API_TOKEN`
(`fly tokens create deploy -a estudio-elemental-subir-presos`). A `concurrency`
group prevents overlapping deploys.

### 10.4 Configuration

| Variable       | Purpose                                      | Default           |
| -------------- | -------------------------------------------- | ----------------- |
| `PORT`         | HTTP/WebSocket listen port                   | `8080`            |
| `DATABASE_URL` | Neon Postgres connection string (codes only) | unset → in-memory |

Set the production database secret with
`fly secrets set DATABASE_URL="postgres://…neon…"`.

---

## 11. Design Trade-offs

- **Authoritative server, inputs-only from clients.** Simple and cheat-resistant.
  The client predicts and reconciles; the server never trusts client positions.
- **State in memory, not in the DB.** Rooms are ephemeral. If the single instance
  restarts, in-progress rooms are lost — acceptable for casual play with friends,
  and it keeps the hot path allocation-free of I/O.
- **Single always-on instance.** Rooms are not shareable across instances (they
  live in one process's memory), so horizontal scaling would require sticky
  routing or shared state — out of scope for the current design.
- **Deterministic world + hazards.** Sending only the seed and tick (not geometry
  or hazard positions every frame) keeps snapshots tiny and perfectly in sync.
- **Postgres only for code uniqueness.** The one fact that must be globally
  consistent is isolated in a trivial table; everything else stays in RAM.

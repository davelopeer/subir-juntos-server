/* ============================================================
   room.js — Uma sala do jogo Grudados.
   Mantém os jogadores e roda a física autoritativa. O servidor é
   a fonte da verdade: recebe apenas inputs (esq/dir/pular) dos
   clientes e devolve as posições. Física portada do jogo original.
   ============================================================ */

import { generateWorld, WORLD_W, pendulumPos, birdX } from "./world.js";

// ---- Física (mesmos valores do jogo original, 60 Hz) ---------------
const GRAVITY = 0.35; // "puxa pra baixo" (reduzida: salto mais lento/flutuante)
const MOVE_ACCEL = 0.9;
const AIR_ACCEL = 0.6;
const MAX_SPEED = 4.3;
const FRICTION = 0.78;
const JUMP_VEL = -10.7; // impulso reduzido p/ manter ~a mesma altura com salto mais lento
const ROPE_LEN = 120; // folga da cordinha (+25%: separa mais os jogadores)
const ROPE_K = 0.06; // rigidez da mola quando esticada
const ROPE_DAMP = 0.12; // amortecimento
const MAX_FALL = 12.8; // queda máxima proporcional ao salto mais lento
const KNOCK_VX = 7; // empurrão horizontal ao tocar um perigo (pêndulo/pássaro)
const KNOCK_VY = -6; // "tranco" para cima ao ser empurrado (tira do chão)

export const MAX_PLAYERS = 4;
export const MIN_PLAYERS_TO_START = 2;

export class Room {
  /**
   * @param {string} code  - código único da sala (até 5 chars)
   * @param {number} seed   - semente do mapa
   * @param {function} broadcast - fn(msgObj) que envia a todos da sala
   */
  constructor(code, seed, broadcast) {
    this.code = code;
    this.seed = seed;
    this.broadcast = broadcast;
    this.world = generateWorld(seed);
    this.players = []; // ordem define a corrente da corda
    this.phase = "lobby"; // 'lobby' | 'playing' | 'win'
    this.hostId = null;
    this.tick = 0;
    this.startTick = 0;
    this.winTime = 0;
  }

  get count() {
    return this.players.length;
  }
  get isEmpty() {
    return this.players.length === 0;
  }
  get isFull() {
    return this.players.length >= MAX_PLAYERS;
  }

  findPlayer(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  // Primeiro personagem livre (0..MAX_PLAYERS-1) que ninguém pegou.
  // Como MAX_PLAYERS === nº de personagens, sempre sobra um.
  firstFreeChar() {
    const used = new Set(this.players.map((p) => p.charIndex));
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (!used.has(i)) return i;
    }
    return null;
  }

  addPlayer(id, name) {
    if (this.isFull || this.phase !== "lobby") return null;
    // Cada jogador entra já com um personagem livre (único). Pode trocar
    // ou deselecionar depois; só não pode repetir o de outro.
    const charIndex = this.firstFreeChar();
    const p = {
      id,
      name: (name || "Jogador").slice(0, 16),
      charIndex,
      // estado físico (preenchido no start)
      x: 0,
      y: 0,
      prevY: 0,
      vx: 0,
      vy: 0,
      grounded: true,
      jumpPrev: false,
      facing: 1,
      bob: 0,
      input: { left: false, right: false, jump: false },
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = id;
    return p;
  }

  removePlayer(id) {
    const i = this.players.findIndex((p) => p.id === id);
    if (i === -1) return;
    this.players.splice(i, 1);
    // se o host saiu, promove o próximo
    if (this.hostId === id) {
      this.hostId = this.players.length ? this.players[0].id : null;
    }
  }

  setInput(id, input) {
    const p = this.findPlayer(id);
    if (!p) return;
    p.input.left = !!input.left;
    p.input.right = !!input.right;
    p.input.jump = !!input.jump;
  }

  // Troca (ou deseleciona) o personagem de um jogador, só no lobby.
  // Cada personagem é exclusivo: ninguém pode repetir o de outro.
  // Passar null (ou -1) deseleciona. Retorna:
  //   true    -> mudou algo (rebroadcast do lobby)
  //   false   -> nada mudou / entrada inválida
  //   "taken" -> o personagem já é de outro jogador
  setChar(id, charIndex) {
    if (this.phase !== "lobby") return false;
    const p = this.findPlayer(id);
    if (!p) return false;

    // deseleção
    if (charIndex === null || charIndex === -1) {
      if (p.charIndex === null) return false;
      p.charIndex = null;
      return true;
    }

    const idx = Number(charIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_PLAYERS) return false;
    if (p.charIndex === idx) return false;
    // alguém já tem esse personagem?
    if (this.players.some((o) => o.id !== id && o.charIndex === idx))
      return "taken";
    p.charIndex = idx;
    return true;
  }

  // Todos escolheram um personagem? (necessário para iniciar)
  allChosen() {
    return this.players.every((p) => p.charIndex !== null);
  }

  canStart(id) {
    return (
      this.phase === "lobby" &&
      id === this.hostId &&
      this.players.length >= MIN_PLAYERS_TO_START &&
      this.allChosen()
    );
  }

  // Coloca cada jogador no seu ponto de nascimento, zerando a física.
  // Usado no start e sempre que alguém cai no buraco (renascimento).
  spawnPlayers() {
    const sp = this.world.spawnPoints;
    this.players.forEach((p, i) => {
      const s = sp[i] || sp[sp.length - 1];
      p.x = s.x;
      p.y = s.y;
      p.prevY = s.y;
      p.vx = 0;
      p.vy = 0;
      p.grounded = true;
      p.jumpPrev = false;
      p.facing = 1;
      p.bob = 0;
    });
  }

  start() {
    this.spawnPlayers();
    // no início também zera os inputs (podem ter ficado presos no lobby)
    this.players.forEach((p) => {
      p.input = { left: false, right: false, jump: false };
    });
    this.phase = "playing";
    this.startTick = this.tick;
    this.winTime = 0;
  }

  // Um passo de física (60 Hz). Igual ao updatePlay() do original.
  step() {
    if (this.phase !== "playing") return;
    this.tick++;
    const players = this.players;

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const { left, right, jump } = p.input;

      const accel = p.grounded ? MOVE_ACCEL : AIR_ACCEL;
      if (left && !right) {
        p.vx -= accel;
        p.facing = -1;
      } else if (right && !left) {
        p.vx += accel;
        p.facing = 1;
      } else if (p.grounded) {
        p.vx *= FRICTION;
        if (Math.abs(p.vx) < 0.05) p.vx = 0;
      }

      if (p.vx > MAX_SPEED) p.vx = MAX_SPEED;
      if (p.vx < -MAX_SPEED) p.vx = -MAX_SPEED;

      // pulo com detecção de borda (só quando no chão)
      if (jump && !p.jumpPrev && p.grounded) {
        p.vy = JUMP_VEL;
        p.grounded = false;
        p.justJumped = true; // sinaliza SFX ao cliente
      }
      p.jumpPrev = jump;

      p.vy += GRAVITY;
      if (p.vy > MAX_FALL) p.vy = MAX_FALL;
    }

    // corda: mola entre jogadores consecutivos quando esticada.
    // Como não há colisão jogador-jogador, eles podem ficar um atrás
    // do outro sem se empurrarem.
    for (let r = 0; r < players.length - 1; r++) {
      const a = players[r];
      const b = players[r + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      if (dist > ROPE_LEN) {
        const nx = dx / dist;
        const ny = dy / dist;
        const stretch = dist - ROPE_LEN;
        const force = stretch * ROPE_K;
        const relV = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        const damp = relV * ROPE_DAMP;
        const totalF = force + damp;
        a.vx += nx * totalF;
        a.vy += ny * totalF;
        b.vx -= nx * totalF;
        b.vy -= ny * totalF;
      }
    }

    // integração + colisão
    for (let k = 0; k < players.length; k++) {
      const pl = players[k];
      pl.prevY = pl.y;
      pl.x += pl.vx;
      pl.y += pl.vy;

      const hw = 12;
      if (pl.x < hw) {
        pl.x = hw;
        if (pl.vx < 0) pl.vx = 0;
      }
      if (pl.x > WORLD_W - hw) {
        pl.x = WORLD_W - hw;
        if (pl.vx > 0) pl.vx = 0;
      }

      this.resolvePlatforms(pl);

      if (pl.grounded && Math.abs(pl.vx) > 0.3) pl.bob += 0.3;
      else if (!pl.grounded) pl.bob += 0.08;
    }

    // perigos: pêndulos e pássaros podem empurrar quem encostar.
    this.applyHazards();

    // queda no buraco: se alguém sai pela parte de baixo da tela, todos
    // renascem no começo (estão presos pela corda, então voltam juntos).
    const fallLine = this.world.worldH + 20;
    let someoneFell = false;
    for (let f = 0; f < players.length; f++) {
      if (players[f].y > fallLine) {
        someoneFell = true;
        break;
      }
    }
    if (someoneFell) {
      this.spawnPlayers();
      return; // sem vitória no mesmo tick do renascimento
    }

    // vitória: qualquer jogador encosta na porta
    const door = this.world.door;
    for (let w = 0; w < players.length; w++) {
      const q = players[w];
      const qTop = q.y - 44;
      if (
        q.x + 12 > door.x &&
        q.x - 12 < door.x + door.w &&
        qTop < door.y + door.h &&
        q.y > door.y
      ) {
        this.winTime = (this.tick - this.startTick) / 60;
        this.phase = "win";
        break;
      }
    }
  }

  // Empurra um jogador para o lado (e um pouco para cima), tirando-o do
  // chão. Com a corda, o tranco também arrasta os vizinhos.
  knock(pl, dir) {
    pl.vx = dir * KNOCK_VX;
    pl.vy = KNOCK_VY;
    pl.x += dir * 3;
    pl.grounded = false;
  }

  // Colisão com os perigos da faixa 150–300 m. Posições são
  // determinísticas a partir do tick (iguais no cliente), então basta
  // recalcular aqui e testar contra a "caixa" do personagem.
  applyHazards() {
    const hw = 12;
    const players = this.players;
    const pends = this.world.pendulums || [];
    const birds = this.world.birds || [];

    for (let k = 0; k < players.length; k++) {
      const pl = players[k];
      const top = pl.y - 44; // topo da cabeça
      const bot = pl.y; // pés

      // pêndulos (peso circular vs. caixa do personagem)
      for (let i = 0; i < pends.length; i++) {
        const pd = pends[i];
        const b = pendulumPos(pd, this.tick);
        // ponto da caixa mais próximo do centro do peso
        const nx = Math.max(pl.x - hw, Math.min(b.x, pl.x + hw));
        const ny = Math.max(top, Math.min(b.y, bot));
        const dx = b.x - nx;
        const dy = b.y - ny;
        if (dx * dx + dy * dy < pd.r * pd.r) {
          // empurra no sentido em que o peso está indo
          const prev = pendulumPos(pd, this.tick - 1);
          let dir = b.x - prev.x;
          dir = dir > 0.01 ? 1 : dir < -0.01 ? -1 : pl.x < b.x ? -1 : 1;
          this.knock(pl, dir);
        }
      }

      // pássaros (caixa vs. caixa)
      for (let i = 0; i < birds.length; i++) {
        const bd = birds[i];
        const bx = birdX(bd, this.tick, WORLD_W);
        if (
          pl.x + hw > bx - bd.w / 2 &&
          pl.x - hw < bx + bd.w / 2 &&
          bot > bd.y - bd.h / 2 &&
          top < bd.y + bd.h / 2
        ) {
          this.knock(pl, bd.dir);
        }
      }
    }
  }

  resolvePlatforms(pl) {
    const hw = 12;
    pl.grounded = false;
    const bottom = pl.y;
    const prevBottom = pl.prevY;
    const platforms = this.world.platforms;

    for (let i = 0; i < platforms.length; i++) {
      const p = platforms[i];
      const top = p.y;
      const overlapX = pl.x + hw > p.x && pl.x - hw < p.x + p.w;
      if (!overlapX) continue;
      // plataforma "um sentido": só aterrissa vindo de cima, caindo
      if (pl.vy >= 0 && prevBottom <= top + 6 && bottom >= top) {
        pl.y = top;
        pl.vy = 0;
        pl.grounded = true;
      }
    }
  }

  // Snapshot enviado aos clientes a cada broadcast.
  snapshot() {
    const elapsed =
      this.phase === "win" ? this.winTime : (this.tick - this.startTick) / 60;
    return {
      t: "state",
      tick: this.tick,
      phase: this.phase,
      elapsed: Math.round(elapsed * 10) / 10,
      players: this.players.map((p) => {
        const jumped = p.justJumped || false;
        p.justJumped = false;
        return {
          id: p.id,
          x: Math.round(p.x * 100) / 100,
          y: Math.round(p.y * 100) / 100,
          facing: p.facing,
          bob: Math.round(p.bob * 100) / 100,
          grounded: p.grounded,
          jumped,
        };
      }),
    };
  }

  // Descrição da sala para o lobby.
  lobbyInfo() {
    return {
      t: "room",
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      maxPlayers: MAX_PLAYERS,
      minToStart: MIN_PLAYERS_TO_START,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        charIndex: p.charIndex,
      })),
    };
  }

  // Dados do mundo para o cliente desenhar.
  worldInfo(forId) {
    return {
      t: "world",
      code: this.code,
      world: this.world,
      hostId: this.hostId,
      youId: forId,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        charIndex: p.charIndex,
      })),
    };
  }
}

/* ============================================================
   world.js — Geração do mapa (lado servidor).
   Portado de js/game.js do jogo original "Subir Presos".
   O mundo é determinístico a partir de uma seed, então basta
   gerá-lo uma vez por sala e enviar aos clientes para desenhar.
   ============================================================ */

// Mesmas dimensões internas do canvas do cliente.
export const WORLD_W = 1280;

// Quantos pixels do mundo equivalem a 1 "metro" de altura.
// (medida própria do jogo — usada no HUD de altitude do cliente)
export const PX_PER_METER = 12;

// Margem (px) que os pássaros percorrem fora da tela antes de "dar a volta".
export const BIRD_MARGIN = 80;

// Posição do peso de um pêndulo num dado tick. Determinística: cliente e
// servidor calculam igual a partir do mesmo tick, então o balanço fica
// sincronizado sem precisar enviar a posição em cada snapshot.
export function pendulumPos(pend, tick) {
  const angle = pend.amp * Math.sin(tick * pend.speed + pend.phase);
  return {
    x: pend.ax + Math.sin(angle) * pend.len,
    y: pend.ay + Math.cos(angle) * pend.len,
    angle,
  };
}

// Posição horizontal de um pássaro num dado tick (atravessa a tela e volta).
export function birdX(bird, tick, worldW) {
  const span = worldW + BIRD_MARGIN * 2;
  let t = (tick * bird.speed + bird.phase) % span;
  if (t < 0) t += span;
  return bird.dir === 1 ? -BIRD_MARGIN + t : worldW + BIRD_MARGIN - t;
}

// PRNG determinístico (mesmo do jogo original).
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Gera o mundo (plataformas, porta, pontos de nascimento).
 * @param {number} seed - semente do PRNG (varia o mapa por sala).
 * @returns {{platforms:Array, door:object, worldH:number, groundTop:number, spawnPoints:Array, decos:Array, pxPerMeter:number, worldW:number}}
 */
export function generateWorld(seed) {
  const rng = mulberry32(seed >>> 0);
  const platforms = [];
  const decos = [];

  // Sobe até a porta ficar ~300 m de altura (antes eram ~170 m).
  // altitude_porta = (total + 178) / PX_PER_METER (veja door.y mais abaixo).
  const TARGET_DOOR_M = 300;
  const gaps = [];
  let total = 0;
  while ((total + 178) / PX_PER_METER < TARGET_DOOR_M) {
    const g = 92 + Math.floor(rng() * 26); // 92..117
    gaps.push(g);
    total += g;
  }
  const levels = gaps.length;

  const groundTop = total + 220; // headroom acima para a porta
  let worldH = groundTop + 80;

  // chão: plataforma sólida larga na base (esquerda)
  platforms.push({
    x: 0,
    y: groundTop,
    w: 520,
    h: worldH - groundTop,
    ground: true,
  });

  // plataformas subindo em zigue-zague, sempre alcançáveis
  let prevX = 200;
  let cumulative = 0;
  for (let j = 0; j < levels; j++) {
    cumulative += gaps[j];
    const y = groundTop - cumulative;
    const w = 110 + Math.floor(rng() * 70); // 110..180

    const dir = rng() < 0.5 ? -1 : 1;
    const dist = 150 + rng() * 90; // 150..240
    let cx = prevX + dir * dist;

    const minCx = 90 + w / 2;
    const maxCx = WORLD_W - 90 - w / 2;
    if (cx < minCx) cx = minCx + rng() * 60;
    if (cx > maxCx) cx = maxCx - rng() * 60;

    const px = cx - w / 2;
    platforms.push({ x: px, y: y, w: w, h: 22, ground: false });
    prevX = cx;

    if (rng() < 0.5) {
      decos.push({
        x: px + w * (0.2 + rng() * 0.6),
        y: y,
        s: 0.7 + rng() * 0.5,
      });
    }
  }

  // plataforma final (topo), dentro do alcance de um pulo
  const topY = groundTop - cumulative - 100;
  const topW = 200;
  let nudge = WORLD_W / 2 - prevX;
  if (nudge > 200) nudge = 200;
  if (nudge < -200) nudge = -200;
  let topCx = prevX + nudge;
  const topMin = 90 + topW / 2;
  const topMax = WORLD_W - 90 - topW / 2;
  if (topCx < topMin) topCx = topMin;
  if (topCx > topMax) topCx = topMax;
  const topX = topCx - topW / 2;
  platforms.push({
    x: topX,
    y: topY,
    w: topW,
    h: 24,
    ground: false,
    top: true,
  });

  const door = { x: topCx - 26, y: topY - 78, w: 52, h: 78 };

  // ---- Desafios extras (entre ~150 m e ~300 m) ----------------------
  // Pêndulos balançando sobre algumas plataformas: os jogadores têm de
  // cruzar/pular no tempo certo, juntos. E poucos pássaros atravessando a
  // tela que, ao encostar em alguém, o empurram para o lado (podem derrubar).
  const ZONE_MIN_M = 150;
  const ZONE_MAX_M = 300;
  const altOf = (y) => (groundTop - y) / PX_PER_METER;

  const pendulums = [];
  for (let i = 1; i < platforms.length; i++) {
    const p = platforms[i];
    if (p.ground || p.top) continue;
    const a = altOf(p.y);
    if (a < ZONE_MIN_M || a > ZONE_MAX_M) continue;
    if (rng() < 0.35) {
      pendulums.push({
        ax: p.x + p.w / 2, // âncora no centro da plataforma
        ay: p.y - 150, // viga bem acima da plataforma
        len: 110, // comprimento da corda
        r: 16, // raio do peso
        amp: 0.8 + rng() * 0.35, // amplitude do balanço (radianos)
        speed: 0.03 + rng() * 0.02, // velocidade angular (por tick)
        phase: rng() * Math.PI * 2, // defasagem inicial
      });
    }
  }

  // Poucos pássaros, espalhados pela faixa de altura dos desafios.
  const birds = [];
  const birdCount = 3 + Math.floor(rng() * 3); // 3..5
  for (let b = 0; b < birdCount; b++) {
    const a = ZONE_MIN_M + rng() * (ZONE_MAX_M - ZONE_MIN_M);
    birds.push({
      y: groundTop - a * PX_PER_METER,
      dir: rng() < 0.5 ? -1 : 1, // -1 = voa para a esquerda; 1 = direita
      speed: 1.1 + rng() * 0.9, // px por tick
      phase: rng() * (WORLD_W + BIRD_MARGIN * 2),
      w: 48,
      h: 28,
    });
  }

  // árvores grandes no chão (decorativas)
  decos.push({ x: 60, y: groundTop, s: 1.4 });
  decos.push({ x: 300, y: groundTop, s: 1.1 });
  decos.push({ x: 460, y: groundTop, s: 1.6 });

  // pontos de nascimento no chão, juntinhos (até 4 jogadores)
  const spawnPoints = [];
  for (let k = 0; k < 4; k++) {
    spawnPoints.push({ x: 90 + k * 14, y: groundTop });
  }

  return {
    platforms,
    door,
    worldH,
    groundTop,
    spawnPoints,
    decos,
    pendulums,
    birds,
    pxPerMeter: PX_PER_METER,
    worldW: WORLD_W,
  };
}

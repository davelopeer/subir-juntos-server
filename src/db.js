/* ============================================================
   db.js — Registro global de códigos de sala.
   Usa Postgres (Neon) quando DATABASE_URL está definido; caso
   contrário, cai para um Set em memória (útil em dev/local).

   Regra do jogo: o código é inserido ao CRIAR a sala (garantindo
   unicidade) e removido quando o jogo INICIA ou a sala esvazia.
   ============================================================ */

import pg from "pg";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem I,O,0,1 (confusos)
const CODE_LEN = 5; // "até 5 caracteres"

let pool = null;
const memoryCodes = new Set(); // fallback sem banco

export function usingDatabase() {
  return !!pool;
}

export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("[db] DATABASE_URL ausente — usando registro em memória.");
    return;
  }
  // Liga SSL só quando a connection string pede (Neon usa sslmode=require).
  // Postgres local (docker) não suporta SSL, então fica desligado.
  const needSsl = /sslmode=require/.test(url) || /\.neon\.tech/.test(url);
  pool = new pg.Pool({
    connectionString: url,
    ssl: needSsl ? { rejectUnauthorized: false } : false,
    max: 5,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_codes (
      code TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("[db] Conectado ao Postgres e tabela pronta.");
}

function randomCode() {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) {
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return s;
}

/**
 * Reserva um código único (insere no registro). Tenta várias vezes
 * em caso de colisão. Devolve o código reservado.
 * @param {(code:string)=>boolean} existsInMemory - checa salas vivas
 */
export async function reserveCode(existsInMemory) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = randomCode();
    if (existsInMemory(code)) continue; // evita colidir com sala viva

    if (!pool) {
      if (memoryCodes.has(code)) continue;
      memoryCodes.add(code);
      return code;
    }
    try {
      await pool.query("INSERT INTO room_codes (code) VALUES ($1)", [code]);
      return code;
    } catch (err) {
      if (err && err.code === "23505") continue; // violação de unicidade
      throw err;
    }
  }
  throw new Error("Não foi possível gerar um código único de sala.");
}

/** Libera o código (ao iniciar o jogo ou esvaziar a sala). */
export async function releaseCode(code) {
  if (!code) return;
  if (!pool) {
    memoryCodes.delete(code);
    return;
  }
  try {
    await pool.query("DELETE FROM room_codes WHERE code = $1", [code]);
  } catch (err) {
    console.error("[db] erro ao liberar código:", err.message);
  }
}

/** Alineación referencia ↔ palabras de Azure — dominio puro, sin React.
 *
 * Problema: para pintar el feedback INLINE en la oración hay que mapear los
 * tokens del texto original (con puntuación y mayúsculas) a los `WordScore`
 * de Azure, que vienen normalizados (minúsculas, sin puntuación) y, con
 * miscue activado, traen filas `Omission` (palabra de la referencia que no
 * dijiste, emitida en su lugar) e `Insertion` (palabra dicha de más, que no
 * consume ningún token de la referencia).
 *
 * Invariante de diseño: ante cualquier desincronización, el peor caso es un
 * token SIN resaltar (`score: null`) — nunca un resaltado corrido a la
 * palabra equivocada.
 */

import type { WordScore } from "./types";

export interface AlignedToken {
  /** token original, para display */
  token: string;
  /** sin puntuación en los bordes (lo que se resalta y se manda al TTS) */
  clean: string;
  /** puntuación que queda FUERA del highlight */
  prefix: string;
  suffix: string;
  /** score de Azure asociado, o null = Azure nunca evaluó este token */
  score: WordScore | null;
  omitted: boolean;
}

export interface Alignment {
  tokens: AlignedToken[];
  /** palabras que dijiste de más (errorType Insertion) */
  insertions: WordScore[];
}

/** Distinto de `normalizeText` (game.ts) a propósito: acá "don't" debe
 * colapsar a "dont" para matchear contra la forma de Azure. */
const norm = (w: string): string =>
  w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function splitToken(token: string): {
  prefix: string;
  clean: string;
  suffix: string;
} {
  const m = token.match(/^([^\p{L}\p{N}]*)([\s\S]*?)([^\p{L}\p{N}]*)$/u);
  if (!m) return { prefix: "", clean: token, suffix: "" };
  return { prefix: m[1] ?? "", clean: m[2] ?? "", suffix: m[3] ?? "" };
}

/** Cuántas palabras de Azure mirar hacia adelante para resincronizar. */
const LOOKAHEAD = 4;

export function alignWords(reference: string, words: WordScore[]): Alignment {
  // Las inserciones no consumen tokens de la referencia; el resto conserva
  // el orden de lectura (las omisiones vienen emitidas en su lugar).
  const insertions: WordScore[] = [];
  const seq: WordScore[] = [];
  for (const w of words) {
    if (w.errorType.includes("Insertion")) insertions.push(w);
    else seq.push(w);
  }

  const tokens: AlignedToken[] = [];
  let i = 0; // puntero sobre seq
  for (const raw of reference.split(/\s+/).filter(Boolean)) {
    const { prefix, clean, suffix } = splitToken(raw);
    const target = norm(clean);
    let matched: WordScore | null = null;

    if (target) {
      const end = Math.min(i + LOOKAHEAD, seq.length);
      for (let j = i; j < end; j++) {
        const wj = seq[j]!;
        if (norm(wj.word) === target) {
          matched = wj;
          i = j + 1;
          break;
        }
        // Token con guión que Azure partió en dos ("well-known" -> well + known):
        // el score del par es el del eslabón más flojo (la regla del juego).
        const wk = seq[j + 1];
        if (wk && norm(wj.word) + norm(wk.word) === target) {
          matched = {
            word: clean,
            accuracy: Math.min(wj.accuracy, wk.accuracy),
            errorType: wj.errorType.includes("Omission") ? wj.errorType : wk.errorType,
            phonemes: [...wj.phonemes, ...wk.phonemes],
          };
          i = j + 2;
          break;
        }
      }
      // sin match dentro de la ventana: token sin evaluar, NO avanzamos seq
    }

    tokens.push({
      token: raw,
      clean,
      prefix,
      suffix,
      score: matched,
      omitted: matched?.errorType.includes("Omission") ?? false,
    });
  }

  return { tokens, insertions };
}

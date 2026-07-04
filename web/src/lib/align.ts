/** Reference ↔ Azure words alignment — pure domain, no React.
 *
 * Problem: to paint the feedback INLINE in the sentence we must map the
 * tokens of the original text (with punctuation and capitalization) to the
 * Azure `WordScore`s, which come normalized (lowercase, no punctuation)
 * and, with miscue enabled, include `Omission` rows (a reference word you
 * did not say, emitted in its place) and `Insertion` rows (an extra spoken
 * word that consumes no reference token).
 *
 * Design invariant: on any desync, the worst case is a token left
 * UNhighlighted (`score: null`) — never a highlight shifted onto the
 * wrong word.
 */

import type { WordScore } from "./types";

export interface AlignedToken {
  /** original token, for display */
  token: string;
  /** without punctuation at the edges (what gets highlighted and sent to TTS) */
  clean: string;
  /** punctuation left OUTSIDE the highlight */
  prefix: string;
  suffix: string;
  /** associated Azure score, or null = Azure never evaluated this token */
  score: WordScore | null;
  omitted: boolean;
}

export interface Alignment {
  tokens: AlignedToken[];
  /** extra words you said (errorType Insertion) */
  insertions: WordScore[];
}

/** Deliberately different from `normalizeText` (game.ts): here "don't" must
 * collapse to "dont" to match against Azure's form. */
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

/** How many Azure words to look ahead to resynchronize. */
const LOOKAHEAD = 4;

export function alignWords(reference: string, words: WordScore[]): Alignment {
  // Insertions consume no reference tokens; the rest keeps reading
  // order (omissions are emitted in their place).
  const insertions: WordScore[] = [];
  const seq: WordScore[] = [];
  for (const w of words) {
    if (w.errorType.includes("Insertion")) insertions.push(w);
    else seq.push(w);
  }

  const tokens: AlignedToken[] = [];
  let i = 0; // pointer over seq
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
        // Hyphenated token Azure split in two ("well-known" -> well + known):
        // the pair's score is the weakest link's (the game's rule).
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
      // no match within the window: token left unevaluated, we do NOT advance seq
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

/** Modo demo (?demo en la URL): un Scorer de mentira para QA visual.
 *
 * Devuelve assessments enlatados y deterministas sin mic ni key de Azure:
 * el primer intento con cada objetivo falla (scores mixtos + una omisión +
 * una inserción), el segundo pasa. Permite recorrer ready -> recording ->
 * fail -> práctica -> pass -> win completo. No toca el juego real: solo se
 * usa cuando la URL trae ?demo.
 */

import type { Assessment, PhonemeScore, WordScore } from "./types";
import type { AssessOptions } from "./scorer";

const IPA = ["ð", "ɪ", "æ", "ə", "ɹ", "iː", "ʌ", "eɪ", "s", "t", "k", "m", "n", "l"];

const hash = (s: string): number =>
  [...s].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ScorerPort {
  assess(referenceText: string, opts?: AssessOptions): Promise<Assessment>;
  speak(text: string): Promise<string | null>;
}

export function createDemoScorer(): ScorerPort {
  const attempts = new Map<string, number>();
  return {
    async assess(referenceText, opts = {}) {
      const n = (attempts.get(referenceText) ?? 0) + 1;
      attempts.set(referenceText, n);
      opts.onStatus?.("listening");
      await wait(600);
      opts.onStatus?.("speech");
      await wait(700);
      opts.onStatus?.("processing");
      await wait(400);

      const tokens = referenceText
        .split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}'’-]/gu, ""))
        .filter(Boolean);
      const words: WordScore[] = tokens.map((w, idx) => {
        const base = 40 + (hash(w.toLowerCase()) % 60); // 40..99, estable por palabra
        const acc = n >= 2 ? Math.max(97, base) : base;
        const omitted = n === 1 && tokens.length > 4 && idx === tokens.length - 2;
        const phonemes: PhonemeScore[] = [...w].slice(0, 6).map((_ch, k) => ({
          phoneme: IPA[(hash(w) + k) % IPA.length]!,
          accuracy: Math.max(20, Math.min(100, acc + ((k * 7) % 15) - 7)),
        }));
        return {
          word: w.toLowerCase(),
          accuracy: omitted ? 0 : acc,
          errorType: omitted ? "Omission" : "None",
          phonemes,
        };
      });
      if (n === 1 && tokens.length > 3) {
        words.splice(2, 0, { word: "uh", accuracy: 0, errorType: "Insertion", phonemes: [] });
      }
      const scored = words.filter((w) => w.errorType === "None");
      const accuracy =
        scored.reduce((acc, w) => acc + w.accuracy, 0) / Math.max(1, scored.length);
      return {
        recognizedText: n >= 2 ? referenceText : tokens.slice(0, -1).join(" "),
        accuracy,
        pronunciation: accuracy,
        completeness: n >= 2 ? 100 : 90,
        fluency: 88,
        words,
        error: null,
        audioUrl: null,
      };
    },
    async speak(_text) {
      await wait(400);
      return null;
    },
  };
}

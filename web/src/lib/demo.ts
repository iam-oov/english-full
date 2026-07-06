/** Demo mode (?demo in the URL): a fake Scorer for visual QA.
 *
 * Returns canned, deterministic assessments with no mic or Azure key:
 * the first attempt at each target fails (mixed scores + one omission +
 * one insertion), the second passes. Lets you walk the full ready ->
 * recording -> fail -> practice -> pass -> win flow. Doesn't touch the
 * real game: only used when the URL carries ?demo.
 */

import type { PhonemeScore, WordScore } from "./types";
import type { ScorerPort } from "./ports";

const IPA = ["ð", "ɪ", "æ", "ə", "ɹ", "iː", "ʌ", "eɪ", "s", "t", "k", "m", "n", "l"];

const hash = (s: string): number =>
  [...s].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
        const base = 40 + (hash(w.toLowerCase()) % 60); // 40..99, stable per word
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

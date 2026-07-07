/** Game model — pure domain.
 *
 * Target kinds:
 *   "sentence" -> sub-boss: one paragraph sentence (scored per word)
 *   "boss"     -> final boss: the whole paragraph (continuous recognition)
 *   "word"     -> single word (only in practice mode via R)
 */

import { weakWords, type Assessment } from "./types";

export type Kind = "sentence" | "boss" | "word";

export interface Target {
  /** stable id for indexing per-target state */
  id: number;
  /** what is displayed big */
  label: string;
  /** the text Azure evaluates */
  reference: string;
  kind: Kind;
}

let nextTargetId = 1;

export const makeSentence = (text: string): Target => ({
  id: nextTargetId++, label: text, reference: text, kind: "sentence",
});
export const makeBoss = (paragraph: string): Target => ({
  id: nextTargetId++, label: paragraph, reference: paragraph, kind: "boss",
});
export const makeWord = (w: string): Target => ({
  id: nextTargetId++, label: w, reference: w, kind: "word",
});

/** Scored per word (sentence or boss), not per phoneme. */
export const isMultiword = (t: Target): boolean =>
  t.kind === "sentence" || t.kind === "boss";

/** Tolerates long pauses between words while recognizing (sentence/boss). */
export const isLongForm = isMultiword;

/** CONTINUOUS recognition (no ~15s cap): the boss = the entire paragraph. */
export const isContinuous = (t: Target): boolean => t.kind === "boss";

/** Splits a paragraph into sentences. A newline is ALWAYS a boundary
 * (one line = one sentence); within each line it segments
 * with Intl.Segmenter + abbreviation re-joining, instead of the naive
 * split on '.'. So "Mr. Smith arrived." or "Meet at 5 p.m. today." stay
 * as ONE sentence. */
export function splitSentences(text: string): string[] {
  return text.split("\n").flatMap(segmentLine);
}

/** A segment ending in an abbreviation does NOT close the sentence: it is
 * re-joined with the next one. Browsers' ICU segments without a suppression
 * list (it breaks at "Mr."), so we supply it ourselves. `\b\p{L}\.` covers
 * initials and dotted acronyms ("J.", "U.S.", "p.m."). */
const ABBREV_END =
  /(?:\b(?:mr|mrs|ms|dr|prof|st|sr|jr|vs|etc|no|approx)|\b\p{L})\.$/iu;

function segmentLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
    const merged: string[] = [];
    for (const { segment } of segmenter.segment(trimmed)) {
      const prev = merged[merged.length - 1];
      if (prev !== undefined && ABBREV_END.test(prev.trimEnd())) {
        merged[merged.length - 1] = prev + segment;
      } else {
        merged.push(segment);
      }
    }
    const parts = merged
      .map((s) => stripTrailingDot(s.trim()))
      .filter(Boolean);
    if (parts.length > 0) return parts;
  } catch {
    // browser without Intl.Segmenter: fall back to the classic split on '.'
  }
  return trimmed
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The trailing period is not part of the sub-boss (same as the classic
 * split); '?' and '!' ARE kept (they change the intonation being practiced). */
const stripTrailingDot = (s: string): string => s.replace(/\.+$/, "").trim();

/** Sub-bosses (sentences) + final boss (paragraph, only if there is more than one sentence). */
export function buildTargets(sentences: string[]): Target[] {
  const targets = sentences.map(makeSentence);
  if (sentences.length > 1) {
    // Clean reconstruction: each sentence closes with its own punctuation
    // (or a '.' if it has none), without duplicating the "?." / "!.".
    const paragraph = sentences
      .map((s) => (/[.!?…]$/.test(s) ? s : `${s}.`))
      .join(" ");
    targets.push(makeBoss(paragraph));
  }
  return targets;
}

/** Normalizes to compare what was recognized vs the target: lowercase, no
 * punctuation, collapsed whitespace. 'Entered.' == 'entered'. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** SINGLE source of truth for the action keys. Change the letter here and it
 * updates in the bindings and in every on-screen hint. */
export const KEYS = {
  correct: "f", // hear the CORRECT pronunciation (Azure TTS)
  mine: "d", // hear YOUR voice (your latest recording)
  retry: "s", // retry (even if you already defeated it)
  boss: "a", // toggle: go to the final boss / come back
  practice: "r", // practice the target's most-missed words
  clear: "x", // reset the target's practice-word list
  prev: "q", // navigate to the PREVIOUS sub-boss/boss
  next: "w", // navigate to the NEXT sub-boss/boss
  fontUp: "p", // enlarge the reading-text font
  fontDown: "l", // shrink the font
} as const;

export type KeyAction = keyof typeof KEYS;

/** Hints for the English sounds that Spanish speakers struggle with most.
 * Key = IPA phoneme returned by Azure. */
const PHONEME_HINTS: Record<string, string> = {
  "ð": "el 'th' SUAVE de THIS/THE (lengua entre los dientes, CON voz)",
  "θ": "el 'th' FUERTE de THINK/BATH (lengua entre los dientes, SIN voz)",
  v: "la 'v' de VAN (labio sobre los dientes — NO es B)",
  w: "la 'w' de WE/WATER (labios redondeados, como 'u')",
  "ɹ": "la 'r' inglesa de RED (la lengua NO vibra)",
  r: "la 'r' inglesa de RED (la lengua NO vibra)",
  "ɪ": "la 'i' CORTA y relajada de SHIP/BIT (no es la de SHEEP)",
  i: "la 'i' LARGA de SHEEP/SEE",
  "iː": "la 'i' LARGA de SHEEP/SEE",
  "æ": "la 'a' abierta de CAT/MAP (boca bien abierta)",
  "ə": "la 'schwa': vocal neutra y floja de THE/ABOUT",
  "ʌ": "la 'a' de CUP/LUCK",
  "ʃ": "el 'sh' de SHE/SHIP",
  "ʒ": "el sonido de viSIon/meaSure",
  "tʃ": "el 'ch' de CHEESE/CHAIR",
  "dʒ": "la 'j' de JOB/AGE",
  "ŋ": "el 'ng' nasal de SING/KING",
  h: "la 'h' ASPIRADA de HELLO (sí suena, no es muda)",
  "ʊ": "la 'u' corta de BOOK/PUT",
  u: "la 'u' larga de FOOD",
  "uː": "la 'u' larga de FOOD",
  "ɛ": "la 'e' de BED/HEAD",
  "ɔ": "la 'o' larga de THOUGHT/LAW",
  "ɔː": "la 'o' larga de THOUGHT/LAW",
  "ɑ": "la 'a' larga de FATHER/CAR",
  "ɑː": "la 'a' larga de FATHER/CAR",
  "eɪ": "el diptongo 'ei' de DAY/FACE",
  "oʊ": "el diptongo 'ou' de GO/HOME",
};

/** Hint for an IPA phoneme; tolerates length marks (ː) and variants. */
export function phonemeHint(phoneme: string): string | null {
  return (
    PHONEME_HINTS[phoneme] ?? PHONEME_HINTS[phoneme.replace(/ː/g, "")] ?? null
  );
}

export function failHint(
  a: Assessment,
  multiword: boolean,
  threshold: number,
): string {
  if (multiword) {
    if (weakWords(a, threshold).length === 0) {
      return `Casi. Completaste ${a.completeness.toFixed(0)}%, fluidez ${a.fluency.toFixed(0)}%.`;
    }
    return "";
  }
  const phons = a.words[0]?.phonemes ?? [];
  if (phons.length === 0) return "Casi. Afiná un poquito y de nuevo.";
  const worst = phons.reduce((x, y) => (y.accuracy < x.accuracy ? y : x));
  const base = `Enfocate en [${worst.phoneme}] (${worst.accuracy.toFixed(0)}%)`;
  const tip = phonemeHint(worst.phoneme);
  return tip ? `${base}: ${tip}` : base;
}

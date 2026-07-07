/** Pass rule of the game — pure domain.
 *
 * The rule matches the traffic-light colors the player sees:
 *
 *   WIN  =  average >= threshold  AND  no unit in the red (<= RED_CUTOFF).
 *
 * Bands: <= RED_CUTOFF red · up to AMBER_CUTOFF amber · up to the threshold
 * blue ("liked it, keep practicing") · >= threshold fine. Amber and blue
 * units don't block as long as the average clears the bar; a red unit always
 * blocks, even with a high average.
 */

import type { Assessment } from "./types";

export interface Verdict {
  passed: boolean;
  /** worst-scored unit (null when there is no breakdown) */
  worstLabel: string | null;
  worstScore: number;
}

/** At or below this, a unit shows red and vetoes the win (default;
 * configurable per player in Settings.redCutoff). */
export const RED_CUTOFF = 50;
/** At or below this (and above red), a unit shows amber; above it, blue. */
export const AMBER_CUTOFF = 80;

export type Band = "red" | "amber" | "blue" | "ok";

export function scoreBand(
  score: number,
  threshold: number,
  redCutoff = RED_CUTOFF,
): Band {
  if (score >= threshold) return "ok";
  if (score > AMBER_CUTOFF) return "blue";
  if (score > redCutoff) return "amber";
  return "red";
}

export function judge(
  units: Array<[string, number]>,
  opts: { accuracy: number; threshold: number; redCutoff?: number },
): Verdict {
  const { accuracy, threshold, redCutoff = RED_CUTOFF } = opts;

  let worstLabel: string | null = null;
  let worstScore = accuracy;
  let noRed = true;
  if (units.length > 0) {
    const worst = units.reduce((a, b) => (b[1] < a[1] ? b : a));
    [worstLabel, worstScore] = worst;
    noRed = worstScore > redCutoff;
  }

  return {
    passed: accuracy >= threshold && noRed,
    worstLabel,
    worstScore,
  };
}

export function assessmentUnits(
  a: Assessment,
  multiword: boolean,
): Array<[string, number]> {
  if (multiword) {
    return a.words
      .filter((w) => !w.errorType.includes("Insertion"))
      .map((w) => [w.word, w.accuracy]);
  }
  return (a.words[0]?.phonemes ?? []).map((p) => [p.phoneme, p.accuracy]);
}

export function judgeAssessment(
  a: Assessment,
  multiword: boolean,
  threshold: number,
  redCutoff = RED_CUTOFF,
): Verdict {
  return judge(assessmentUnits(a, multiword), {
    accuracy: a.accuracy,
    threshold,
    redCutoff,
  });
}

export function redCount(
  a: Assessment,
  multiword: boolean,
  redCutoff = RED_CUTOFF,
): number {
  return assessmentUnits(a, multiword).filter(([, s]) => s <= redCutoff)
    .length;
}

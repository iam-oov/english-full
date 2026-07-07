/** Pass rule of the game — pure domain.
 *
 * The rule matches the traffic-light colors the player sees:
 *
 *   WIN  =  average >= threshold  AND  no unit in the red (< RED_CUTOFF).
 *
 * Amber units (RED_CUTOFF..threshold) don't block as long as the average
 * clears the bar; a red unit always blocks, even with a high average.
 */

import type { Assessment } from "./types";

export interface Verdict {
  passed: boolean;
  /** worst-scored unit (null when there is no breakdown) */
  worstLabel: string | null;
  worstScore: number;
}

/** Below this, a unit shows red and vetoes the win. */
export const RED_CUTOFF = 50;

export function judge(
  units: Array<[string, number]>,
  opts: { accuracy: number; threshold: number },
): Verdict {
  const { accuracy, threshold } = opts;

  let worstLabel: string | null = null;
  let worstScore = accuracy;
  let noRed = true;
  if (units.length > 0) {
    const worst = units.reduce((a, b) => (b[1] < a[1] ? b : a));
    [worstLabel, worstScore] = worst;
    noRed = worstScore >= RED_CUTOFF;
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
): Verdict {
  return judge(assessmentUnits(a, multiword), {
    accuracy: a.accuracy,
    threshold,
  });
}

export function redCount(a: Assessment, multiword: boolean): number {
  return assessmentUnits(a, multiword).filter(([, s]) => s < RED_CUTOFF).length;
}

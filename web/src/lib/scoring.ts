/** The game's pass rule — pure domain. Mirror of `scoring.py`.
 *
 * Two ways to defeat a target:
 *
 *   RULE 1 (strict): ALL sounds (a word's phonemes, or a sentence/boss's
 *     words) must clear the threshold. NOT the average.
 *
 *   RULE 2 (near-miss): if the AVERAGE landed no more than `nearMissMargin`
 *     points BELOW the threshold AND the recognizer heard the correct text,
 *     it passes anyway. It only rescues when the average fell short: if it
 *     is already above the threshold but one sound failed, rule 1 wins.
 */

export interface Verdict {
  passed: boolean;
  /** won via the 2nd way (near-miss), not the strict one */
  byRecognition: boolean;
  /** worst-scored sound/word (null if there is no breakdown) */
  worstLabel: string | null;
  worstScore: number;
}

export function judge(
  units: Array<[string, number]>,
  opts: {
    accuracy: number;
    recognizedOk: boolean;
    threshold: number;
    nearMissMargin: number;
  },
): Verdict {
  const { accuracy, recognizedOk, threshold, nearMissMargin } = opts;

  let passedStrict: boolean;
  let worstLabel: string | null;
  let worstScore: number;
  if (units.length > 0) {
    passedStrict = units.every(([, score]) => score >= threshold);
    const worst = units.reduce((a, b) => (b[1] < a[1] ? b : a));
    [worstLabel, worstScore] = worst;
  } else {
    passedStrict = accuracy >= threshold;
    worstLabel = null;
    worstScore = accuracy;
  }

  const near = threshold - nearMissMargin <= accuracy && accuracy < threshold;
  const passed = passedStrict || (near && recognizedOk);

  return {
    passed,
    byRecognition: passed && !passedStrict,
    worstLabel,
    worstScore,
  };
}

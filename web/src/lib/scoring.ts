/** Regla de aprobado del juego — dominio puro. Espejo de `scoring.py`.
 *
 * Dos vías para derrotar un objetivo:
 *
 *   REGLA 1 (estricta): TODOS los sonidos (los fonemas de una palabra, o las
 *     palabras de una oración/jefe) deben superar el umbral. NO el promedio.
 *
 *   REGLA 2 (near-miss): si el PROMEDIO quedó a no más de `nearMissMargin`
 *     puntos por DEBAJO del umbral Y el reconocedor escuchó el texto correcto,
 *     pasa igual. Solo rescata cuando el promedio quedó corto: si ya está
 *     arriba del umbral pero un sonido falló, gana la regla 1.
 */

export interface Verdict {
  passed: boolean;
  /** ganó por la 2da vía (near-miss), no por la estricta */
  byRecognition: boolean;
  /** sonido/palabra peor puntuada (null si no hay desglose) */
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

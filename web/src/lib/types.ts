/** DTOs del resultado de evaluar una pronunciación — dominio puro, sin Azure.
 *
 * Espejo de `assessment.py`: el resto del juego habla en estos tipos y no sabe
 * que abajo hay un SDK en la nube. Si mañana se cambia el motor, solo se toca
 * `scorer.ts`.
 */

export interface PhonemeScore {
  phoneme: string;
  accuracy: number;
}

export interface WordScore {
  word: string;
  accuracy: number;
  /** "None", "Omission", "Insertion", "Mispronunciation" */
  errorType: string;
  phonemes: PhonemeScore[];
}

export interface Assessment {
  recognizedText: string;
  /** qué tan bien pronunciados los sonidos (0-100) */
  accuracy: number;
  /** score global combinado (0-100) */
  pronunciation: number;
  /** cuánto del texto objetivo dijiste (0-100) */
  completeness: number;
  /** fluidez/ritmo (0-100) */
  fluency: number;
  words: WordScore[];
  /** mensaje si algo salió mal (no hubo voz, credenciales, etc.) */
  error: string | null;
  /** URL (objectURL) con lo que dijiste, para reproducir */
  audioUrl: string | null;
}

export const assessmentOk = (a: Assessment): boolean => a.error === null;

export function errorAssessment(message: string): Assessment {
  return {
    recognizedText: "",
    accuracy: 0,
    pronunciation: 0,
    completeness: 0,
    fluency: 0,
    words: [],
    error: message,
    audioUrl: null,
  };
}

export function weakWords(a: Assessment, below: number, limit = 5): WordScore[] {
  return a.words
    .filter((w) => w.accuracy < below)
    .sort((x, y) => x.accuracy - y.accuracy)
    .slice(0, limit);
}

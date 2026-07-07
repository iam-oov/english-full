/** DTOs for the result of assessing a pronunciation — pure domain, no Azure.
 *
 * The rest of the game speaks in these types and
 * doesn't know there is a cloud SDK underneath. If the engine is swapped
 * tomorrow, only `scorer.ts` changes.
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
  /** how well the sounds were pronounced (0-100) */
  accuracy: number;
  /** combined overall score (0-100) */
  pronunciation: number;
  /** how much of the target text you said (0-100) */
  completeness: number;
  /** fluency/rhythm (0-100) */
  fluency: number;
  words: WordScore[];
  /** message if something went wrong (no voice, credentials, etc.) */
  error: string | null;
  /** URL (objectURL) with what you said, for playback */
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

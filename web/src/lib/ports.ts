import type { Assessment } from "./types";

export type StatusCode = "listening" | "speech" | "processing";
export type OnStatus = (code: StatusCode) => void;

export interface AssessOptions {
  onStatus?: OnStatus;
  /** deviceId of the chosen microphone; undefined = system default */
  deviceId?: string;
  /** tolerates longer pauses between words before cutting off (sentence/boss) */
  longForm?: boolean;
  /** CONTINUOUS recognition, without recognizeOnce's ~15s cap (boss) */
  continuous?: boolean;
  /** aborts the in-flight recognition and releases the microphone */
  signal?: AbortSignal;
}

export interface ScorerPort {
  assess(referenceText: string, opts?: AssessOptions): Promise<Assessment>;
  speak(text: string): Promise<string | null>;
}

/** Run persistence: the in-progress game survives a page refresh.
 *
 * If you are on sentence 4 with the previous ones defeated or skipped, a
 * reload restores exactly that. The saved run lives ONLY in the browser
 * (localStorage) and is cleared when the user resets ("Reiniciar" button /
 * Esc / Ctrl+R) or when the run is won.
 *
 * Serialization note: Target ids are runtime-generated (auto-increment), so
 * per-target state is persisted POSITIONALLY over the targets (sentences +
 * word gauntlets + final boss), which `buildTargets` rebuilds
 * deterministically from the sentences.
 */

import { CHALLENGE_EVERY } from "./constants";
import type { Assessment } from "./types";

export interface SavedRun {
  /** Source of truth: targets are rebuilt from these via buildTargets. */
  sentences: string[];
  /** Current position, as an index over the multiword targets. */
  index: number;
  /** Per-position status; null = not attempted yet. */
  status: Array<"defeated" | "failed" | null>;
  /** Per-position best accuracy achieved (rail score). */
  bestHp: number[];
  /** Per-position words-to-practice tally {word: failCount}. */
  errors: Array<Record<string, number>>;
  streak: number;
  combo: number;
  runXp: number;
  totalAttempts: number;
  /** Attempts on the active target, so "intento N" survives a refresh. */
  wordAttempts: number;
  /** Post-attempt view, so a refresh lands exactly where you were. */
  screen: "ready" | "fail" | "pass";
  /** Serialized Assessment DTO (audioUrl stripped: blobs don't survive). */
  assessment: Assessment | null;
}

const STORAGE_KEY = "pronunciation-tetris.run";

/** Load the saved run; anything missing or malformed yields null (and the
 * game simply starts at the input screen). */
export function loadRun(): SavedRun | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (
      typeof data !== "object" ||
      data === null ||
      !Array.isArray(data.sentences) ||
      data.sentences.length === 0 ||
      !data.sentences.every((s: unknown) => typeof s === "string") ||
      !Array.isArray(data.status) ||
      !Array.isArray(data.bestHp) ||
      !Array.isArray(data.errors) ||
      typeof data.index !== "number"
    ) {
      return null;
    }
    const expectedTargets =
      data.sentences.length +
      Math.floor(data.sentences.length / CHALLENGE_EVERY) +
      (data.sentences.length > 1 ? 1 : 0);
    if (
      data.status.length !== expectedTargets ||
      data.bestHp.length !== expectedTargets ||
      data.errors.length !== expectedTargets
    ) {
      return null;
    }
    return {
      sentences: data.sentences,
      index: Math.min(Math.max(0, data.index), expectedTargets - 1),
      status: data.status,
      bestHp: data.bestHp,
      errors: data.errors,
      streak: typeof data.streak === "number" ? data.streak : 0,
      combo: typeof data.combo === "number" ? data.combo : 0,
      runXp: typeof data.runXp === "number" ? data.runXp : 0,
      totalAttempts:
        typeof data.totalAttempts === "number" ? data.totalAttempts : 0,
      wordAttempts:
        typeof data.wordAttempts === "number" ? data.wordAttempts : 0,
      screen: ["ready", "fail", "pass"].includes(data.screen)
        ? data.screen
        : "ready",
      assessment:
        typeof data.assessment === "object" &&
        data.assessment !== null &&
        Array.isArray(data.assessment.words)
          ? data.assessment
          : null,
    };
  } catch {
    return null;
  }
}

export function saveRun(run: SavedRun): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(run));
  } catch {
    // Cosmetic: if it cannot persist, the game still works this session.
  }
}

export function clearRun(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do.
  }
}

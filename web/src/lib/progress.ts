/** Persisted progression: lifetime XP, level and accuracy (localStorage).
 *
 * - `LifetimeStats`: what is PERSISTED (total XP, accumulated accuracy, best
 *   streak). Level and accuracy are DERIVED, never stored (no migrations).
 * - Single-run counters (session streak/combo/XP) do NOT live here.
 */

export const SCHEMA_VERSION = 1;

/** XP for defeating a target for the FIRST time. Re-passing adds nothing (no farming). */
export const XP_PER_DEFEAT = 40;

export interface LifetimeStats {
  totalXp: number;
  targetsDefeated: number;
  accuracySum: number;
  accuracyCount: number;
  bestStreak: number;
  schemaVersion: number;
}

export const freshStats = (): LifetimeStats => ({
  totalXp: 0,
  targetsDefeated: 0,
  accuracySum: 0,
  accuracyCount: 0,
  bestStreak: 0,
  schemaVersion: SCHEMA_VERSION,
});

/** Level from total XP: L1: 0-99, L2: 100-399, L3: 400-899, ... */
export function levelForXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
}

export const statsLevel = (s: LifetimeStats): number => levelForXp(s.totalXp);

/** Average accuracy of DEFEATED targets (0 if there are none yet). */
export const statsAccuracy = (s: LifetimeStats): number =>
  s.accuracyCount > 0 ? s.accuracySum / s.accuracyCount : 0;

export function recordDefeat(
  s: LifetimeStats,
  accuracy: number,
  xp: number,
): LifetimeStats {
  return {
    ...s,
    totalXp: s.totalXp + xp,
    targetsDefeated: s.targetsDefeated + 1,
    accuracySum: s.accuracySum + accuracy,
    accuracyCount: s.accuracyCount + 1,
  };
}

const STORAGE_KEY = "pronunciation-tetris.stats";

/** Reads the stats. Missing or corrupt data -> fresh stats, without throwing. */
export function loadStats(): LifetimeStats {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshStats();
    const data = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return freshStats();
    const base = freshStats() as unknown as Record<string, unknown>;
    for (const key of Object.keys(base)) {
      if (key in data && typeof data[key] === "number") base[key] = data[key];
    }
    return base as unknown as LifetimeStats;
  } catch {
    return freshStats();
  }
}

export function saveStats(s: LifetimeStats): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // cosmetic: if it can't be persisted, the run goes on the same
  }
}

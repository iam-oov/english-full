/** Progresión persistida: XP, nivel y accuracy de por vida. Espejo de
 * `progress.py`, con localStorage en lugar del JSON en el dir XDG.
 *
 * - `LifetimeStats`: lo PERSISTIDO (XP total, accuracy acumulada, mejor racha).
 *   Nivel y accuracy son DERIVADOS, no se guardan (no hay que migrarlos nunca).
 * - Los contadores de UNA corrida (streak/combo/XP de la sesión) NO viven acá.
 */

export const SCHEMA_VERSION = 1;

/** XP por derrotar un objetivo por PRIMERA vez. Re-pasar no suma (no se farmea). */
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

/** Nivel a partir del XP total: L1: 0-99, L2: 100-399, L3: 400-899, ... */
export function levelForXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
}

export const statsLevel = (s: LifetimeStats): number => levelForXp(s.totalXp);

/** Promedio de accuracy de los objetivos DERROTADOS (0 si todavía no hay). */
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

/** Lee las stats. Dato faltante o corrupto -> stats frescas, sin lanzar. */
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
    // cosmético: si no se puede persistir, la partida sigue igual
  }
}

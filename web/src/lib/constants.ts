/** Fixed game knobs, grouped so tuning never means hunting through modules.
 * Zero imports on purpose: anything may depend on this file, never the
 * reverse. User-adjustable values live in Settings (config.ts) instead. */

/** At or below this, a unit shows red and vetoes the win (default;
 * the player can move it via Settings.redCutoff). */
export const RED_CUTOFF = 50;

/** At or below this (and above red), a unit shows amber; above it, blue. */
export const AMBER_CUTOFF = 80;

/** The threshold can't drop below this: the game stops being a game under 80. */
export const MIN_THRESHOLD = 80;

/** Under this the mic cuts mid-word; Azure won't take less anyway. */
export const MIN_SILENCE_MS = 300;

/** Fixed voice profile (too many knobs for a normal user). */
export const TARGET_LANGUAGE = "en-US";
export const TTS_VOICE = "en-US-AndrewNeural";
export const TTS_PITCH = "0%";
export const TTS_RATE = "+10%";

/** Padding around a word's excerpt of the player's recording: absorbs the
 * recorder/recognizer start skew without letting neighbor words through. */
export const CLIP_PAD_BEFORE_MS = 80;
export const CLIP_PAD_AFTER_MS = 300;

/** Whole-platform font size = 16px root + Settings.uiFontDelta, clamped. */
export const UI_FONT_BASE_PX = 16;
export const UI_FONT_DELTA_MIN = -2;
export const UI_FONT_DELTA_MAX = 8;

/** Difficulty presets behind the Mid/Senior buttons in Settings. */
export const LEVEL_PRESETS = [
  {
    key: "mid",
    name: "Mid",
    passThreshold: 85,
    redCutoff: 60,
    endSilenceMs: 2000,
  },
  {
    key: "senior",
    name: "Senior",
    passThreshold: 93,
    redCutoff: 75,
    endSilenceMs: 1200,
  },
] as const;

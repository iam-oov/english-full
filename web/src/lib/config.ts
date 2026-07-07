/** Game configuration. Settings live in the player's localStorage (the
 * Azure key never leaves their browser, there is no backend). */

export type Level = "mid" | "senior" | "custom";

export interface Settings {
  /** mid/senior lock the game numbers to their preset; custom frees them. */
  level: Level;
  speechKey: string;
  speechRegion: string;
  passThreshold: number;
  /** A unit scoring at or below this shows red and vetoes the win. */
  redCutoff: number;
  /** ms of silence that end a sentence recording (words use 40%, boss +500). */
  endSilenceMs: number;
  /** Student's CEFR level (A1..C2): calibrates the LLM tips. */
  cefrLevel: string;
  /** DeepSeek (LLM) is OPTIONAL: without a key, static hints and that's it. */
  deepseekKey: string;
  deepseekModel: string;
  deepseekBaseUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  level: "custom",
  speechKey: "",
  speechRegion: "",
  passThreshold: 85,
  redCutoff: 50,
  endSilenceMs: 1500,
  cefrLevel: "B2",
  deepseekKey: "",
  deepseekModel: "deepseek-chat",
  deepseekBaseUrl: "https://api.deepseek.com",
};

const STORAGE_KEY = "pronunciation-tetris.settings";

/** The threshold can't drop below this: the game stops being a game under 80. */
export const MIN_THRESHOLD = 80;

export const clampThreshold = (n: number): number =>
  Math.min(100, Math.max(MIN_THRESHOLD, Math.round(n)));

/** Keeps the red band strictly under the amber one (81+ is blue/ok). */
export const clampRedCutoff = (n: number): number =>
  Math.min(79, Math.max(0, Math.round(n)));

/** Under this the mic cuts mid-word; Azure won't take less anyway. */
export const MIN_SILENCE_MS = 300;

export const clampSilence = (n: number): number =>
  Math.min(10000, Math.max(MIN_SILENCE_MS, Math.round(n)));

export const settingsReady = (s: Settings): boolean =>
  s.speechKey.trim().length > 0 && s.speechRegion.trim().length > 0;

export const coachEnabled = (s: Settings): boolean =>
  s.deepseekKey.trim().length > 0;

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const data = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return { ...DEFAULT_SETTINGS };
    // Known keys only: an old/future JSON loads without breaking.
    const merged = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key in data && typeof data[key] === typeof merged[key]) {
        merged[key] = data[key];
      }
    }
    const settings = merged as unknown as Settings;
    settings.passThreshold = clampThreshold(settings.passThreshold);
    settings.redCutoff = clampRedCutoff(settings.redCutoff);
    settings.endSilenceMs = clampSilence(settings.endSilenceMs);
    if (!["mid", "senior", "custom"].includes(settings.level)) {
      settings.level = "custom";
    }
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // localStorage full or blocked: the settings last only this session.
  }
}

/** The last typed/imported paragraph persists in the browser: a refresh
 * should not force you to type it again. */
const PARAGRAPH_KEY = "pronunciation-tetris.paragraph";

/** Starter paragraph so a first visit (or a cleared box) is playable
 * immediately. */
export const DEFAULT_PARAGRAPH = `The crop was saved, and the Pilgrims never faced starvation again.
In gratitude, they set aside a day of Thanksgiving.
The little colony at Plymouth was becoming strong and secure.
Afterwards, other colonies were established in America.
Ever since, the people continued to observe Thanksgiving Day.
They enjoyed great feasts and reunions with family and friends.
Thanksgiving was established very early in our history.
For years it was strictly a local celebration.
After the Independence War, George Washington proclaimed a Thanksgiving Holiday.
He recommended giving thanks for the establishment of a new nation.
Therefore, each year people began to observe Thanksgiving.
Still, it was celebrated at different times in different communities.
Many people around the nation hoped for an official Thanksgiving Day.
Sarah Hale wrote articles on the subject.
She sent letters to prominent people everywhere.
She even appealed to President Lincoln.
Lincoln agreed and proclaimed the last Thursday in November the national day of Thanksgiving.
After this, each president issued a Thanksgiving proclamation every year.
Finally, the Congress made the fourth Thursday in November a national Thanksgiving Day.
On this day each year, Americans pause to give thanks and count their blessings.`;

export function loadParagraph(): string {
  try {
    const stored = localStorage.getItem(PARAGRAPH_KEY);
    return stored && stored.trim() ? stored : DEFAULT_PARAGRAPH;
  } catch {
    return DEFAULT_PARAGRAPH;
  }
}

export function saveParagraph(text: string): void {
  try {
    localStorage.setItem(PARAGRAPH_KEY, text);
  } catch {
    // cosmetic: if it can't be persisted, the game goes on the same
  }
}

/** Game configuration — mirror of `config.py`, adapted to the browser.
 *
 * On desktop this was a `.env`; here the settings live in the player's
 * localStorage (the Azure key never leaves their browser, there is no
 * backend).
 */

export interface Settings {
  speechKey: string;
  speechRegion: string;
  targetLanguage: string;
  ttsVoice: string;
  /** voice pitch: '+10%', '-15%', '0%', 'high', 'low'... */
  ttsPitch: string;
  /** rate: '+0%', '-10%', 'slow', 'fast'... */
  ttsRate: string;
  passThreshold: number;
  /** 2nd way to defeat: average within <= margin of threshold + correct text. */
  nearMissMargin: number;
  /** Student's CEFR level (A1..C2): calibrates the LLM tips. */
  cefrLevel: string;
  /** DeepSeek (LLM) is OPTIONAL: without a key, static hints and that's it. */
  deepseekKey: string;
  deepseekModel: string;
  deepseekBaseUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  speechKey: "",
  speechRegion: "",
  targetLanguage: "en-US",
  ttsVoice: "en-US-AndrewNeural",
  ttsPitch: "0%",
  ttsRate: "0%",
  passThreshold: 94,
  nearMissMargin: 5,
  cefrLevel: "B2",
  deepseekKey: "",
  deepseekModel: "deepseek-chat",
  deepseekBaseUrl: "https://api.deepseek.com",
};

const STORAGE_KEY = "pronunciation-tetris.settings";

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
    return merged as unknown as Settings;
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

export function loadParagraph(): string {
  try {
    return localStorage.getItem(PARAGRAPH_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveParagraph(text: string): void {
  try {
    localStorage.setItem(PARAGRAPH_KEY, text);
  } catch {
    // cosmetic: if it can't be persisted, the game goes on the same
  }
}

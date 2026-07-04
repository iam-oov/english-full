/** Configuración del juego — espejo de `config.py`, adaptado al navegador.
 *
 * En el escritorio esto era un `.env`; acá los ajustes viven en localStorage
 * del jugador (la key de Azure nunca sale de su navegador, no hay backend).
 */

export interface Settings {
  speechKey: string;
  speechRegion: string;
  targetLanguage: string;
  ttsVoice: string;
  /** tono de la voz: '+10%', '-15%', '0%', 'high', 'low'... */
  ttsPitch: string;
  /** velocidad: '+0%', '-10%', 'slow', 'fast'... */
  ttsRate: string;
  passThreshold: number;
  /** 2da vía para derrotar: promedio a <= margin del umbral + texto correcto. */
  nearMissMargin: number;
  /** Nivel CEFR del alumno (A1..C2): calibra los consejos del LLM. */
  cefrLevel: string;
  /** DeepSeek (LLM) es OPCIONAL: sin key, pistas estáticas y listo. */
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
    // Solo claves conocidas: un JSON viejo/futuro carga sin romper.
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
    // localStorage lleno o bloqueado: los ajustes duran solo esta sesión.
  }
}

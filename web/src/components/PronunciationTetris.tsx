/** Pronunciation Tetris — port web del juego de escritorio (app.py).
 *
 * Flujo: pegás un párrafo, el juego lo parte en oraciones (sub-jefes) y el
 * párrafo entero es el jefe final. Solo avanzás si TODOS los sonidos superan
 * el umbral (no el promedio); el near-miss es la 2da vía (scoring.ts).
 *
 * Arquitectura: este componente es el equivalente de la clase App de tkinter.
 * Solo conoce los puertos (scorer/coach/audio/progress); nada de Azure acá.
 *
 * Modelo de concurrencia: donde el escritorio usaba hilos + queue + _poll,
 * acá alcanza con async/await (el SDK de JS no bloquea). Se conserva el
 * contador `gen` que invalida trabajo async viejo (un consejo del coach o un
 * assessment que llega después de un reset se descarta).
 */

import { useEffect, useReducer, useRef } from "react";

import {
  KEYS,
  buildTargets,
  isContinuous,
  isLongForm,
  isMultiword,
  normalizeText,
  phonemeHint,
  makeWord,
  splitSentences,
  type Target,
} from "../lib/game";
import { judge } from "../lib/scoring";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  settingsReady,
  type Settings,
} from "../lib/config";
import {
  XP_PER_DEFEAT,
  freshStats,
  loadStats,
  recordDefeat,
  saveStats,
  statsAccuracy,
  statsLevel,
  type LifetimeStats,
} from "../lib/progress";
import { Scorer, type StatusCode } from "../lib/scorer";
import { Coach } from "../lib/coach";
import {
  listMicrophones,
  playRecording,
  recordTest,
  type MicOption,
} from "../lib/audio";
import { cleanOcrText, extractTextFromImage } from "../lib/ocr";
import { assessmentOk, weakWords, type Assessment } from "../lib/types";

type Screen = "input" | "ready" | "recording" | "fail" | "pass" | "win";
type ResultStyle = "idle" | "pass" | "fail-amber" | "fail-red";
type Tone = "c-fg" | "c-muted" | "c-dim" | "c-green" | "c-red" | "c-amber" | "c-accent";

interface UiText {
  text: string;
  tone: Tone;
}

/** Estado mutable del juego (el "self" de la App de tkinter). Vive en un ref y
 * cada mutación pide un re-render: las acciones del teclado leen siempre el
 * estado vivo, sin closures viejas. */
interface G {
  settings: Settings;
  stats: LifetimeStats;
  screen: Screen;
  busy: boolean;
  /** override del texto del CTA durante una operación (TTS, tu voz) */
  busyLabel: string | null;
  targets: Target[];
  index: number;
  lastAudioUrl: string | null;
  micOptions: MicOption[];
  /** deviceId elegido en el desplegable ("" = predeterminado) */
  micSelected: string;
  /** mic fijado al empezar la partida */
  micChosen: string | undefined;
  gen: number;
  totalAttempts: number;
  wordAttempts: number;
  /** palabras a mejorar POR objetivo: targetId -> {palabra: cant_errores} */
  errors: Record<number, Record<string, number>>;
  /** targetId -> "defeated" | "failed" (ausente = no intentado) */
  statusById: Record<number, "defeated" | "failed">;
  returnTargetId: number | null;
  practiceOriginId: number | null;
  practiceIds: number[];
  streak: number;
  combo: number;
  runXp: number;
  bestHp: Record<number, number>;
  fontDelta: number;
  // --- feedback visual ---
  badge: UiText & { live?: boolean };
  resultStyle: ResultStyle;
  feedback: UiText;
  units: { list: Array<[string, number]>; clickable: boolean };
  coach: { mode: "hidden" | "loading" | "shown"; text: string };
  flash: "" | "green" | "red";
  flashGen: number;
  xp: { amount: number; gen: number } | null;
  showSettings: boolean;
  paragraph: string;
}

const initialG = (): G => ({
  settings: DEFAULT_SETTINGS,
  stats: freshStats(),
  screen: "input",
  busy: false,
  busyLabel: null,
  targets: [],
  index: 0,
  lastAudioUrl: null,
  micOptions: [{ label: "🎙 Predeterminado del sistema" }],
  micSelected: "",
  micChosen: undefined,
  gen: 0,
  totalAttempts: 0,
  wordAttempts: 0,
  errors: {},
  statusById: {},
  returnTargetId: null,
  practiceOriginId: null,
  practiceIds: [],
  streak: 0,
  combo: 0,
  runXp: 0,
  bestHp: {},
  fontDelta: 0,
  badge: { text: "", tone: "c-dim" },
  resultStyle: "idle",
  feedback: { text: "", tone: "c-muted" },
  units: { list: [], clickable: false },
  coach: { mode: "hidden", text: "" },
  flash: "",
  flashGen: 0,
  xp: null,
  showSettings: false,
  paragraph: "",
});

const INPUT_HELP =
  "Pegá un párrafo (oraciones separadas por “.” o saltos de línea) y apretá Shift+Enter.";

const keyLabel = (action: keyof typeof KEYS): string => KEYS[action].toUpperCase();

export default function PronunciationTetris() {
  const g = useRef<G | null>(null);
  if (g.current === null) g.current = initialG();
  const G = g.current;
  const [, force] = useReducer((x: number) => x + 1, 0);
  const rerender = () => force();

  // ------------------------------------------------------------- helpers
  const current = (): Target | null => G.targets[G.index] ?? null;
  const hasGame = (): boolean => G.targets.length > 0;
  const scorer = () => new Scorer(G.settings);
  const coach = () => new Coach(G.settings);

  const curErrors = (): Record<string, number> => {
    const t = current();
    if (!t) return {};
    return (G.errors[t.id] ??= {});
  };

  const worstWords = (): Array<[string, number]> =>
    Object.entries(curErrors()).sort((a, b) => b[1] - a[1]);

  const bossIndex = (): number | null => {
    const i = G.targets.findIndex((t) => t.kind === "boss");
    return i >= 0 ? i : null;
  };

  const scoreTone = (score: number): Tone => {
    if (score >= G.settings.passThreshold) return "c-green";
    if (score >= 40) return "c-amber";
    return "c-red";
  };

  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (color: "green" | "red") => {
    G.flash = color;
    G.flashGen += 1;
    const gen = G.flashGen;
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      if (G.flashGen === gen) {
        G.flash = "";
        rerender();
      }
    }, 450);
    rerender();
  };

  const xpFlash = (amount: number) => {
    const gen = (G.xp?.gen ?? 0) + 1;
    G.xp = { amount, gen };
    setTimeout(() => {
      if (G.xp?.gen === gen) {
        G.xp = null;
        rerender();
      }
    }, 900);
  };

  const setFeedback = (text: string, tone: Tone = "c-muted") => {
    G.feedback = { text, tone };
  };
  const setBadge = (text: string, tone: Tone, live = false) => {
    G.badge = { text, tone, live };
  };
  const clearUnits = () => {
    G.units = { list: [], clickable: false };
  };
  const coachClear = () => {
    G.coach = { mode: "hidden", text: "" };
  };

  // ---------------------------------------------------------- pantallas
  const showInput = () => {
    G.screen = "input";
    G.targets = [];
    G.index = 0;
    setBadge("", "c-dim");
    G.resultStyle = "idle";
    clearUnits();
    coachClear();
    setFeedback(INPUT_HELP, "c-muted");
    G.paragraph = "";
    rerender();
  };

  const reset = () => {
    // Botón de pánico: descarta el juego. gen++ invalida cualquier trabajo
    // async en curso (assessment/TTS/consejo que llegue tarde se descarta).
    G.busy = false;
    G.busyLabel = null;
    G.lastAudioUrl = null;
    G.gen += 1;
    showInput();
  };

  const cleanupPractice = () => {
    const cur = current();
    const ids = new Set(G.practiceIds);
    G.targets = G.targets.filter((t) => !ids.has(t.id));
    G.index = Math.max(0, G.targets.findIndex((t) => t.id === cur?.id));
    G.practiceOriginId = null;
    G.practiceIds = [];
  };

  const enterReady = () => {
    G.screen = "ready";
    // Si salimos de las palabras de práctica, las quitamos para no ensuciar.
    const cur = current();
    if (G.practiceIds.length > 0 && cur && !G.practiceIds.includes(cur.id)) {
      cleanupPractice();
    }
    G.gen += 1; // invalida consejos/resultados viejos
    G.wordAttempts = 0;
    G.lastAudioUrl = null; // la grabación del objetivo anterior ya no aplica
    setBadge("", "c-dim");
    G.resultStyle = "idle";
    clearUnits();
    coachClear();
    setFeedback("", "c-muted");
    rerender();
  };

  const beginGame = (sentences: string[]) => {
    G.busy = false;
    G.totalAttempts = 0;
    G.errors = {};
    G.statusById = {};
    G.returnTargetId = null;
    G.practiceOriginId = null;
    G.practiceIds = [];
    // Cada párrafo es una corrida nueva: los contadores RPG arrancan de cero.
    G.streak = 0;
    G.combo = 0;
    G.runXp = 0;
    G.bestHp = {};
    G.targets = buildTargets(sentences);
    G.index = 0;
    enterReady();
  };

  const win = () => {
    G.screen = "win";
    // Único punto de escritura de la progresión: al ganar se persiste.
    G.stats = { ...G.stats, bestStreak: Math.max(G.stats.bestStreak, G.streak) };
    saveStats(G.stats);
    flash("green");
    setBadge("", "c-dim");
    G.resultStyle = "idle";
    clearUnits();
    coachClear();
    const xpLine = G.runXp > 0 ? `   ·   +${G.runXp} XP` : "";
    setFeedback(`Leíste todo el párrafo. ¡Crack!${xpLine}`, "c-muted");
    rerender();
  };

  // ------------------------------------------------------------- acciones
  const onStart = () => {
    if (G.busy || G.screen !== "input") return;
    if (!settingsReady(G.settings)) {
      G.showSettings = true;
      rerender();
      return;
    }
    const sentences = splitSentences(G.paragraph.trim());
    if (sentences.length === 0) return;
    G.micChosen = G.micSelected || undefined; // fijamos el mic elegido
    beginGame(sentences);
  };

  const advance = () => {
    G.index += 1;
    if (G.index >= G.targets.length) win();
    else enterReady();
  };

  const onSpace = () => {
    if (G.busy) return;
    if (G.screen === "input") return; // que el textarea maneje el espacio
    if (G.screen === "win") return showInput();
    if (G.screen === "pass") return advance();
    startRecording(); // ready o fail
  };

  const onPrimary = () => {
    if (G.screen === "input") onStart();
    else onSpace();
  };

  const setRecordingStatus = (code: StatusCode) => {
    const kind = current()?.kind ?? "word";
    const que =
      kind === "boss"
        ? "Leé TODO el párrafo (podés pausar entre oraciones)."
        : kind === "sentence"
          ? "Leé la oración completa, fuerte y claro."
          : "Decí la palabra UNA sola vez, fuerte y claro.";
    if (code === "listening") {
      // Estado ACTIVO -> acento azul. El verde queda reservado SOLO para PASS.
      setBadge("🟢  ¡HABLÁ AHORA!", "c-accent", true);
      setFeedback(que, "c-muted");
    } else if (code === "speech") {
      setBadge("🎤  Te escucho…", "c-accent", true);
      setFeedback("Seguí. Callate al terminar para cerrar.", "c-muted");
    } else if (code === "processing") {
      setBadge("⏳  Procesando…", "c-amber");
      setFeedback("Listo, dejá que Azure analice.", "c-muted");
    }
    rerender();
  };

  const startRecording = () => {
    const t = current();
    if (!t) return;
    G.busy = true;
    G.screen = "recording";
    G.gen += 1; // nueva grabación: invalida el consejo del intento anterior
    const myGen = G.gen;
    G.totalAttempts += 1;
    G.wordAttempts += 1;
    clearUnits();
    coachClear();
    // Semáforo: el mic todavía se está conectando, NO hables aún.
    setBadge("⏳  Preparando micrófono…", "c-dim");
    G.resultStyle = "idle";
    setFeedback("Esperá la luz verde. Todavía NO hables.", "c-dim");
    rerender();

    scorer()
      .assess(t.reference, {
        onStatus: (code) => {
          if (G.gen === myGen && G.screen === "recording") setRecordingStatus(code);
        },
        deviceId: G.micChosen,
        longForm: isLongForm(t),
        continuous: isContinuous(t),
      })
      .then((a) => {
        if (G.gen !== myGen || !hasGame() || G.screen === "input") return;
        onAssessment(a);
      });
  };

  const failHint = (a: Assessment, multiword: boolean): string => {
    if (multiword) {
      const weak = weakWords(a, G.settings.passThreshold);
      if (weak.length === 0) {
        return `Casi. Completaste ${a.completeness.toFixed(0)}%, fluidez ${a.fluency.toFixed(0)}%.`;
      }
      const partes = weak
        .map((w) => `${w.word} ${w.accuracy.toFixed(0)}%`)
        .join("  ");
      return `Palabras a mejorar:  ${partes}   ·   🔊 clic en una para oírla`;
    }
    const phons = a.words[0]?.phonemes ?? [];
    if (phons.length === 0) return "Casi. Afiná un poquito y de nuevo.";
    const worst = phons.reduce((x, y) => (y.accuracy < x.accuracy ? y : x));
    const base = `Enfocate en [${worst.phoneme}] (${worst.accuracy.toFixed(0)}%)`;
    const tip = phonemeHint(worst.phoneme);
    return tip ? `${base}: ${tip}` : base;
  };

  const requestTip = (a: Assessment) => {
    const t = current();
    if (!t) return;
    const phonemes: Array<[string, number]> = (a.words[0]?.phonemes ?? []).map(
      (p) => [p.phoneme, p.accuracy],
    );
    const myGen = G.gen; // si cambia el contexto antes de que llegue, se descarta
    coach()
      .tip(
        t.reference,
        phonemes,
        a.recognizedText,
        G.wordAttempts,
        G.totalAttempts,
        G.settings.cefrLevel,
      )
      .then((tip) => {
        if (myGen !== G.gen || G.screen !== "fail") return;
        G.coach = tip ? { mode: "shown", text: tip } : { mode: "hidden", text: "" };
        rerender();
      });
  };

  const onAssessment = (a: Assessment) => {
    G.busy = false;
    const t = current();
    if (!t) return;
    G.lastAudioUrl = a.audioUrl; // tu grabación, para reproducir con D

    if (!assessmentOk(a)) {
      G.screen = "fail";
      G.streak = 0; // un fallo corta la racha y el combo
      G.combo = 0;
      G.statusById[t.id] = "failed"; // intentado, no derrotado
      setBadge("✕  —", "c-red");
      G.resultStyle = "fail-red";
      clearUnits();
      coachClear();
      setFeedback(a.error ?? "Algo salió mal.", "c-muted");
      rerender();
      return;
    }

    const heard = a.recognizedText ? `escuché: “${a.recognizedText}”` : "";
    const multiword = isMultiword(t);
    const threshold = G.settings.passThreshold;

    // Desglose: por palabra (oración/párrafo) o por fonema (palabra suelta).
    let units: Array<[string, number]>;
    if (multiword) {
      units = a.words.map((w) => [w.word, w.accuracy]);
      // Contador de errores por palabra: +1 a las que no llegan al umbral; las
      // que SÍ llegan salen de la lista (ya las dominás). Base del modo R.
      const errs = curErrors();
      for (const [label, score] of units) {
        if (score < threshold) errs[label] = (errs[label] ?? 0) + 1;
        else delete errs[label];
      }
      // Combo: palabras PERFECTAS seguidas (>= max(umbral, 97)), cruza intentos.
      const perfectBar = Math.max(threshold, 97);
      for (const [, score] of units) {
        G.combo = score >= perfectBar ? G.combo + 1 : 0;
      }
    } else {
      units = (a.words[0]?.phonemes ?? []).map((p) => [p.phoneme, p.accuracy]);
    }

    // El JEFE no muestra el muro de tiles de TODAS las palabras: solo los
    // puntos débiles. `units` completo se conserva para el juicio y el combo.
    let displayUnits = units;
    if (t.kind === "boss") {
      displayUnits = units.filter(([, s]) => s < threshold);
    }
    G.units = { list: displayUnits, clickable: multiword };

    // HP del objetivo = mejor accuracy lograda.
    G.bestHp[t.id] = Math.max(G.bestHp[t.id] ?? 0, a.accuracy);

    // Regla de aprobado (dominio puro en scoring.ts).
    const recognizedOk = normalizeText(a.recognizedText) === normalizeText(t.reference);
    const verdict = judge(units, {
      accuracy: a.accuracy,
      recognizedOk,
      threshold,
      nearMissMargin: G.settings.nearMissMargin,
    });

    // Capturamos el estado PREVIO: distingue una derrota nueva (da XP) de
    // re-pasar algo ya derrotado (no farmea).
    const prevStatus = G.statusById[t.id];
    G.statusById[t.id] = verdict.passed ? "defeated" : "failed";

    if (verdict.passed) {
      G.screen = "pass";
      G.streak += 1;
      G.stats = { ...G.stats, bestStreak: Math.max(G.stats.bestStreak, G.streak) };
      if (prevStatus !== "defeated") {
        G.runXp += XP_PER_DEFEAT;
        G.stats = recordDefeat(G.stats, a.accuracy, XP_PER_DEFEAT);
        xpFlash(XP_PER_DEFEAT);
      }
      flash("green");
      setBadge(`✅  ${a.accuracy.toFixed(0)}%  ¡DERROTADA!`, "c-green");
      G.resultStyle = "pass";
      if (verdict.byRecognition) {
        setFeedback(
          `Cerca (≥ ${(threshold - G.settings.nearMissMargin).toFixed(0)}%) y te entendí perfecto. ✓  ${heard}`.trim(),
        );
      } else {
        setFeedback(`Todos los sonidos ≥ ${threshold.toFixed(0)}%.  ${heard}`.trim());
      }
      coachClear();
    } else {
      G.screen = "fail";
      G.streak = 0;
      G.combo = 0;
      flash("red");
      // Parcial (>= 40) -> ámbar; lejos (< 40) -> rojo.
      const worstScore = verdict.worstLabel !== null ? verdict.worstScore : a.accuracy;
      const partial = worstScore >= 40;
      G.resultStyle = partial ? "fail-amber" : "fail-red";
      const icon = partial ? "⚠" : "✕";
      const tone: Tone = partial ? "c-amber" : "c-red";
      if (verdict.worstLabel !== null) {
        setBadge(
          `${icon}  [${verdict.worstLabel}] ${verdict.worstScore.toFixed(0)}%  ·  faltan sonidos`,
          tone,
        );
      } else {
        setBadge(`${icon}  ${a.accuracy.toFixed(0)}%`, tone);
      }
      const tip = failHint(a, multiword);
      setFeedback(tip + (heard ? `   ·   ${heard}` : ""));
      // Consejo de DeepSeek: solo en palabras sueltas (drill), a nivel fonema.
      if (coach().available && !multiword) {
        G.coach = { mode: "loading", text: "" };
        requestTip(a);
      } else {
        coachClear();
      }
    }
    rerender();
  };

  const startTts = (text: string) => {
    G.busy = true;
    G.busyLabel = "🔊 Reproduciendo…";
    rerender();
    scorer()
      .speak(text)
      .then((err) => {
        G.busy = false;
        G.busyLabel = null;
        if (G.screen === "input") return rerender(); // se reseteó: no pisar
        if (err) setFeedback(err, "c-red");
        rerender();
      });
  };

  const onRepeat = () => {
    const t = current();
    if (G.busy || G.screen === "input" || G.screen === "win" || !t) return;
    startTts(t.reference);
  };

  const onWordClick = (word: string) => {
    if (G.busy || !hasGame()) return;
    startTts(word);
  };

  const onPlayMine = () => {
    if (G.busy || G.screen === "input" || G.screen === "win" || !hasGame()) return;
    if (!G.lastAudioUrl) {
      const msg =
        G.screen === "fail" || G.screen === "pass"
          ? "Grabaste, pero no pude guardar el audio de ese micrófono."
          : "Todavía no grabaste nada. Apretá ESPACIO y hablá.";
      setFeedback(msg, "c-dim");
      rerender();
      return;
    }
    G.busy = true;
    G.busyLabel = "🔊 Reproduciendo TU voz…";
    rerender();
    playRecording(G.lastAudioUrl).then((err) => {
      G.busy = false;
      G.busyLabel = null;
      if (err && G.screen !== "input") setFeedback(String(err), "c-red");
      rerender();
    });
  };

  const onRetry = () => {
    if (G.busy || !hasGame()) return;
    if (G.screen !== "ready" && G.screen !== "fail" && G.screen !== "pass") return;
    startRecording();
  };

  const actionable = (): boolean =>
    !G.busy &&
    hasGame() &&
    (G.screen === "ready" || G.screen === "fail" || G.screen === "pass");

  const onClearErrors = () => {
    const t = current();
    if (!actionable() || !t) return;
    G.errors[t.id] = {};
    setFeedback("🧹 Lista de práctica reiniciada.", "c-dim");
    rerender();
  };

  const onSkipToBoss = () => {
    // A es un TOGGLE: si no estás en el jefe, vas al jefe (recordando de
    // dónde); si ya estás, volvés a ese objetivo (o a la 1ra oración).
    if (!actionable()) return;
    const bossIdx = bossIndex();
    if (bossIdx === null) return; // párrafo de una sola oración
    const t = current()!;
    if (t.kind === "boss") {
      const back = G.targets.findIndex((x) => x.id === G.returnTargetId);
      G.returnTargetId = null;
      G.index = back >= 0 ? back : 0;
    } else {
      G.returnTargetId = t.id;
      G.index = bossIdx;
    }
    enterReady();
  };

  const navigate = (forward: boolean) => {
    if (!actionable()) return;
    const multiwordIdx = G.targets
      .map((t, i) => [t, i] as const)
      .filter(([t]) => isMultiword(t))
      .map(([, i]) => i);
    const candidates = forward
      ? multiwordIdx.filter((i) => i > G.index)
      : multiwordIdx.filter((i) => i < G.index);
    if (candidates.length === 0) return;
    G.index = forward ? candidates[0]! : candidates[candidates.length - 1]!;
    enterReady();
  };

  const onPracticeWorst = () => {
    // R: entrar/salir del modo práctica.
    if (!actionable()) return;
    const t = current()!;
    // Si ya estoy drilleando (palabra) -> salir a la oración de origen.
    if (t.kind === "word" && G.practiceOriginId !== null) {
      const idx = G.targets.findIndex((x) => x.id === G.practiceOriginId);
      if (idx >= 0) G.index = idx;
      enterReady(); // al volver al origen, enterReady limpia
      return;
    }
    if (!isMultiword(t)) return;
    const worst = worstWords().map(([w]) => w);
    if (worst.length === 0) {
      setFeedback("No hay palabras para practicar acá. Leé la oración primero.", "c-dim");
      rerender();
      return;
    }
    // Insertamos las palabras a practicar JUSTO antes del objetivo actual.
    const practice = worst.map(makeWord);
    G.practiceOriginId = t.id;
    G.practiceIds = practice.map((p) => p.id);
    G.targets = [
      ...G.targets.slice(0, G.index),
      ...practice,
      ...G.targets.slice(G.index),
    ];
    enterReady();
  };

  const refreshMics = () => {
    listMicrophones().then((options) => {
      G.micOptions = options;
      rerender();
    });
  };

  const onMicTest = () => {
    if (G.busy || G.screen !== "input") return;
    G.busy = true;
    setFeedback("🎙 Grabando 3 segundos… ¡decí algo!", "c-accent");
    rerender();
    recordTest(G.micSelected || undefined, 3).then(async ({ url, error }) => {
      refreshMics(); // el permiso recién dado desbloquea los nombres de mics
      if (error || !url) {
        G.busy = false;
        setFeedback(`❌ ${error ?? "No se pudo grabar."}`, "c-red");
        rerender();
        return;
      }
      if (G.screen === "input") {
        setFeedback("🔊 Reproduciendo lo que grabaste… ¿te escuchás?", "c-accent");
        rerender();
      }
      const playErr = await playRecording(url);
      G.busy = false;
      if (G.screen !== "input") return rerender();
      if (playErr) setFeedback(`❌ ${playErr}`, "c-red");
      else {
        setFeedback(
          "✅ ¿Te escuchaste? El micrófono ANDA. Escribí tu párrafo y Shift+Enter.",
          "c-green",
        );
      }
      rerender();
    });
  };

  /** Imagen -> OCR -> limpieza -> oraciones (coach LLM si hay key, si no
   * Intl.Segmenter). El resultado cae al textarea UNA oración por línea, así
   * ves los sub-jefes y corregís lo que el OCR haya inventado antes de jugar. */
  const importImage = (file: File | Blob | null | undefined) => {
    if (!file || G.busy || G.screen !== "input") return;
    G.busy = true;
    setFeedback("🔍 Leyendo la imagen… 0%", "c-accent");
    rerender();
    extractTextFromImage(file, (pct) => {
      if (G.screen !== "input") return;
      setFeedback(`🔍 Leyendo la imagen… ${pct}%`, "c-accent");
      rerender();
    }).then(async ({ text, error }) => {
      if (G.screen !== "input") {
        G.busy = false;
        return rerender(); // se fue de la pantalla inicial: descartar
      }
      if (error || !text) {
        G.busy = false;
        setFeedback(`❌ ${error ?? "No encontré texto en la imagen."}`, "c-red");
        return rerender();
      }
      const cleaned = cleanOcrText(text);
      // Vía inteligente: el coach (DeepSeek) corrige errores de OCR y separa
      // oraciones. Opcional y sin regresión: si falla, heurística local.
      let sentences: string[] | null = null;
      if (coach().available && cleaned) {
        setFeedback("🧠 Puliendo el texto con el coach…", "c-accent");
        rerender();
        sentences = await coach().smartSplit(cleaned);
      }
      if (!sentences || sentences.length === 0) sentences = splitSentences(cleaned);
      G.busy = false;
      if (sentences.length === 0) {
        setFeedback("❌ No encontré oraciones legibles en la imagen.", "c-red");
        return rerender();
      }
      G.paragraph = sentences.join("\n");
      const n = sentences.length;
      setFeedback(
        n > 1
          ? `✅ Extraje ${n} oraciones → ${n} sub-jefes + 1 jefe final. Revisá cada línea (el OCR a veces inventa) y Shift+Enter.`
          : "✅ Extraje 1 oración. Revisala y Shift+Enter.",
        "c-green",
      );
      rerender();
    });
  };

  const bumpFont = (step: number) => {
    // No actúa en la pantalla inicial: ahí P/L son letras que estás tipeando.
    if (!hasGame() || G.screen === "input") return;
    G.fontDelta = Math.max(-6, Math.min(16, G.fontDelta + step));
    rerender();
  };

  // ------------------------------------------------------------- teclado
  const handleKey = (e: KeyboardEvent) => {
    if (G.showSettings) {
      if (e.key === "Escape") {
        G.showSettings = false;
        rerender();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
      e.preventDefault(); // Ctrl+R es NUESTRO reset, no recargar la página
      reset();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t") {
      e.preventDefault();
      onMicTest();
      return;
    }
    const el = e.target as HTMLElement | null;
    const typing =
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement;
    if (typing) {
      // Shift+Enter en el textarea empieza; el resto lo maneja el propio input.
      if (e.key === "Enter" && e.shiftKey && el instanceof HTMLTextAreaElement) {
        e.preventDefault();
        onStart();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") return reset();
    if (e.key === " ") {
      e.preventDefault(); // que no scrollee ni re-dispare un botón enfocado
      onSpace();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === KEYS.correct) onRepeat();
    else if (k === KEYS.mine) onPlayMine();
    else if (k === KEYS.retry) onRetry();
    else if (k === KEYS.boss) onSkipToBoss();
    else if (k === KEYS.practice) onPracticeWorst();
    else if (k === KEYS.clear) onClearErrors();
    else if (k === KEYS.prev) navigate(false);
    else if (k === KEYS.next) navigate(true);
    else if (k === KEYS.fontUp) bumpFont(+2);
    else if (k === KEYS.fontDown) bumpFont(-2);
  };

  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    G.settings = loadSettings();
    G.stats = loadStats();
    setFeedback(INPUT_HELP, "c-muted");
    rerender();
    refreshMics();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshMics);
    const onKeyDown = (e: KeyboardEvent) => handleKeyRef.current(e);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshMics);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------ derivados
  const t = current();

  const ctaText = (): string => {
    if (G.busyLabel) return G.busyLabel;
    switch (G.screen) {
      case "input": return "▷  Empezar";
      case "win": return "↻  Otra vez";
      case "recording": return "🎙 Escuchando…";
      case "pass": return "➡  Siguiente";
      case "fail": return "🎤  Reintentar";
      default: return "🎤  Hablar ahora";
    }
  };

  /** Pills de acción según el estado/objetivo: lista de (tecla, etiqueta). */
  const keysLine = (): Array<[string, string]> => {
    if (t && t.kind === "word") {
      const items: Array<[string, string]> = [
        [keyLabel("retry"), "reintentar"],
        [keyLabel("mine"), "tu voz"],
        [keyLabel("correct"), "la correcta"],
      ];
      if (G.practiceOriginId !== null) {
        items.push([keyLabel("practice"), "salir de práctica"]);
      }
      items.push([`${keyLabel("prev")}/${keyLabel("next")}`, "◀ ▶ navegar"]);
      return items;
    }
    const hasErrors = t !== null && isMultiword(t) && worstWords().length > 0;
    const items: Array<[string, string]> = [];
    if (t && bossIndex() !== null) {
      items.push([keyLabel("boss"), t.kind === "boss" ? "volver" : "ir al jefe"]);
    }
    items.push([keyLabel("retry"), "reintentar"]);
    items.push([keyLabel("mine"), "tu voz"]);
    items.push([keyLabel("correct"), "la correcta"]);
    if (hasErrors) {
      items.push([keyLabel("practice"), "practicar"]);
      items.push([keyLabel("clear"), "limpiar práctica"]);
    }
    items.push([`${keyLabel("prev")}/${keyLabel("next")}`, "◀ ▶ navegar"]);
    return items;
  };

  const systemPills: Array<[string, string]> = [
    [`${keyLabel("fontUp")}/${keyLabel("fontDown")}`, "fuente"],
    ["Ctrl+R", "reset"],
    ["Esc", "reset"],
  ];

  const actionPills: Array<[string, string]> =
    G.screen === "input" || G.screen === "win" || G.screen === "recording"
      ? []
      : keysLine();

  /** Renglón bajo la barra: palabras A MEJORAR del objetivo, o la próxima. */
  const statusLine = (): { text: string; dim: boolean } => {
    if (!t || G.screen === "win") return { text: "", dim: true };
    const worst = isMultiword(t) ? worstWords() : [];
    if (worst.length > 0) {
      if (t.kind === "boss") {
        const resumen = worst
          .slice(0, 8)
          .map(([w, c]) => `${w}×${c}`)
          .join("  |  ");
        return { text: `Puntos débiles:  ${resumen}`, dim: false };
      }
      const lines = worst
        .slice(0, 6)
        .map(([w, c], i) => `  ${i + 1}. ${w}  ×${c}`)
        .join("\n");
      return { text: `A practicar (${keyLabel("practice")}):\n${lines}`, dim: false };
    }
    const nxt = G.targets[G.index + 1] ?? null;
    if (nxt === null) return { text: "¡Último objetivo!", dim: true };
    if (nxt.kind === "boss") {
      return { text: "Próxima:  👑 EL JEFE (todo el párrafo)", dim: true };
    }
    if (nxt.kind === "word") return { text: `Próxima:  ${nxt.label}`, dim: true };
    return { text: "", dim: true };
  };

  /** Tamaño de la card de lectura según tipo+largo, con el zoom P/L sumado. */
  const targetFontSize = (target: Target): number => {
    let base: number;
    let floor: number;
    if (target.kind === "boss") {
      base = target.label.length > 220 ? 17 : 19;
      floor = 11;
    } else if (target.kind === "sentence") {
      base = target.label.length > 90 ? 16 : 18;
      floor = 11;
    } else {
      base = 30;
      floor = 14;
    }
    return Math.max(floor, base + G.fontDelta);
  };

  /** Escalas del grid de tiles (espejo de _render_units). */
  const unitGrid = (n: number, clickable: boolean) => {
    if (!clickable) {
      if (n <= 7) return { font: 19, cols: Math.max(1, n) };
      if (n <= 14) return { font: 16, cols: 7 };
      return { font: 13, cols: 8 };
    }
    if (n <= 6) return { font: 14, cols: Math.max(1, n) };
    if (n <= 12) return { font: 13, cols: 6 };
    if (n <= 24) return { font: 12, cols: 8 };
    return { font: 11, cols: 9 };
  };

  const counterLabel = (): string => {
    if (!t) return "";
    const kindLabel =
      t.kind === "word"
        ? "Cola de práctica"
        : t.kind === "sentence"
          ? "Oración"
          : "👑 JEFE FINAL";
    return `${kindLabel}   ·   ${G.index + 1} / ${G.targets.length}`;
  };

  const chromeLine = (): string => {
    const parts: string[] = [];
    if (G.streak >= 2) parts.push(`Racha ${G.streak}`);
    if (G.combo >= 2) parts.push(`Combo x${G.combo}`);
    return parts.join("   ·   ");
  };

  const inGame = hasGame() && G.screen !== "input" && G.screen !== "win";
  const status = statusLine();
  const grid = unitGrid(G.units.list.length, G.units.clickable);
  const hp = t ? (G.bestHp[t.id] ?? 0) : 0;
  const ready = settingsReady(G.settings);

  // -------------------------------------------------------------- render
  return (
    <div className="pt-app">
      <div className={`pt-flash ${G.flash}`} />

      <div className="pt-topbar">
        <span className="pt-goal">
          🎯 objetivo: {G.settings.passThreshold.toFixed(0)}% por sonido
        </span>
        <button
          className="pt-gear"
          title="Ajustes"
          onClick={() => {
            G.showSettings = true;
            rerender();
          }}
        >
          ⚙
        </button>
      </div>

      <div className="pt-content">
        {/* barra tipo Tetris: un segmento por objetivo */}
        {inGame && (
          <div className="pt-blocks">
            {G.targets.map((target, i) => {
              const st = G.statusById[target.id];
              let color =
                st === "defeated"
                  ? "var(--accent)"
                  : st === "failed"
                    ? "var(--red)"
                    : "var(--surface2)";
              const isCurrent = i === G.index;
              if (isCurrent && !st) color = "var(--accent-hover)";
              if (target.kind === "boss" && !st) color = "var(--amber)";
              const segW = Math.max(16, Math.floor(480 / G.targets.length));
              return (
                <span key={target.id} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                  <span
                    className={`pt-block${isCurrent ? " current" : ""}`}
                    style={{ width: segW, background: color }}
                  />
                  {target.kind === "boss" && <span className="pt-crown">👑</span>}
                </span>
              );
            })}
          </div>
        )}

        {inGame && <div className="pt-counter">{counterLabel()}</div>}

        {/* card de lectura / título / trofeo */}
        <div
          className={`pt-target-card${t?.kind === "boss" && inGame ? " boss" : ""}${G.screen === "win" ? " win" : ""}`}
        >
          <span className="pt-accent-bar" />
          {G.screen === "input" && (
            <p className="pt-target-text hero centered" style={{ fontSize: 26 }}>
              Pronunciation Tetris
            </p>
          )}
          {G.screen === "win" && (
            <p className="pt-target-text trophy centered" style={{ fontSize: 24 }}>
              🏆 ¡GANASTE!
            </p>
          )}
          {inGame && t && (
            <p
              className={`pt-target-text${t.kind === "word" ? " word centered" : ""}`}
              style={{ fontSize: targetFontSize(t) }}
            >
              {t.label}
            </p>
          )}
        </div>

        {/* barra de HP / dominio (solo oración/jefe) */}
        {inGame && t && isMultiword(t) && (
          <div className="pt-hp">
            <div
              style={{
                width: `${Math.max(0, Math.min(100, hp))}%`,
                background: `var(--${scoreTone(hp).slice(2)})`,
              }}
            />
          </div>
        )}

        {/* pantalla inicial: stats + setup + entrada + mic */}
        {G.screen === "input" && (
          <>
            <div className="pt-start-stats">
              Level {statsLevel(G.stats)}
              {G.stats.accuracyCount > 0 &&
                `   ·   Accuracy ${statsAccuracy(G.stats).toFixed(0)}%`}
            </div>
            {!ready && (
              <div className="pt-setup-card">
                <b>Faltan credenciales de Azure.</b> Abrí ⚙ Ajustes y completá
                tu <code>AZURE_SPEECH_KEY</code> y región. La key se guarda solo
                en tu navegador (localStorage): no hay servidor en el medio.
              </div>
            )}
            <textarea
              className="pt-entry"
              value={G.paragraph}
              placeholder="Pegá acá tu párrafo en inglés… (o una captura con Ctrl+V)"
              onChange={(e) => {
                G.paragraph = e.target.value;
                rerender();
              }}
              onPaste={(e) => {
                const item = Array.from(e.clipboardData.items).find((i) =>
                  i.type.startsWith("image/"),
                );
                if (item) {
                  e.preventDefault();
                  importImage(item.getAsFile());
                }
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                const file = e.dataTransfer.files?.[0];
                if (file && file.type.startsWith("image/")) {
                  e.preventDefault();
                  importImage(file);
                }
              }}
              autoFocus
            />
            <div className="pt-image-row">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  importImage(e.target.files?.[0]);
                  e.target.value = ""; // permite re-elegir la misma imagen
                }}
              />
              <button
                className="pt-mic-test"
                onClick={() => fileInputRef.current?.click()}
                disabled={G.busy}
              >
                🖼 Leer de una imagen
              </button>
              <span className="pt-image-hint">
                o pegá / arrastrá una captura sobre el cuadro de texto
              </span>
            </div>
            <div className="pt-mic-row">
              <span style={{ color: "var(--dim)" }}>🎙</span>
              <select
                value={G.micSelected}
                onChange={(e) => {
                  G.micSelected = e.target.value;
                  rerender();
                }}
                onFocus={refreshMics}
              >
                {G.micOptions.map((option) => (
                  <option key={option.deviceId ?? ""} value={option.deviceId ?? ""}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button className="pt-mic-test" onClick={onMicTest} disabled={G.busy}>
                🎧 Probar
              </button>
            </div>
          </>
        )}

        {/* status line: a practicar / próxima */}
        {inGame && status.text && (
          <div className={`pt-incoming${status.dim ? " dim" : ""}`}>{status.text}</div>
        )}

        {/* banner de resultado: badge + feedback */}
        <div className={`pt-result ${G.resultStyle !== "idle" ? G.resultStyle : ""}`}>
          <div className={`pt-badge ${G.badge.tone}${G.badge.live ? " live" : ""}`}>
            {G.badge.text}
          </div>
          <div
            className={`pt-feedback ${G.feedback.tone}`}
            style={{ fontSize: Math.max(11, 14 + G.fontDelta) }}
          >
            {G.feedback.text}
          </div>
        </div>

        {/* racha / combo + flash de XP */}
        {inGame && chromeLine() && <div className="pt-chrome">{chromeLine()}</div>}
        {G.xp && (
          <div key={G.xp.gen} className="pt-xp">
            +{G.xp.amount} XP
          </div>
        )}

        {/* desglose por fonema / palabra */}
        {G.units.list.length > 0 && (
          <div
            className="pt-units"
            style={{ gridTemplateColumns: `repeat(${grid.cols}, auto)` }}
          >
            {G.units.list.map(([label, score], i) => {
              const cls =
                score >= G.settings.passThreshold ? "" : score >= 40 ? " warn" : " bad";
              return (
                <div
                  key={`${label}-${i}`}
                  className={`pt-unit${cls}${G.units.clickable ? " clickable" : ""}`}
                  style={{ animationDelay: `${Math.min(i * 18, 400)}ms` }}
                  onClick={G.units.clickable ? () => onWordClick(label) : undefined}
                  title={G.units.clickable ? "🔊 clic para oírla" : undefined}
                >
                  <span className="u-label" style={{ fontSize: grid.font }}>
                    {label}
                  </span>
                  <span className={`u-score ${scoreTone(score)}`}>
                    {score.toFixed(0)}%
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* consejo del coach (DeepSeek) */}
        {G.coach.mode !== "hidden" && (
          <div className={`pt-coach${G.coach.mode === "shown" ? " shown" : ""}`}>
            {G.coach.mode === "loading" ? "🧠 pensando un consejo…" : `🧠  ${G.coach.text}`}
          </div>
        )}

        {/* CTA principal: misma acción que ESPACIO */}
        <button className="pt-cta" onClick={onPrimary} disabled={G.busy}>
          {ctaText()}
        </button>
      </div>

      {/* fila de pills (teclas) al pie */}
      <div className="pt-hints">
        {[...actionPills, ...systemPills].map(([key, label]) => (
          <span key={`${key}-${label}`} className="pt-pill">
            <kbd>{key}</kbd>
            <span>{label}</span>
          </span>
        ))}
      </div>

      {G.showSettings && (
        <SettingsModal
          settings={G.settings}
          onClose={() => {
            G.showSettings = false;
            rerender();
          }}
          onSave={(s) => {
            G.settings = s;
            saveSettings(s);
            G.showSettings = false;
            rerender();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- ajustes
function SettingsModal(props: {
  settings: Settings;
  onClose: () => void;
  onSave: (s: Settings) => void;
}) {
  const draft = useRef<Settings>({ ...props.settings });
  const [, force] = useReducer((x: number) => x + 1, 0);

  const field = (
    label: string,
    key: keyof Settings,
    opts: { type?: string; placeholder?: string } = {},
  ) => (
    <div className="pt-field">
      <label>{label}</label>
      <input
        type={opts.type ?? "text"}
        placeholder={opts.placeholder}
        value={String(draft.current[key])}
        onChange={(e) => {
          const value = e.target.value;
          const target = draft.current as unknown as Record<string, unknown>;
          target[key] = typeof props.settings[key] === "number" ? Number(value) || 0 : value;
          force();
        }}
      />
    </div>
  );

  return (
    <div className="pt-modal-backdrop" onClick={props.onClose}>
      <div className="pt-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Ajustes</h2>
        <p className="note">
          Todo se guarda SOLO en tu navegador (localStorage). El scoring usa
          Azure Pronunciation Assessment: necesitás una key de Speech (el tier
          F0 gratis alcanza).
        </p>
        <fieldset>
          <legend>Azure Speech (obligatorio)</legend>
          {field("AZURE_SPEECH_KEY", "speechKey", { type: "password", placeholder: "tu key de Azure Speech" })}
          {field("Región", "speechRegion", { placeholder: "p. ej. eastus" })}
          {field("Idioma", "targetLanguage")}
          {field("Voz TTS", "ttsVoice")}
          {field("Tono (pitch)", "ttsPitch", { placeholder: "0%, +10%, -15%…" })}
          {field("Velocidad (rate)", "ttsRate", { placeholder: "0%, -10%, slow…" })}
        </fieldset>
        <fieldset>
          <legend>Juego</legend>
          {field("Umbral de aprobado", "passThreshold", { type: "number" })}
          {field("Margen near-miss", "nearMissMargin", { type: "number" })}
          {field("Nivel CEFR", "cefrLevel", { placeholder: "A1…C2" })}
        </fieldset>
        <fieldset>
          <legend>Coach con IA (DeepSeek, opcional)</legend>
          {field("DEEPSEEK_API_KEY", "deepseekKey", { type: "password", placeholder: "vacío = pistas estáticas" })}
          {field("Modelo", "deepseekModel")}
          {field("Base URL", "deepseekBaseUrl")}
          <p className="note" style={{ marginTop: 10, marginBottom: 0 }}>
            Ojo: la API de DeepSeek puede bloquear pedidos desde el navegador
            (CORS). Si pasa, el juego cae solo a las pistas estáticas.
          </p>
        </fieldset>
        <div className="pt-modal-actions">
          <button className="pt-btn" onClick={props.onClose}>
            Cancelar
          </button>
          <button className="pt-btn primary" onClick={() => props.onSave({ ...draft.current })}>
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

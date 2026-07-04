/** Pronunciation Tetris — port web del juego de escritorio (app.py).
 *
 * Pantalla inicial "1d": párrafo o imagen como entrada (cards lado a lado) y
 * micrófono + prueba + Empezar en una misma barra.
 *
 * Juego/práctica "3b — Carril lateral" (tema claro): el centro es para la oración
 * con el feedback POR PALABRA inline (resaltado + score en superíndice); la
 * ruta del párrafo vive en un carril a la derecha (clic navega); las acciones
 * son botones visibles con su atajo de teclado como hint.
 *
 * Arquitectura: este componente es el equivalente de la clase App de tkinter.
 * Solo conoce los puertos (scorer/coach/audio/ocr/progress); nada de Azure acá.
 *
 * Modelo de concurrencia: donde el escritorio usaba hilos + queue + _poll,
 * acá alcanza con async/await (el SDK de JS no bloquea). Se conserva el
 * contador `gen` que invalida trabajo async viejo (un consejo del coach o un
 * assessment que llega después de un reset se descarta).
 *
 * Modo demo: con ?demo en la URL el scorer se reemplaza por un stub enlatado
 * (src/lib/demo.ts) — QA visual completo sin mic ni key de Azure.
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
import { alignWords, type Alignment } from "../lib/align";
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
import { createDemoScorer, type ScorerPort } from "../lib/demo";
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

/** ?demo en la URL: scorer de mentira para recorrer todo sin Azure. */
const DEMO =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("demo");
const demoScorer = createDemoScorer();

/** Estado mutable del juego (el "self" de la App de tkinter). Vive en un ref y
 * cada mutación pide un re-render: las acciones del teclado leen siempre el
 * estado vivo, sin closures viejas. */
interface G {
  settings: Settings;
  stats: LifetimeStats;
  screen: Screen;
  busy: boolean;
  /** override del texto del botón primario durante una operación (TTS, tu voz) */
  busyLabel: string | null;
  targets: Target[];
  index: number;
  lastAudioUrl: string | null;
  /** último resultado OK, para el feedback inline (null = sin desglose) */
  lastAssessment: Assessment | null;
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
  coach: { mode: "hidden" | "loading" | "shown"; text: string };
  flash: "" | "green" | "red";
  flashGen: number;
  xp: { amount: number; gen: number } | null;
  showSettings: boolean;
  /** drawer del carril en pantallas angostas */
  railOpen: boolean;
  paragraph: string;
  /** la última prueba de mic anduvo (chip "mic OK" en la barra inicial) */
  micOk: boolean;
  /** estado transitorio de la prueba de mic, mostrado EN la barra del mic */
  micMsg: UiText | null;
  /** estado del OCR (progreso/resultado), mostrado EN la card de imagen */
  ocrMsg: UiText | null;
  /** arrastrando una imagen sobre la dropzone */
  dropHover: boolean;
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
  lastAssessment: null,
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
  coach: { mode: "hidden", text: "" },
  flash: "",
  flashGen: 0,
  xp: null,
  showSettings: false,
  railOpen: false,
  paragraph: "",
  micOk: false,
  micMsg: null,
  ocrMsg: null,
  dropHover: false,
});

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
  const scorer = (): ScorerPort => (DEMO ? demoScorer : new Scorer(G.settings));
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
  const clearAssessment = () => {
    G.lastAssessment = null;
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
    clearAssessment();
    coachClear();
    setFeedback("", "c-muted"); // el layout inicial ya explica cómo empezar
    G.paragraph = "";
    G.railOpen = false;
    G.micMsg = null; // una prueba de mic vieja no aplica a la pantalla nueva
    G.ocrMsg = null;
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
    clearAssessment();
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
    clearAssessment();
    coachClear();
    const xpLine = G.runXp > 0 ? `   ·   +${G.runXp} XP` : "";
    setFeedback(`Leíste todo el párrafo. ¡Crack!${xpLine}`, "c-muted");
    rerender();
  };

  // ------------------------------------------------------------- acciones
  const onStart = () => {
    if (G.busy || G.screen !== "input") return;
    if (!DEMO && !settingsReady(G.settings)) {
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
      setBadge("●  ¡HABLÁ AHORA!", "c-accent", true);
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
    clearAssessment();
    coachClear();
    // Semáforo: el mic todavía se está conectando, NO hables aún.
    setBadge("⏳  Preparando micrófono…", "c-dim");
    G.resultStyle = "idle";
    setFeedback("Esperá la luz azul. Todavía NO hables.", "c-dim");
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
      // El desglose vive INLINE en la oración; acá solo el resumen.
      if (weakWords(a, G.settings.passThreshold).length === 0) {
        return `Casi. Completaste ${a.completeness.toFixed(0)}%, fluidez ${a.fluency.toFixed(0)}%.`;
      }
      return "Las resaltadas quedaron bajo el umbral: tocá una para oírla.";
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
      clearAssessment();
      coachClear();
      setFeedback(a.error ?? "Algo salió mal.", "c-muted");
      rerender();
      return;
    }

    const heard = a.recognizedText ? `escuché: “${a.recognizedText}”` : "";
    const multiword = isMultiword(t);
    const threshold = G.settings.passThreshold;
    G.lastAssessment = a; // alimenta el feedback inline (oración o fonemas)

    // Desglose para el JUICIO: por palabra (oración/párrafo) o por fonema.
    let units: Array<[string, number]>;
    if (multiword) {
      units = a.words.map((w) => [w.word, w.accuracy]);
      // Contador de errores por palabra: +1 a las que no llegan al umbral; las
      // que SÍ llegan salen de la lista (ya las dominás). Base del modo R.
      // Las INSERCIONES (dichas de más) no entran: no son palabras de la
      // oración, drillearlas no tiene sentido. Sí siguen contando para el
      // juicio (units), igual que en el escritorio.
      const errs = curErrors();
      for (const w of a.words) {
        if (w.errorType.includes("Insertion")) continue;
        if (w.accuracy < threshold) errs[w.word] = (errs[w.word] ?? 0) + 1;
        else delete errs[w.word];
      }
      // Combo: palabras PERFECTAS seguidas (>= max(umbral, 97)), cruza intentos.
      const perfectBar = Math.max(threshold, 97);
      for (const [, score] of units) {
        G.combo = score >= perfectBar ? G.combo + 1 : 0;
      }
    } else {
      units = (a.words[0]?.phonemes ?? []).map((p) => [p.phoneme, p.accuracy]);
    }

    // HP del objetivo = mejor accuracy lograda (se muestra en el carril).
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
          `${icon}  [${verdict.worstLabel}] ${verdict.worstScore.toFixed(0)}%`,
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
          : "Todavía no grabaste nada. Grabá primero y después escuchate.";
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

  /** Navegación directa desde el carril (clic en una fila). */
  const goToTarget = (id: number) => {
    if (!actionable()) return;
    const idx = G.targets.findIndex((x) => x.id === id);
    if (idx >= 0 && idx !== G.index) {
      G.index = idx;
      enterReady();
    }
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
    // Los mensajes van a G.micMsg: se muestran EN la barra del micrófono,
    // al lado del botón Probar (no en el feedback general de la pantalla).
    if (G.busy || G.screen !== "input") return;
    G.busy = true;
    G.micMsg = { text: "🎙 Grabando 3 segundos… ¡decí algo!", tone: "c-accent" };
    rerender();
    recordTest(G.micSelected || undefined, 3).then(async ({ url, error }) => {
      refreshMics(); // el permiso recién dado desbloquea los nombres de mics
      if (error || !url) {
        G.busy = false;
        G.micOk = false;
        G.micMsg = { text: `❌ ${error ?? "No se pudo grabar."}`, tone: "c-red" };
        rerender();
        return;
      }
      if (G.screen === "input") {
        G.micMsg = { text: "🔊 Reproduciendo… ¿te escuchás?", tone: "c-accent" };
        rerender();
      }
      const playErr = await playRecording(url);
      G.busy = false;
      if (G.screen !== "input") return rerender();
      if (playErr) {
        G.micOk = false;
        G.micMsg = { text: `❌ ${playErr}`, tone: "c-red" };
      } else {
        G.micOk = true; // el chip "✓ mic OK" queda como confirmación persistente
        G.micMsg = null;
      }
      rerender();
    });
  };

  /** Imagen -> OCR -> limpieza -> oraciones (coach LLM si hay key, si no
   * Intl.Segmenter). El resultado cae al textarea UNA oración por línea, así
   * ves los sub-jefes y corregís lo que el OCR haya inventado antes de jugar. */
  const importImage = (file: File | Blob | null | undefined) => {
    // Los mensajes van a G.ocrMsg: se muestran EN la card de imagen (la
    // dropzone), donde está pasando la acción — no en un feedback general.
    if (!file || G.busy || G.screen !== "input") return;
    G.busy = true;
    G.ocrMsg = { text: "🔍 Leyendo la imagen… 0%", tone: "c-accent" };
    rerender();
    extractTextFromImage(file, (pct) => {
      if (G.screen !== "input") return;
      G.ocrMsg = { text: `🔍 Leyendo la imagen… ${pct}%`, tone: "c-accent" };
      rerender();
    }).then(async ({ text, error }) => {
      if (G.screen !== "input") {
        G.busy = false;
        return rerender(); // se fue de la pantalla inicial: descartar
      }
      if (error || !text) {
        G.busy = false;
        G.ocrMsg = {
          text: `❌ ${error ?? "No encontré texto en la imagen."}`,
          tone: "c-red",
        };
        return rerender();
      }
      const cleaned = cleanOcrText(text);
      // Vía inteligente: el coach (DeepSeek) corrige errores de OCR y separa
      // oraciones. Opcional y sin regresión: si falla, heurística local.
      let sentences: string[] | null = null;
      if (coach().available && cleaned) {
        G.ocrMsg = { text: "🧠 Puliendo el texto con el coach…", tone: "c-accent" };
        rerender();
        sentences = await coach().smartSplit(cleaned);
      }
      if (!sentences || sentences.length === 0) sentences = splitSentences(cleaned);
      G.busy = false;
      if (sentences.length === 0) {
        G.ocrMsg = {
          text: "❌ No encontré oraciones legibles en la imagen.",
          tone: "c-red",
        };
        return rerender();
      }
      G.paragraph = sentences.join("\n");
      const n = sentences.length;
      G.ocrMsg = {
        text:
          n > 1
            ? `✅ Extraje ${n} oraciones → ${n} sub-jefes + 1 jefe final. Revisá el texto: el OCR a veces inventa.`
            : "✅ Extraje 1 oración. Revisala antes de empezar.",
        tone: "c-green",
      };
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
    if (G.railOpen) {
      // El drawer intercepta Escape ANTES del reset del juego.
      if (e.key === "Escape") {
        G.railOpen = false;
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
  const inGame = hasGame() && G.screen !== "input" && G.screen !== "win";
  const threshold = G.settings.passThreshold;

  /** Filas del carril: solo objetivos multiword (las palabras de drill no). */
  const rows = G.targets.filter(isMultiword);
  /** Fila activa: la actual, o la oración de ORIGEN si estamos drilleando. */
  const activeRailId =
    t === null ? null : isMultiword(t) ? t.id : G.practiceOriginId;

  /** Alineación para el feedback inline (solo con assessment y multiword). */
  const aligned: Alignment | null =
    t !== null && isMultiword(t) && G.lastAssessment !== null
      ? alignWords(t.reference, G.lastAssessment.words)
      : null;

  const tokClass = (score: number): string =>
    score >= threshold ? "" : score >= 80 ? " warn" : " bad";

  const metaLabel = (): string => {
    if (!t) return "";
    let base: string;
    if (t.kind === "boss") {
      base = "👑 Jefe final";
    } else if (t.kind === "word") {
      const i = G.practiceIds.indexOf(t.id);
      base =
        i >= 0
          ? `Práctica · palabra ${i + 1} de ${G.practiceIds.length}`
          : "Práctica";
    } else {
      const pos = rows.findIndex((r) => r.id === t.id) + 1;
      base = `Oración ${pos} de ${rows.length}`;
    }
    return `${base} · intento ${Math.max(1, G.wordAttempts)}`;
  };

  /** Chip ámbar: cuántas unidades quedaron bajo el umbral en el último intento. */
  const belowCount = (): number => {
    const a = G.lastAssessment;
    if (!a || !t || G.screen !== "fail") return 0;
    if (isMultiword(t)) {
      return a.words.filter(
        (w) => !w.errorType.includes("Insertion") && w.accuracy < threshold,
      ).length;
    }
    return (a.words[0]?.phonemes ?? []).filter((p) => p.accuracy < threshold).length;
  };

  const chromeLine = (): string => {
    const parts: string[] = [];
    if (G.streak >= 2) parts.push(`Racha ${G.streak}`);
    if (G.combo >= 2) parts.push(`Combo x${G.combo}`);
    return parts.join(" · ");
  };

  /** Tamaño base de la oración según tipo/largo + zoom P/L. */
  const sentenceFontSize = (): number => {
    if (!t) return 24;
    let base: number;
    let floor: number;
    if (t.kind === "boss") {
      base = t.label.length > 220 ? 18 : 21;
      floor = 12;
    } else {
      base = t.label.length > 90 ? 22 : 26;
      floor = 12;
    }
    return Math.max(floor, base + G.fontDelta);
  };

  const primaryLabel = (): string => {
    if (G.busyLabel) return G.busyLabel;
    switch (G.screen) {
      case "pass": return "➡  Siguiente";
      case "fail": return "🎤  Reintentar";
      default: return "🎤  Hablar ahora";
    }
  };

  const railRows = (drawer: boolean) => (
    <>
      <div className="pt-rail-h">Párrafo</div>
      {rows.map((target) => {
        const st = G.statusById[target.id];
        const active = target.id === activeRailId;
        const cls = [
          "pt-row",
          active ? "active" : "",
          st === "defeated" ? "done" : st === "failed" ? "failed" : "upcoming",
          target.kind === "boss" ? "boss" : "",
          !actionable() && !active ? "blocked" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const mark = active
          ? "▸"
          : st === "defeated"
            ? "✓"
            : st === "failed"
              ? "✗"
              : target.kind === "boss"
                ? "👑"
                : "○";
        const score = G.bestHp[target.id];
        const note = !active
          ? null
          : t?.kind === "word"
            ? `practicando: ${t.label}`
            : G.wordAttempts >= 1
              ? `${G.wordAttempts} intento${G.wordAttempts > 1 ? "s" : ""}`
              : null;
        return (
          <button
            key={target.id}
            className={cls}
            tabIndex={-1}
            onClick={() => {
              goToTarget(target.id);
              if (drawer) G.railOpen = false;
              rerender();
            }}
          >
            <span className="row-mark">{mark}</span>
            <span className="row-text">
              {target.kind === "boss"
                ? "Jefe final — el párrafo completo, de corrido"
                : target.label}
              {note && <span className="row-note">{note}</span>}
            </span>
            {score !== undefined && score > 0 && (
              <span className="row-score">{score.toFixed(0)}</span>
            )}
          </button>
        );
      })}
    </>
  );

  const gameFooter = `Atajos: Espacio grabar · ${keyLabel("correct")} oración · ${keyLabel("mine")} tu voz · ${keyLabel("retry")} reintentar · ${keyLabel("practice")} practicar · ${keyLabel("clear")} limpiar · ${keyLabel("boss")} jefe · ${keyLabel("prev")}/${keyLabel("next")} navegar · ${keyLabel("fontUp")}/${keyLabel("fontDown")} fuente · Esc reset`;

  // -------------------------------------------------------------- render
  return (
    <div className="pt-app">
      <header className="pt-header">
        <div className="pt-brand">
          <span className="brand-dot" />
          Pronunciation Tetris
        </div>
        <div className="pt-header-right">
          {chromeLine() && <span className="pt-chip-subtle">{chromeLine()}</span>}
          {G.xp && (
            <span key={G.xp.gen} className="pt-xp">
              +{G.xp.amount} XP
            </span>
          )}
          <span className="pt-umbral">
            umbral <b>{threshold.toFixed(0)}%</b>
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
      </header>
      <div className={`pt-flash ${G.flash}`} />

      {/* ------------------------------------------------ pantalla inicial
          Eyebrow "NUEVA PARTIDA" + título a la izquierda, cards altas
          (párrafo | imagen) sobre una hoja blanca, y la barra del micrófono
          como franja inferior de página con "Empezar partida". Misma
          funcionalidad de siempre, solo cambia la composición. */}
      {G.screen === "input" && (
        <>
          <div className="pt-start-sheet">
            <div className="pt-start">
              {/* La progresión (nivel RPG por XP) solo se muestra si ya
                  jugaste: "Level 1" en frío se lee como un selector de
                  niveles que el juego no tiene. */}
              <div className="pt-eyebrow">
                Nueva partida
                {G.stats.targetsDefeated > 0 &&
                  ` · Jugador nivel ${statsLevel(G.stats)} · Precisión ${statsAccuracy(G.stats).toFixed(0)}%`}
              </div>
              <h1 className="pt-hero">¿Qué vas a pronunciar hoy?</h1>
              <p className="pt-hero-sub">
                Cada oración es un sub-jefe; el jefe final es el párrafo
                completo, de corrido.
              </p>
              {!DEMO && !settingsReady(G.settings) && (
                <div className="pt-setup-card">
                  <b>Faltan credenciales de Azure.</b> Abrí ⚙ Ajustes y completá
                  tu <code>AZURE_SPEECH_KEY</code> y región. La key se guarda
                  solo en tu navegador (localStorage): no hay servidor en el
                  medio.
                </div>
              )}

              <div className="pt-start-grid">
                {/* card izquierda: pegar/escribir el párrafo */}
                <div className="pt-card">
                  <div className="pt-card-label">≣ Pegá un párrafo</div>
                  <div className="pt-card-sub">
                    Cada «.» o salto de línea crea un sub-jefe.
                  </div>
                  <textarea
                    className="pt-entry"
                    value={G.paragraph}
                    placeholder="Escribí o pegá el texto acá…"
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
                    autoFocus
                  />
                </div>

                {/* card derecha: dropzone de imagen (OCR) */}
                <div
                  className={`pt-card pt-drop${G.dropHover ? " over" : ""}`}
                  onClick={() => !G.busy && fileInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (!G.dropHover) {
                      G.dropHover = true;
                      rerender();
                    }
                  }}
                  onDragLeave={() => {
                    G.dropHover = false;
                    rerender();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    G.dropHover = false;
                    const file = e.dataTransfer.files?.[0];
                    if (file && file.type.startsWith("image/")) importImage(file);
                    else rerender();
                  }}
                >
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
                  <span className="drop-ico">🖼</span>
                  <div className="drop-title">…o soltá una imagen</div>
                  <div className="drop-desc">
                    Extraemos el texto de la foto (apunte, libro, captura) y
                    armamos los sub-jefes por vos.
                  </div>
                  <button className="pt-mic-test" disabled={G.busy}>
                    ⬆ Elegir archivo
                  </button>
                  {G.ocrMsg && (
                    <div className={`drop-status ${G.ocrMsg.tone}`}>
                      {G.ocrMsg.text}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* franja inferior: micrófono + prueba + empezar partida */}
          <div className="pt-start-footbar">
            <div className="footbar-inner">
              <span className="bar-label">Micrófono</span>
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
              {G.micMsg ? (
                <span className={`bar-msg ${G.micMsg.tone}`}>{G.micMsg.text}</span>
              ) : (
                G.micOk && <span className="pt-mic-ok">✓ mic OK</span>
              )}
              <span className="bar-spacer" />
              <button
                className="pt-btn primary big"
                tabIndex={-1}
                onClick={onPrimary}
                disabled={G.busy}
              >
                Empezar partida →
              </button>
            </div>
          </div>
        </>
      )}

      {/* --------------------------------------------------------- victoria */}
      {G.screen === "win" && (
        <div className="pt-single">
          <div className="pt-wincard">
            <h2>🏆 ¡Ganaste!</h2>
            <div className={`pt-feedback ${G.feedback.tone}`}>{G.feedback.text}</div>
          </div>
          <button className="pt-btn primary" tabIndex={-1} onClick={onPrimary}>
            ↻ Otra vez
          </button>
        </div>
      )}

      {/* ----------------------------------------------------- juego/práctica */}
      {inGame && t && (
        <div className="pt-main">
          <section className="pt-stage">
            {/* meta: ORACIÓN 3 DE 5 · INTENTO 2 + chips */}
            <div className="pt-meta">
              <span className="pt-meta-label">{metaLabel()}</span>
              {belowCount() > 0 && (
                <span className="pt-chip-amber">
                  {belowCount()} {isMultiword(t) ? "palabras" : "sonidos"} bajo el umbral
                </span>
              )}
              <button
                className="pt-rail-toggle"
                tabIndex={-1}
                onClick={() => {
                  G.railOpen = true;
                  rerender();
                }}
              >
                {t.kind === "boss" ? "👑" : `${rows.findIndex((r) => r.id === activeRailId) + 1}/${rows.length}`} ▾
              </button>
            </div>

            {/* pill de estado: semáforo de grabación / veredicto */}
            {G.badge.text && (
              <div
                className={`pt-pillstatus ${G.resultStyle !== "idle" ? G.resultStyle : ""} ${G.badge.tone}${G.badge.live ? " live" : ""}`}
              >
                {G.badge.text}
              </div>
            )}

            {/* la oración (feedback inline) o la palabra + fonemas (práctica) */}
            {t.kind === "word" ? (
              <>
                <p
                  className="pt-word-big"
                  style={{ fontSize: Math.max(20, 44 + G.fontDelta * 2) }}
                >
                  {t.label}
                </p>
                {G.lastAssessment && (
                  <div className="pt-phons">
                    {(G.lastAssessment.words[0]?.phonemes ?? []).map((p, i) => (
                      <span
                        key={`${p.phoneme}-${i}`}
                        className={`pt-phon${tokClass(p.accuracy)}`}
                        style={{ animationDelay: `${Math.min(i * 25, 300)}ms` }}
                      >
                        {p.phoneme}
                        <sup>{p.accuracy.toFixed(0)}</sup>
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="pt-sentence" style={{ fontSize: sentenceFontSize() }}>
                {aligned
                  ? aligned.tokens.map((tok, i) => (
                    <span key={i}>
                      {tok.prefix}
                      {tok.score ? (
                        <button
                          className={`pt-tok${tok.omitted ? " omit" : tokClass(tok.score.accuracy)}`}
                          tabIndex={-1}
                          onClick={() => onWordClick(tok.clean)}
                          title="🔊 clic para oírla"
                        >
                          {tok.clean}
                          {(tok.omitted || tok.score.accuracy < threshold) && (
                            <sup>
                              {tok.omitted ? "—" : tok.score.accuracy.toFixed(0)}
                            </sup>
                          )}
                        </button>
                      ) : (
                        tok.clean
                      )}
                      {tok.suffix}{" "}
                    </span>
                  ))
                  : t.label}
              </p>
            )}

            {/* caption bajo la oración */}
            {aligned && (
              <div className="pt-caption">
                lo negro pasó el umbral · clic en una palabra para oírla
                {aligned.insertions.length > 0 &&
                  ` · dijiste de más: ${aligned.insertions.map((w) => w.word).join(", ")}`}
              </div>
            )}

            <div
              className={`pt-feedback ${G.feedback.tone}`}
              style={{ fontSize: Math.max(11, 14 + G.fontDelta) }}
            >
              {G.feedback.text}
            </div>

            {/* chips "A practicar" */}
            {isMultiword(t) && worstWords().length > 0 && G.screen !== "recording" && (
              <div className="pt-chips">
                <span className="pt-chips-label">A practicar:</span>
                {worstWords()
                  .slice(0, 8)
                  .map(([w, c]) => (
                    <button
                      key={w}
                      className={`pt-chip${c === 1 ? " chip-amber" : ""}`}
                      tabIndex={-1}
                      title="🔊 clic para oírla"
                      onClick={() => onWordClick(w)}
                    >
                      {w} ×{c}
                    </button>
                  ))}
                <button
                  className="pt-chip chip-clear"
                  tabIndex={-1}
                  onClick={onClearErrors}
                >
                  ✕ limpiar
                </button>
              </div>
            )}

            {/* botonera */}
            {G.screen !== "recording" && (
              <div className="pt-actions">
                <button
                  className="pt-btn primary"
                  tabIndex={-1}
                  onClick={onPrimary}
                  disabled={G.busy}
                >
                  {primaryLabel()}
                </button>
                {G.screen === "pass" && (
                  <button className="pt-btn" tabIndex={-1} onClick={onRetry} disabled={G.busy}>
                    ↺ Reintentar
                  </button>
                )}
                <button className="pt-btn" tabIndex={-1} onClick={onRepeat} disabled={G.busy}>
                  🔊 Escuchar {t.kind === "word" ? "palabra" : "oración"}
                </button>
                <button className="pt-btn" tabIndex={-1} onClick={onPlayMine} disabled={G.busy}>
                  🎧 Escuchar tu respuesta
                </button>
                {t.kind === "word" && G.practiceOriginId !== null ? (
                  <button
                    className="pt-btn success"
                    tabIndex={-1}
                    onClick={onPracticeWorst}
                    disabled={G.busy}
                  >
                    ↩ Salir de práctica
                  </button>
                ) : (
                  isMultiword(t) &&
                  worstWords().length > 0 && (
                    <button
                      className="pt-btn success"
                      tabIndex={-1}
                      onClick={onPracticeWorst}
                      disabled={G.busy}
                    >
                      ⚡ Practicar {worstWords().length} palabra
                      {worstWords().length > 1 ? "s" : ""}
                    </button>
                  )
                )}
                {bossIndex() !== null && isMultiword(t) && (
                  <button
                    className="pt-btn"
                    tabIndex={-1}
                    onClick={onSkipToBoss}
                    disabled={G.busy}
                  >
                    {t.kind === "boss" ? "↩ Volver" : "👑 Ir al jefe"}
                  </button>
                )}
              </div>
            )}

            {/* consejo del coach (DeepSeek) */}
            {G.coach.mode !== "hidden" && (
              <div className={`pt-coach${G.coach.mode === "shown" ? " shown" : ""}`}>
                {G.coach.mode === "loading"
                  ? "🧠 pensando un consejo…"
                  : `🧠  ${G.coach.text}`}
              </div>
            )}
          </section>

          {/* carril lateral: la ruta del párrafo */}
          <aside className="pt-rail">{railRows(false)}</aside>
        </div>
      )}

      {/* drawer del carril (pantallas angostas) */}
      {inGame && G.railOpen && (
        <div
          className="pt-drawer-scrim"
          onClick={() => {
            G.railOpen = false;
            rerender();
          }}
        >
          <aside className="pt-rail drawer" onClick={(e) => e.stopPropagation()}>
            {railRows(true)}
          </aside>
        </div>
      )}

      <footer className="pt-footer">
        {G.screen === "input" || G.screen === "win" ? (
          <>
            Construido por{" "}
            <a href="https://github.com/iam-oov/" target="_blank" rel="noreferrer">
              iam-oov
            </a>{" "}
            con 💛
          </>
        ) : (
          gameFooter
        )}
      </footer>

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

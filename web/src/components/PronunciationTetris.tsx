/** Pronunciation Tetris - web port of the desktop game (app.py).
 *
 * Start screen "1d": paragraph or image as input (cards side by side) and
 * microphone + test + Start in a single bar.
 *
 * Game/practice "3b - Side rail" (light theme): the center is for the sentence
 * with the PER-WORD feedback inline (highlight + superscript score); the
 * paragraph's route lives in a rail on the right (click navigates); actions
 * are visible buttons with their keyboard shortcut as a hint.
 *
 * Architecture: this component is the equivalent of the tkinter App class.
 * It only knows the ports (scorer/coach/audio/ocr/progress); no Azure here.
 *
 * Concurrency model: where the desktop used threads + queue + _poll, here
 * async/await is enough (the JS SDK doesn't block). We keep the `gen`
 * counter that invalidates stale async work (a coach tip or an assessment
 * arriving after a reset is discarded).
 *
 * Demo mode: with ?demo in the URL the scorer is replaced by a canned stub
 * (src/lib/demo.ts) - full visual QA without a mic or Azure key.
 */

import { useEffect, useReducer, useRef } from "react";
import {
  ArrowRight,
  Brain,
  Check,
  CornerUpLeft,
  Crown,
  Headphones,
  Image as ImageIcon,
  Mic,
  RotateCcw,
  Settings as SettingsIcon,
  Upload,
  Volume2,
  X,
  Zap,
} from "lucide-react";

import {
  KEYS,
  buildTargets,
  isContinuous,
  isLongForm,
  isMultiword,
  phonemeHint,
  makeWord,
  splitSentences,
  type Target,
} from "../lib/game";
import { judge, RED_CUTOFF } from "../lib/scoring";
import { alignWords, type Alignment } from "../lib/align";
import {
  DEFAULT_SETTINGS,
  loadParagraph,
  loadSettings,
  saveParagraph,
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
import { clearRun, loadRun, saveRun, type SavedRun } from "../lib/run";
import { assessmentOk, weakWords, type Assessment } from "../lib/types";

type Screen = "input" | "ready" | "recording" | "fail" | "pass" | "win";
type ResultStyle = "idle" | "pass" | "fail-amber" | "fail-red";
type Tone = "c-fg" | "c-muted" | "c-dim" | "c-green" | "c-red" | "c-amber" | "c-accent";

interface UiText {
  text: string;
  tone: Tone;
}

/** ?demo in the URL: fake scorer to walk through everything without Azure. */
const DEMO =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("demo");
const demoScorer = createDemoScorer();

/** Mutable game state (the "self" of the tkinter App). Lives in a ref and
 * every mutation requests a re-render: keyboard actions always read the
 * live state, no stale closures. */
interface G {
  settings: Settings;
  stats: LifetimeStats;
  screen: Screen;
  busy: boolean;
  /** primary-button text override during an operation (TTS, your voice) */
  busyLabel: string | null;
  targets: Target[];
  index: number;
  lastAudioUrl: string | null;
  /** last OK result, for the inline feedback (null = no breakdown) */
  lastAssessment: Assessment | null;
  micOptions: MicOption[];
  /** deviceId chosen in the dropdown ("" = default) */
  micSelected: string;
  /** mic pinned when the game starts */
  micChosen: string | undefined;
  gen: number;
  totalAttempts: number;
  wordAttempts: number;
  /** words to improve PER target: targetId -> {word: error_count} */
  errors: Record<number, Record<string, number>>;
  /** targetId -> "defeated" | "failed" (absent = not attempted) */
  statusById: Record<number, "defeated" | "failed">;
  returnTargetId: number | null;
  practiceOriginId: number | null;
  practiceIds: number[];
  streak: number;
  combo: number;
  runXp: number;
  bestHp: Record<number, number>;
  fontDelta: number;
  // --- visual feedback ---
  badge: UiText & { live?: boolean };
  resultStyle: ResultStyle;
  feedback: UiText;
  coach: { mode: "hidden" | "loading" | "shown"; text: string };
  flash: "" | "green" | "red";
  flashGen: number;
  xp: { amount: number; gen: number } | null;
  showSettings: boolean;
  /** rail drawer on narrow screens */
  railOpen: boolean;
  paragraph: string;
  /** the last mic test worked ("mic OK" chip in the start bar) */
  micOk: boolean;
  /** transient mic-test status, shown IN the mic bar */
  micMsg: UiText | null;
  /** OCR status (progress/result), shown IN the image card */
  ocrMsg: UiText | null;
  /** dragging an image over the dropzone */
  dropHover: boolean;
  /** diagnostic row: "+N light" chips expanded */
  chipsOpen: boolean;
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
  micOptions: [{ label: "System Default" }],
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
  chipsOpen: false,
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

  /** Persist the in-progress run so a refresh restores it. State is saved
   * positionally over the multiword targets (ids are runtime-only); practice
   * drills are ephemeral and resolve to their origin sentence. */
  const persistRun = () => {
    if (!hasGame() || G.screen === "win" || G.screen === "recording") return;
    const base = G.targets.filter(isMultiword);
    const sentences = base
      .filter((x) => x.kind === "sentence")
      .map((x) => x.reference);
    if (sentences.length === 0) return;
    const cur = current();
    const activeId = cur && isMultiword(cur) ? cur.id : G.practiceOriginId;
    const drill = G.targets.filter((x) => G.practiceIds.includes(x.id));
    const practice =
      G.practiceOriginId !== null && drill.length > 0
        ? {
          origin: Math.max(
            0,
            base.findIndex((x) => x.id === G.practiceOriginId),
          ),
          words: drill.map((x) => x.reference),
          pos:
            cur && cur.kind === "word"
              ? Math.max(0, drill.findIndex((x) => x.id === cur.id))
              : 0,
        }
        : null;
    saveRun({
      sentences,
      index: Math.max(0, base.findIndex((x) => x.id === activeId)),
      status: base.map((x) => G.statusById[x.id] ?? null),
      bestHp: base.map((x) => G.bestHp[x.id] ?? 0),
      errors: base.map((x) => ({ ...(G.errors[x.id] ?? {}) })),
      streak: G.streak,
      combo: G.combo,
      runXp: G.runXp,
      totalAttempts: G.totalAttempts,
      wordAttempts: G.wordAttempts,
      screen: G.screen === "fail" || G.screen === "pass" ? G.screen : "ready",
      assessment: G.lastAssessment
        ? { ...G.lastAssessment, audioUrl: null }
        : null,
      badgeText: G.badge.text,
      badgeTone: G.badge.tone,
      resultStyle: G.resultStyle,
      feedbackText: G.feedback.text,
      feedbackTone: G.feedback.tone,
      practice,
    });
  };

  /** Rebuild a saved run. Returns false (and the caller discards it) if the
   * saved arrays don't match the rebuilt targets (stale format). */
  /** Rebuilds the saved run INCLUDING the post-attempt view (verdict pill,
   * inline marks, feedback) and any active practice drill, so a refresh
   * lands exactly where you were. Does NOT go through enterReady: that
   * helper clears the very state being restored. */
  const restoreRun = (saved: SavedRun): boolean => {
    const targets = buildTargets(saved.sentences);
    if (targets.length !== saved.status.length) return false;
    G.statusById = {};
    G.bestHp = {};
    G.errors = {};
    targets.forEach((x, i) => {
      const st = saved.status[i];
      if (st) G.statusById[x.id] = st;
      const hp = saved.bestHp[i];
      if (hp) G.bestHp[x.id] = hp;
      const errs = saved.errors[i];
      if (errs && Object.keys(errs).length > 0) G.errors[x.id] = { ...errs };
    });

    const p = saved.practice;
    if (p && p.origin >= 0 && p.origin < targets.length && p.words.length > 0) {
      const drill = p.words.map(makeWord);
      G.practiceOriginId = targets[p.origin]!.id;
      G.practiceIds = drill.map((d) => d.id);
      G.targets = [
        ...targets.slice(0, p.origin),
        ...drill,
        ...targets.slice(p.origin),
      ];
      G.index = p.origin + Math.min(Math.max(0, p.pos), drill.length - 1);
    } else {
      G.targets = targets;
      G.index = Math.min(Math.max(0, saved.index), targets.length - 1);
    }

    G.streak = saved.streak;
    G.combo = saved.combo;
    G.runXp = saved.runXp;
    G.totalAttempts = saved.totalAttempts;
    G.wordAttempts = saved.wordAttempts;

    const TONES: Tone[] = ["c-fg", "c-muted", "c-dim", "c-green", "c-red", "c-amber", "c-accent"];
    const STYLES: ResultStyle[] = ["idle", "pass", "fail-amber", "fail-red"];
    G.screen = saved.screen;
    G.lastAssessment = saved.assessment
      ? ({ ...(saved.assessment as Assessment), audioUrl: null } as Assessment)
      : null;
    G.badge = {
      text: saved.badgeText,
      tone: TONES.includes(saved.badgeTone as Tone) ? (saved.badgeTone as Tone) : "c-dim",
    };
    G.resultStyle = STYLES.includes(saved.resultStyle as ResultStyle)
      ? (saved.resultStyle as ResultStyle)
      : "idle";
    G.feedback = {
      text: saved.feedbackText,
      tone: TONES.includes(saved.feedbackTone as Tone)
        ? (saved.feedbackTone as Tone)
        : "c-muted",
    };

    // Re-judge the restored attempt under CURRENT rules/threshold: a verdict
    // persisted before a rule or settings change must not survive as-is.
    const cur = G.targets[G.index];
    const a = G.lastAssessment;
    if (a && cur && (G.screen === "fail" || G.screen === "pass")) {
      const multiword = isMultiword(cur);
      const units: Array<[string, number]> = multiword
        ? a.words
          .filter((w) => !w.errorType.includes("Insertion"))
          .map((w) => [w.word, w.accuracy])
        : (a.words[0]?.phonemes ?? []).map((p) => [p.phoneme, p.accuracy]);
      const verdict = judge(units, {
        accuracy: a.accuracy,
        threshold: G.settings.passThreshold,
      });
      G.screen = verdict.passed ? "pass" : "fail";
      G.statusById[cur.id] = verdict.passed ? "defeated" : "failed";
      G.badge = { text: "", tone: "c-dim" };
      if (verdict.passed) {
        G.resultStyle = "pass";
        G.feedback = {
          text: `Superaste el umbral (${G.settings.passThreshold.toFixed(0)}%) sin ${multiword ? "palabras" : "sonidos"} en rojo.`,
          tone: "c-muted",
        };
      } else {
        G.resultStyle =
          verdict.worstScore >= RED_CUTOFF ? "fail-amber" : "fail-red";
        G.feedback = { text: failHint(a, multiword), tone: "c-muted" };
      }
    }
    persistRun();
    return true;
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

  // ------------------------------------------------------------ screens
  const showInput = () => {
    G.screen = "input";
    G.targets = [];
    G.index = 0;
    setBadge("", "c-dim");
    G.resultStyle = "idle";
    clearAssessment();
    coachClear();
    setFeedback("", "c-muted"); // the start layout already explains how to begin
    // The paragraph persists in the browser: on return (win/reset/refresh)
    // the last one is restored, to re-practice it without re-typing.
    G.paragraph = loadParagraph();
    G.railOpen = false;
    G.micMsg = null; // an old mic test doesn't apply to the new screen
    G.ocrMsg = null;
    rerender();
  };

  const reset = () => {
    // Panic button: discards the game. gen++ invalidates any in-flight
    // async work (a late assessment/TTS/tip is discarded).
    G.busy = false;
    G.busyLabel = null;
    G.lastAudioUrl = null;
    G.gen += 1;
    clearRun();
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
    // If we leave the practice words, remove them to avoid clutter.
    const cur = current();
    if (G.practiceIds.length > 0 && cur && !G.practiceIds.includes(cur.id)) {
      cleanupPractice();
    }
    G.gen += 1; // invalidates stale tips/results
    G.wordAttempts = 0;
    G.lastAudioUrl = null; // previous target's recording no longer applies
    G.chipsOpen = false; // expanded chips belong to previous target
    setBadge("", "c-dim");
    G.resultStyle = "idle";
    clearAssessment();
    coachClear();
    setFeedback("", "c-muted");
    persistRun();
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
    // Each paragraph is a new run: RPG counters start from zero.
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
    clearRun();
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

  // ------------------------------------------------------------- actions
  const onStart = () => {
    if (G.busy || G.screen !== "input") return;
    if (!DEMO && !settingsReady(G.settings)) {
      G.showSettings = true;
      rerender();
      return;
    }
    const sentences = splitSentences(G.paragraph.trim());
    if (sentences.length === 0) return;
    G.micChosen = G.micSelected || undefined; // pin the chosen mic
    beginGame(sentences);
  };

  const advance = () => {
    G.index += 1;
    if (G.index >= G.targets.length) win();
    else enterReady();
  };

  const onSpace = () => {
    if (G.busy) return;
    if (G.screen === "input") return; // let the textarea handle the space
    if (G.screen === "win") return showInput();
    if (G.screen === "pass") return advance();
    startRecording(); // ready or fail
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
      // ACTIVE state -> blue accent. Green is reserved for PASS ONLY.
      setBadge("●  ¡Hablá ahora!", "c-accent", true);
      setFeedback(que, "c-muted");
    } else if (code === "speech") {
      setBadge("●  Te escucho…", "c-accent", true);
      setFeedback("Seguí. Callate al terminar para cerrar.", "c-muted");
    } else if (code === "processing") {
      setBadge("Procesando…", "c-amber");
      setFeedback("Listo, dejá que Azure analice.", "c-muted");
    }
    rerender();
  };

  const startRecording = () => {
    const t = current();
    if (!t) return;
    G.busy = true;
    G.screen = "recording";
    G.gen += 1; // new recording: invalidates previous attempt's tip
    const myGen = G.gen;
    G.totalAttempts += 1;
    G.wordAttempts += 1;
    clearAssessment();
    coachClear();
    // Traffic light: mic is still connecting, do NOT speak yet.
    setBadge("Preparando micrófono…", "c-dim");
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
      // Breakdown lives INLINE + chips + bar; here only what isn't there.
      if (weakWords(a, G.settings.passThreshold).length === 0) {
        return `Casi. Completaste ${a.completeness.toFixed(0)}%, fluidez ${a.fluency.toFixed(0)}%.`;
      }
      return "";
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
    const myGen = G.gen; // if context changes before arrival, it's discarded
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
    G.lastAudioUrl = a.audioUrl; // your recording, for playback with D

    if (!assessmentOk(a)) {
      G.screen = "fail";
      G.streak = 0; // failure cuts streak and combo
      G.combo = 0;
      G.statusById[t.id] = "failed"; // attempted, not defeated
      setBadge(`✕  ${a.error ?? "Algo salió mal."}`, "c-red");
      G.resultStyle = "fail-red";
      clearAssessment();
      coachClear();
      setFeedback("", "c-muted"); // the pill already carries the error
      rerender();
      return;
    }

    const multiword = isMultiword(t);
    const threshold = G.settings.passThreshold;
    G.lastAssessment = a; // feeds inline feedback (sentence or phonemes)

    // Breakdown for VERDICT: per word (sentence/paragraph) or per phoneme.
    // Only REFERENCE words judge the strict rule — insertions (extra words,
    // e.g. an echoed double-read) would score 0 and veto an otherwise clean
    // attempt. They stay visible ("dijiste de más") and still block the
    // near-miss rescue via the recognized-text match. Deliberate divergence
    // from desktop, which counts them.
    let units: Array<[string, number]>;
    if (multiword) {
      units = a.words
        .filter((w) => !w.errorType.includes("Insertion"))
        .map((w) => [w.word, w.accuracy]);
      // Per-word error counter: +1 for those below threshold; those that DO
      // reach it leave the list (mastered). Basis of R mode.
      const errs = curErrors();
      for (const w of a.words) {
        if (w.errorType.includes("Insertion")) continue;
        if (w.accuracy < threshold) errs[w.word] = (errs[w.word] ?? 0) + 1;
        else delete errs[w.word];
      }
      // Combo: consecutive PERFECT words (>= max(threshold, 97)), spans attempts.
      const perfectBar = Math.max(threshold, 97);
      for (const [, score] of units) {
        G.combo = score >= perfectBar ? G.combo + 1 : 0;
      }
    } else {
      units = (a.words[0]?.phonemes ?? []).map((p) => [p.phoneme, p.accuracy]);
    }

    // Target HP = best accuracy achieved (shown in rail).
    G.bestHp[t.id] = Math.max(G.bestHp[t.id] ?? 0, a.accuracy);

    // Pass rule (pure domain in scoring.ts): average over the bar AND no
    // red units.
    const verdict = judge(units, { accuracy: a.accuracy, threshold });

    // Capture PREVIOUS status: distinguishes fresh defeat (grants XP)
    // from re-passing something already defeated (no farming).
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
      setBadge(`✓ ¡Derrotada! · ${a.accuracy.toFixed(0)}%`, "c-green");
      G.resultStyle = "pass";
      setFeedback(
        `Superaste el umbral (${threshold.toFixed(0)}%) sin ${multiword ? "palabras" : "sonidos"} en rojo.`,
      );
      coachClear();
    } else {
      G.screen = "fail";
      G.streak = 0;
      G.combo = 0;
      flash("red");
      const partial = verdict.worstScore >= RED_CUTOFF;
      G.resultStyle = partial ? "fail-amber" : "fail-red";
      setBadge("", partial ? "c-amber" : "c-red");
      const tip = failHint(a, multiword);
      setFeedback(tip);
      // DeepSeek tip: only on single words (drill), at phoneme level.
      if (coach().available && !multiword) {
        G.coach = { mode: "loading", text: "" };
        requestTip(a);
      } else {
        coachClear();
      }
    }
    persistRun();
    rerender();
  };

  const startTts = (text: string) => {
    G.busy = true;
    G.busyLabel = "Reproduciendo…";
    rerender();
    scorer()
      .speak(text)
      .then((err) => {
        G.busy = false;
        G.busyLabel = null;
        if (G.screen === "input") return rerender(); // it was reset: don't clobber
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
    G.busyLabel = "Reproduciendo tu voz…";
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
    setFeedback("Practice list reset.", "c-dim");
    persistRun();
    rerender();
  };

  const onSkipToBoss = () => {
    // A is a TOGGLE: if you're not at boss, go to boss
    // (remember where from); if you already are, return to that
    // target (or to 1st sentence).
    if (!actionable()) return;
    const bossIdx = bossIndex();
    if (bossIdx === null) return; // single-sentence paragraph
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

  /** Direct navigation from the rail (click on a row). */
  const goToTarget = (id: number) => {
    if (!actionable()) return;
    const idx = G.targets.findIndex((x) => x.id === id);
    if (idx >= 0 && idx !== G.index) {
      G.index = idx;
      enterReady();
    }
  };

  const onPracticeWorst = () => {
    // R: enter/exit practice mode.
    if (!actionable()) return;
    const t = current()!;
    // If already drilling (word) -> exit to origin sentence.
    if (t.kind === "word" && G.practiceOriginId !== null) {
      const idx = G.targets.findIndex((x) => x.id === G.practiceOriginId);
      if (idx >= 0) G.index = idx;
      enterReady(); // returning to origin, enterReady cleans up
      return;
    }
    if (!isMultiword(t)) return;
    const worst = worstWords().map(([w]) => w);
    if (worst.length === 0) {
      setFeedback("No words to practice here. Read the sentence first.", "c-dim");
      rerender();
      return;
    }
    // Insert practice words RIGHT before current target.
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
    // Messages go to G.micMsg: shown IN the mic bar,
    // next to Test button (not in general screen feedback).
    if (G.busy || G.screen !== "input") return;
    G.busy = true;
    G.micMsg = { text: "● Grabando 3 segundos… ¡decí algo!", tone: "c-accent" };
    rerender();
    recordTest(G.micSelected || undefined, 3).then(async ({ url, error }) => {
      refreshMics(); // newly granted permission unlocks mic names
      if (error || !url) {
        G.busy = false;
        G.micOk = false;
        G.micMsg = { text: `✗ ${error ?? "No se pudo grabar."}`, tone: "c-red" };
        rerender();
        return;
      }
      if (G.screen === "input") {
        G.micMsg = { text: "Reproduciendo… ¿te escuchás?", tone: "c-accent" };
        rerender();
      }
      const playErr = await playRecording(url);
      G.busy = false;
      if (G.screen !== "input") return rerender();
      if (playErr) {
        G.micOk = false;
        G.micMsg = { text: `✗ ${playErr}`, tone: "c-red" };
      } else {
        G.micOk = true; // "✓ mic OK" chip stays as persistent confirmation
        G.micMsg = null;
      }
      rerender();
    });
  };

  /** Image -> OCR -> cleanup -> sentences (coach LLM if key present,
   * else Intl.Segmenter). Result lands in textarea ONE sentence per line, so
   * you see sub-bosses and correct what OCR invented before playing. */
  const importImage = (file: File | Blob | null | undefined) => {
    // Messages go to G.ocrMsg: shown IN image card (the
    // dropzone), where action is happening - not in general feedback.
    if (!file || G.busy || G.screen !== "input") return;
    G.busy = true;
    G.ocrMsg = { text: "Leyendo la imagen… 0%", tone: "c-accent" };
    rerender();
    extractTextFromImage(file, (pct) => {
      if (G.screen !== "input") return;
      G.ocrMsg = { text: `Leyendo la imagen… ${pct}%`, tone: "c-accent" };
      rerender();
    }).then(async ({ text, error }) => {
      if (G.screen !== "input") {
        G.busy = false;
        return rerender(); // left start screen: discard
      }
      if (error || !text) {
        G.busy = false;
        G.ocrMsg = {
          text: `✗ ${error ?? "No encontré texto en la imagen."}`,
          tone: "c-red",
        };
        return rerender();
      }
      const cleaned = cleanOcrText(text);
      // Smart route: coach (DeepSeek) corrects OCR errors and splits
      // sentences. Optional and no regression: if it fails, use local heuristic.
      let sentences: string[] | null = null;
      if (coach().available && cleaned) {
        G.ocrMsg = { text: "Puliendo el texto con el coach…", tone: "c-accent" };
        rerender();
        sentences = await coach().smartSplit(cleaned);
      }
      if (!sentences || sentences.length === 0) sentences = splitSentences(cleaned);
      G.busy = false;
      if (sentences.length === 0) {
        G.ocrMsg = {
          text: "✗ No encontré oraciones legibles en la imagen.",
          tone: "c-red",
        };
        return rerender();
      }
      G.paragraph = sentences.join("\n");
      saveParagraph(G.paragraph); // extracted text also survives refresh
      const n = sentences.length;
      G.ocrMsg = {
        text:
          n > 1
            ? `✓ Extraje ${n} oraciones → ${n} sub-jefes + 1 jefe final. Revisá el texto: el OCR a veces inventa.`
            : "✓ Extraje 1 oración. Revisala antes de empezar.",
        tone: "c-green",
      };
      rerender();
    });
  };

  const bumpFont = (step: number) => {
    // Doesn't work on start screen: P/L are keys you're typing.
    if (!hasGame() || G.screen === "input") return;
    G.fontDelta = Math.max(-6, Math.min(16, G.fontDelta + step));
    rerender();
  };

  // ------------------------------------------------------------- keyboard
  const handleKey = (e: KeyboardEvent) => {
    if (G.showSettings) {
      if (e.key === "Escape") {
        G.showSettings = false;
        rerender();
      }
      return;
    }
    if (G.railOpen) {
      // Drawer intercepts Escape BEFORE game reset.
      if (e.key === "Escape") {
        G.railOpen = false;
        rerender();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
      e.preventDefault(); // Ctrl+R is OUR reset, not reload page
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
      // Shift+Enter in textarea starts; rest is handled by input itself.
      if (e.key === "Enter" && e.shiftKey && el instanceof HTMLTextAreaElement) {
        e.preventDefault();
        onStart();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") return reset();
    if (e.key === " ") {
      e.preventDefault(); // don't scroll or re-fire focused button
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
    G.paragraph = loadParagraph();
    const saved = loadRun();
    if (saved && !restoreRun(saved)) clearRun();
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

  // ------------------------------------------------------------ derived
  const t = current();
  const inGame = hasGame() && G.screen !== "input" && G.screen !== "win";
  const threshold = G.settings.passThreshold;

  /** Rail rows: only multiword targets (not drill words). */
  const rows = G.targets.filter(isMultiword);
  /** Active row: current, or ORIGIN sentence if drilling. */
  const activeRailId =
    t === null ? null : isMultiword(t) ? t.id : G.practiceOriginId;

  /** Alignment for inline feedback (only with assessment and multiword). */
  const aligned: Alignment | null =
    t !== null && isMultiword(t) && G.lastAssessment !== null
      ? alignWords(t.reference, G.lastAssessment.words)
      : null;

  /** Traffic light: >= threshold plain ink (fine), amber down to the red
   * cutoff, red below it. Single source for BOTH the inline sentence and the
   * practice table so the colors never drift apart. */
  const tokClass = (score: number): string =>
    score >= threshold ? "" : score >= RED_CUTOFF ? " warn" : " bad";
  const scoreTone = (score: number): string =>
    score >= threshold ? "c-accent" : score >= RED_CUTOFF ? "c-amber" : "c-red";

  const metaLabel = (): string => {
    if (!t) return "";
    let base: string;
    if (t.kind === "boss") {
      base = "Jefe final";
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

  const chromeLine = (): string => {
    const parts: string[] = [];
    if (G.streak >= 2) parts.push(`Racha ${G.streak}`);
    if (G.combo >= 2) parts.push(`Combo x${G.combo}`);
    return parts.join(" · ");
  };

  /** Base sentence size by type/length + zoom P/L. */
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

  /** What the current target is, for bar text. */
  const thingLabel = (): string =>
    !t ? "" : t.kind === "boss" ? "el párrafo" : t.kind === "word" ? "la palabra" : "la oración";

  const primaryLabel = (): string => {
    if (G.busyLabel) return G.busyLabel;
    switch (G.screen) {
      case "pass": return nextLabel();
      case "fail": return `Reintentar ${thingLabel().replace(/^(el|la) /, "")}`;
      default: return "Hablar ahora";
    }
  };

  /** Bottom action-bar text. READY instruction, recording traffic light and
   * the FAIL call-to-practice ("6b"). On PASS the bar shows buttons only —
   * the celebration card carries the verdict copy. */
  const barContent = (): { title: string; cls: string; sub: string } => {
    if (!t) return { title: "", cls: "c-fg", sub: "" };
    if (G.screen === "recording") {
      return {
        title: G.badge.text,
        cls: `${G.badge.tone}${G.badge.live ? " live" : ""}`,
        sub: G.feedback.text,
      };
    }
    if (G.screen === "fail") {
      const a = G.lastAssessment;
      if (!a) return { title: "Probá de nuevo", cls: "c-red", sub: "" };
      // The bar states WHY you failed, in traffic-light terms: reds veto
      // the win; otherwise it was the average.
      const scores =
        t.kind === "word"
          ? (a.words[0]?.phonemes ?? []).map((p) => p.accuracy)
          : a.words
            .filter((w) => !w.errorType.includes("Insertion"))
            .map((w) => w.accuracy);
      const reds = scores.filter((s) => s < RED_CUTOFF).length;
      const unit = t.kind === "word" ? "sonido" : "palabra";
      return {
        title: "Seguí practicando",
        cls: "c-fg",
        sub:
          reds > 0
            ? `sacá del rojo ${reds} ${unit}${reds > 1 ? "s" : ""} para derrotar ${thingLabel()}`
            : `tu promedio quedó en ${a.accuracy.toFixed(0)}%: necesitás ${threshold.toFixed(0)}% o más`,
      };
    }
    if (G.screen !== "ready") return { title: "", cls: "c-fg", sub: "" };
    const que =
      t.kind === "boss"
        ? "Leé TODO el párrafo, podés pausar entre oraciones."
        : t.kind === "word"
          ? "Decí la palabra UNA sola vez, fuerte y claro."
          : "Leé la oración completa, fuerte y claro.";
    return { title: "A leer", cls: "c-fg", sub: que };
  };

  /** Celebration card title/CTA ("6a"). */
  const defeatTitle = (): string =>
    !t
      ? ""
      : t.kind === "boss"
        ? "¡Jefe derrotado!"
        : t.kind === "word"
          ? "¡Palabra derrotada!"
          : "¡Oración derrotada!";
  const nextLabel = (): string =>
    G.index >= G.targets.length - 1
      ? "Terminar"
      : t?.kind === "word"
        ? "Siguiente"
        : "Siguiente oración";


  const railRows = (drawer: boolean) => (
    <>
      <div className="pt-rail-h">Párrafo</div>
      {rows.map((target, k) => {
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
        // Number color: blue = current, green = defeated, gray = the rest.
        // "Attempted but not defeated" is already implied by having a score;
        // a red number next to a green score read as a contradiction.
        const numCls = [
          "row-num",
          active ? "active" : st === "defeated" ? "done" : "",
        ]
          .filter(Boolean)
          .join(" ");
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
            <span className={numCls}>
              {target.kind === "boss" ? <Crown size={11} /> : k + 1}
            </span>
            <span className="row-text">
              {target.kind === "boss"
                ? "Jefe final — el párrafo completo, de corrido"
                : target.label}
              {note && <span className="row-note">{note}</span>}
            </span>
            {score !== undefined && score > 0 && (
              <span
                className={`row-score ${score >= threshold ? "c-green" : "c-red"}`}
              >
                {score.toFixed(0)}
              </span>
            )}
          </button>
        );
      })}
    </>
  );


  // -------------------------------------------------------------- render
  return (
    <div className="pt-app">
      <header className="pt-header">
        <div className="pt-brand">
          <span className="brand-dot" />
          Pronunciation Tetris
          <span className="pt-credit">
            · Construido por{" "}
            <a href="https://github.com/iam-oov/" target="_blank" rel="noreferrer">
              iam-oov
            </a>{" "}
            con 💛
          </span>
        </div>
        <div className="pt-header-right">
          {chromeLine() && <span className="pt-chip-subtle">{chromeLine()}</span>}
          {G.xp && (
            <span key={G.xp.gen} className="pt-xp">
              +{G.xp.amount} XP
            </span>
          )}
          <span className="pt-umbral">
            Umbral <b>{threshold.toFixed(0)}%</b>
          </span>
          <button
            className="pt-gear"
            title="Ajustes"
            onClick={() => {
              G.showSettings = true;
              rerender();
            }}
          >
            <SettingsIcon size={16} />
          </button>
        </div>
      </header>
      <div className={`pt-flash ${G.flash}`} />

      {/* ------------------------------------------------ start screen
          Eyebrow "NEW GAME" + title on left, tall cards
          (paragraph | image) on white page, microphone bar
          as bottom page strip with "Start game". Same functionality,
          just different layout. */}
      {G.screen === "input" && (
        <>
          <div className="pt-start-sheet">
            <div className="pt-start">
              {/* Progression (RPG level by XP) only shown if you've
                  played before: "Level 1" cold reads as a level selector
                  the game doesn't have. */}
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
                  <b>Faltan credenciales de Azure.</b> Abrí Ajustes y completá
                  tu <code>AZURE_SPEECH_KEY</code> y región. La key se guarda
                  solo en tu navegador (localStorage): no hay servidor en el
                  medio.
                </div>
              )}

              <div className="pt-start-grid">
                {/* left card: paste/type paragraph */}
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
                      saveParagraph(e.target.value);
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

                {/* right card: image dropzone (OCR) */}
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
                      e.target.value = ""; // allow re-choosing same image
                    }}
                  />
                  <span className="drop-ico">
                    <ImageIcon size={19} />
                  </span>
                  <div className="drop-title">…o soltá una imagen</div>
                  <div className="drop-desc">
                    Extraemos el texto de la foto (apunte, libro, captura) y
                    armamos los sub-jefes por vos.
                  </div>
                  <button className="pt-mic-test" disabled={G.busy}>
                    <Upload size={13} /> Elegir archivo
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

          {/* bottom strip: microphone + test + start game */}
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
                <Headphones size={13} /> Probar
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
                Empezar partida <ArrowRight size={15} />
              </button>
            </div>
          </div>
        </>
      )}

      {/* --------------------------------------------------------- victory */}
      {G.screen === "win" && (
        <div className="pt-single">
          <div className="pt-wincard">
            <h2>🏆 ¡Ganaste!</h2>
            <div className={`pt-feedback ${G.feedback.tone}`}>{G.feedback.text}</div>
          </div>
          <button className="pt-btn primary" tabIndex={-1} onClick={onPrimary}>
            <RotateCcw size={14} /> Otra vez
          </button>
        </div>
      )}

      {/* ------------------------------------------- game/practice ("4a")
          Vertical hierarchy: READ (sentence with speaker) → DIAGNOSE
          (chips with overflow) → PRACTICE (action bar at bottom). */}
      {inGame && t && (
        <>
          <div className="pt-main">
            <section className="pt-stage">
              {/* meta: SENTENCE 3 OF 5 · ATTEMPT 2 */}
              <div className="pt-meta">
                <span className="pt-meta-label">{metaLabel()}</span>
                <button
                  className="pt-rail-toggle"
                  tabIndex={-1}
                  onClick={() => {
                    G.railOpen = true;
                    rerender();
                  }}
                >
                  {t.kind === "boss" ? (
                    <Crown size={11} />
                  ) : (
                    `${rows.findIndex((r) => r.id === activeRailId) + 1}/${rows.length}`
                  )}{" "}
                  ▾
                </button>
              </div>

              {/* READ: speaker + sentence (inline) or word + phonemes */}
              <div className="pt-readrow">
                <button
                  className="pt-speak"
                  tabIndex={-1}
                  onClick={onRepeat}
                  disabled={G.busy}
                  title={`Escuchar cómo se dice (${keyLabel("correct")})`}
                >
                  <Volume2 size={16} />
                </button>
                <div className="pt-readbody">
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
                        ? aligned.tokens.map((tok, i) => {
                          // PASS: watch-words (still on the practice list) go
                          // BLUE — "liked it, keep practicing". Green would
                          // read as "done" and red would sour the win.
                          const watch =
                            tok.score !== null &&
                            (tok.score.accuracy < threshold ||
                              curErrors()[tok.clean.toLowerCase()] !== undefined);
                          const cls =
                            G.screen === "pass"
                              ? watch
                                ? " watch"
                                : ""
                              : tok.omitted
                                ? " omit"
                                : tok.score
                                  ? tokClass(tok.score.accuracy)
                                  : "";
                          const showSup =
                            tok.score !== null &&
                            (G.screen === "pass"
                              ? watch
                              : tok.omitted || tok.score.accuracy < threshold);
                          return (
                            <span key={i}>
                              {tok.prefix}
                              {tok.score ? (
                                <button
                                  className={`pt-tok${cls}`}
                                  tabIndex={-1}
                                  onClick={() => onWordClick(tok.clean)}
                                  title="Click para oírla"
                                >
                                  {tok.clean}
                                  {showSup && (
                                    <sup>
                                      {tok.omitted && G.screen !== "pass"
                                        ? "—"
                                        : tok.score.accuracy.toFixed(0)}
                                    </sup>
                                  )}
                                </button>
                              ) : (
                                tok.clean
                              )}
                              {tok.suffix}{" "}
                            </span>
                          );
                        })
                        : t.label}
                    </p>
                  )}
                </div>
              </div>

              {/* row below sentence: your answer + caption */}
              <div className="pt-subrow">
                <button
                  className="pt-btn sm"
                  tabIndex={-1}
                  onClick={onPlayMine}
                  disabled={G.busy || !G.lastAudioUrl}
                  title={
                    G.lastAudioUrl
                      ? `Escuchar tu última grabación (${keyLabel("mine")})`
                      : "Grabá primero para poder escucharte"
                  }
                >
                  <Headphones size={13} /> Escuchar tu respuesta
                </button>
                {aligned && (
                  <span className="pt-caption">
                    Click en una palabra para oírla
                    {aligned.insertions.length > 0 &&
                      ` · dijiste de más: ${aligned.insertions.map((w) => w.word).join(", ")}`}
                  </span>
                )}
              </div>

              {/* feedback line: hidden while recording (bar) and on pass
                  (the celebration card owns the verdict copy) */}
              {G.screen !== "recording" && G.screen !== "pass" && (
                <div
                  className={`pt-feedback ${G.feedback.tone}`}
                  style={{ fontSize: Math.max(11, 14 + G.fontDelta) }}
                >
                  {G.feedback.text}
                </div>
              )}

              {/* technical error (no assessment): the pill carries it */}
              {G.screen === "fail" && !G.lastAssessment && G.badge.text && (
                <div className={`pt-pillstatus fail-red ${G.badge.tone}`}>
                  {G.badge.text}
                </div>
              )}

              {/* PASS ("6a"): celebration card + dim practice summary */}
              {G.screen === "pass" && G.lastAssessment && (
                <>
                  <div className="pt-celebrate">
                    <span className="cel-check">
                      <Check size={22} />
                    </span>
                    <span className="cel-pct">
                      {G.lastAssessment.accuracy.toFixed(0)}
                      <small>%</small>
                    </span>
                    <div className="cel-text">
                      <div className="cel-title">{defeatTitle()}</div>
                      {G.feedback.text && (
                        <div className="cel-sub">{G.feedback.text}</div>
                      )}
                    </div>
                  </div>
                  {isMultiword(t) && worstWords().length > 0 && (
                    <div className="pt-summary-line">
                      Quedaron {worstWords().length} palabra
                      {worstWords().length > 1 ? "s" : ""} floja
                      {worstWords().length > 1 ? "s" : ""} en tu lista de
                      práctica:{" "}
                      {worstWords()
                        .slice(0, 4)
                        .map(([w, c]) => `${w} ×${c}`)
                        .join(" · ")}
                      {" — "}
                      <button className="pt-link" tabIndex={-1} onClick={onPracticeWorst}>
                        practicar ahora
                      </button>
                      {" · "}
                      <button className="pt-link" tabIndex={-1} onClick={onRetry}>
                        reintentar
                      </button>
                    </div>
                  )}
                </>
              )}

              {/* READY: light reminder chips of pending practice words */}
              {G.screen === "ready" && isMultiword(t) && worstWords().length > 0 && (
                <div className="pt-chips">
                  {(G.chipsOpen ? worstWords() : worstWords().slice(0, 3)).map(
                    ([w, c]) => (
                      <button
                        key={w}
                        className="pt-chip"
                        tabIndex={-1}
                        title="Click para oírla"
                        onClick={() => onWordClick(w)}
                      >
                        {w} ×{c}
                      </button>
                    ),
                  )}
                  {worstWords().length > 3 && (
                    <button
                      className="pt-chip chip-more"
                      tabIndex={-1}
                      onClick={() => {
                        G.chipsOpen = !G.chipsOpen;
                        rerender();
                      }}
                    >
                      {G.chipsOpen ? "− menos" : `+${worstWords().length - 3} leves`}
                    </button>
                  )}
                  <button
                    className="pt-chip chip-clear"
                    tabIndex={-1}
                    onClick={onClearErrors}
                  >
                    <X size={11} /> limpiar
                  </button>
                </div>
              )}

              {/* FAIL ("6b"): practice table (~90%) + score number (~10%);
                  on narrow screens the number jumps on top, full width */}
              {G.screen === "fail" && G.lastAssessment && (
                <div className="pt-diag-row">
                  {isMultiword(t) && worstWords().length > 0 && (
                    <div className="pt-practice-table">
                      <div className="ptw-head">
                        <span className="ptw-title">
                          <Zap size={12} /> A practicar · {worstWords().length}{" "}
                          palabra{worstWords().length > 1 ? "s" : ""}
                        </span>
                        <button className="pt-link" tabIndex={-1} onClick={onClearErrors}>
                          <X size={11} /> limpiar lista
                        </button>
                      </div>
                      <div className="ptw-grid">
                        {(G.chipsOpen ? worstWords() : worstWords().slice(0, 6)).map(
                          ([w, c], i) => {
                            const lastW = G.lastAssessment!.words.find(
                              (x) =>
                                x.word === w && !x.errorType.includes("Insertion"),
                            );
                            const ipa =
                              lastW && lastW.phonemes.length > 0
                                ? `/${lastW.phonemes.map((p) => p.phoneme).join("")}/`
                                : null;
                            // A word close under the bar reads "casi"
                            // instead of its fail count — encouragement.
                            const close =
                              lastW !== undefined &&
                              lastW.accuracy >= threshold - 10;
                            const scoreCls =
                              lastW === undefined ? "" : scoreTone(lastW.accuracy);
                            return (
                              <button
                                key={w}
                                className="ptw-row"
                                tabIndex={-1}
                                title="Click para oírla"
                                style={{ animationDelay: `${Math.min(i * 25, 150)}ms` }}
                                onClick={() => onWordClick(w)}
                              >
                                <span className="ptw-main">
                                  <span className="ptw-word">{w}</span>
                                  <span className="ptw-sub">
                                    {close
                                      ? "casi"
                                      : `fallada ${c} ${c > 1 ? "veces" : "vez"}`}
                                    {ipa ? ` · ${ipa}` : ""}
                                  </span>
                                </span>
                                {lastW && (
                                  <span className={`ptw-score ${scoreCls}`}>
                                    {lastW.accuracy.toFixed(0)}
                                  </span>
                                )}
                              </button>
                            );
                          },
                        )}
                      </div>
                      {worstWords().length > 6 && (
                        <button
                          className="pt-link ptw-more"
                          tabIndex={-1}
                          onClick={() => {
                            G.chipsOpen = !G.chipsOpen;
                            rerender();
                          }}
                        >
                          {G.chipsOpen ? "− menos" : `+${worstWords().length - 6} más`}
                        </button>
                      )}
                    </div>
                  )}
                  <div className="pt-scorecard">
                    <div className="sc-label">Puntaje</div>
                    <div className="sc-pct">
                      {G.lastAssessment.accuracy.toFixed(0)}
                      <small>%</small>
                    </div>
                    {(G.bestHp[t.id] ?? 0) > G.lastAssessment.accuracy && (
                      <div className="sc-line">
                        mejor <b>{(G.bestHp[t.id] ?? 0).toFixed(0)}%</b>
                      </div>
                    )}
                    {(() => {
                      // Score over the bar but blocked by red words: the
                      // number alone reads as a win, so say why it isn't.
                      const reds = (isMultiword(t)
                        ? G.lastAssessment.words
                            .filter((w) => !w.errorType.includes("Insertion"))
                            .map((w) => w.accuracy)
                        : (G.lastAssessment.words[0]?.phonemes ?? []).map(
                            (p) => p.accuracy,
                          )
                      ).filter((s) => s < RED_CUTOFF).length;
                      return G.lastAssessment.accuracy >= threshold && reds > 0 ? (
                        <div className="sc-flag">
                          bloqueado por {reds}{" "}
                          {isMultiword(t) ? "palabra" : "sonido"}
                          {reds > 1 ? "s" : ""} en rojo
                        </div>
                      ) : null;
                    })()}
                  </div>
                </div>
              )}

              {/* coach tip (DeepSeek) */}
              {G.coach.mode !== "hidden" && (
                <div className={`pt-coach${G.coach.mode === "shown" ? " shown" : ""}`}>
                  <Brain size={13} />{" "}
                  {G.coach.mode === "loading" ? "pensando un consejo…" : G.coach.text}
                </div>
              )}

            </section>

            {/* side rail: the paragraph route */}
            <aside className="pt-rail">{railRows(false)}</aside>
          </div>

          {/* PRACTICE: action bar at bottom — always present */}
          <div className="pt-actionbar">
            <div className="footbar-inner">
              {barContent().title && (
                <div className="ab-text">
                  <div className={`ab-title ${barContent().cls}`}>
                    {barContent().title}
                  </div>
                  {barContent().sub && (
                    <div className="ab-sub">{barContent().sub}</div>
                  )}
                </div>
              )}
              <span className="bar-spacer" />
              {G.screen !== "recording" && (
                <>
                  {t.kind === "word" && G.practiceOriginId !== null && (
                    <button
                      className="pt-btn"
                      tabIndex={-1}
                      onClick={onPracticeWorst}
                      disabled={G.busy}
                    >
                      <CornerUpLeft size={14} /> Salir de práctica
                    </button>
                  )}
                  {G.screen === "pass" && (
                    <button
                      className="pt-btn"
                      tabIndex={-1}
                      onClick={onRetry}
                      disabled={G.busy}
                    >
                      <RotateCcw size={14} /> Reintentar
                    </button>
                  )}
                  {isMultiword(t) && worstWords().length > 0 && (
                    <button
                      className="pt-btn success"
                      tabIndex={-1}
                      onClick={onPracticeWorst}
                      disabled={G.busy}
                    >
                      <Zap size={14} /> Practicar {worstWords().length} palabra
                      {worstWords().length > 1 ? "s" : ""}
                    </button>
                  )}
                  <button
                    className="pt-btn primary"
                    tabIndex={-1}
                    onClick={onPrimary}
                    disabled={G.busy}
                  >
                    {!G.busyLabel && G.screen !== "pass" && <Mic size={14} />}
                    {primaryLabel()}
                    {!G.busyLabel && G.screen === "pass" && <ArrowRight size={14} />}
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {/* rail drawer (narrow screens) */}
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

      {G.showSettings && (
        <SettingsModal
          settings={G.settings}
          fontDelta={G.fontDelta}
          onFont={(step) => {
            G.fontDelta = Math.max(-6, Math.min(16, G.fontDelta + step));
            rerender();
          }}
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

// ---------------------------------------------------------------- settings
function SettingsModal(props: {
  settings: Settings;
  fontDelta: number;
  onFont: (step: number) => void;
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
          {field("Nivel CEFR", "cefrLevel", { placeholder: "A1…C2" })}
          <div className="pt-field">
            <label>Tamaño del texto</label>
            <div className="pt-font-controls">
              <button
                className="pt-btn sm"
                onClick={() => props.onFont(-2)}
                title="Achicar el texto a leer"
              >
                A−
              </button>
              <span className="font-val">
                {props.fontDelta > 0 ? `+${props.fontDelta}` : props.fontDelta}
              </span>
              <button
                className="pt-btn sm"
                onClick={() => props.onFont(+2)}
                title="Agrandar el texto a leer"
              >
                A+
              </button>
            </div>
          </div>
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

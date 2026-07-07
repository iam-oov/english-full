/** English Boss.
 *
 * Start screen "1d": paragraph or image as input (cards side by side) and
 * microphone + test + Start in a single bar.
 *
 * Game/practice "3b - Side rail" (light theme): the center is for the sentence
 * with the PER-WORD feedback inline (highlight + superscript score); the
 * paragraph's route lives in a rail on the right (click navigates); actions
 * are visible buttons with their keyboard shortcut as a hint.
 *
 * Architecture: this component owns the whole UI and state machine. It only
 * knows the ports (scorer/coach/audio/ocr/progress); no Azure here.
 *
 * Concurrency model: async/await plus the `gen` counter that invalidates
 * stale async work (a coach tip or an assessment arriving after a reset is
 * discarded).
 *
 * Demo mode: with ?demo in the URL the scorer is replaced by a canned stub
 * (src/lib/demo.ts) - full visual QA without a mic or Azure key.
 */

import { useEffect, useReducer, useRef } from "react";
import {
  ArrowRight,
  Brain,
  Check,
  Crown,
  Ear,
  Headphones,
  Image as ImageIcon,
  Mic,
  RotateCcw,
  Settings as SettingsIcon,
  Square,
  Upload,
  Volume2,
  X,
  Zap,
} from "lucide-react";

import {
  KEYS,
  buildTargets,
  failHint,
  isContinuous,
  isLongForm,
  isMultiword,
  splitSentences,
  type Target,
} from "../lib/game";
import {
  assessmentUnits,
  judge,
  judgeAssessment,
  redCount,
  scoreBand,
} from "../lib/scoring";
import { alignWords, type Alignment } from "../lib/align";
import {
  CHALLENGE_MAX_WORDS,
  CLIP_PAD_AFTER_MS,
  CLIP_PAD_BEFORE_MS,
  LEVEL_PRESETS,
  MIN_SILENCE_MS,
  MIN_THRESHOLD,
  UI_FONT_BASE_PX,
} from "../lib/constants";
import {
  DEFAULT_SETTINGS,
  clampRedCutoff,
  clampSilence,
  clampThreshold,
  clampUiFontDelta,
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
import { createDemoScorer } from "../lib/demo";
import type { ScorerPort } from "../lib/ports";
import {
  listMicrophones,
  playClip,
  playRecording,
  recordTest,
  stopPlayback,
  type MicOption,
} from "../lib/audio";
import { cleanOcrText, extractTextFromImage } from "../lib/ocr";
import { clearRun, loadRun, saveRun, type SavedRun } from "../lib/run";
import { VERSION } from "../../version";
import { assessmentOk, type Assessment } from "../lib/types";

type Screen = "input" | "ready" | "recording" | "fail" | "pass" | "win";
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

/** Mutable game state. Lives in a ref and
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
  playingMine: boolean;
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
  streak: number;
  combo: number;
  runXp: number;
  bestHp: Record<number, number>;
  fontDelta: number;
  // --- visual feedback ---
  badge: UiText & { live?: boolean };
  feedback: UiText;
  coach: {
    mode: "hidden" | "loading" | "shown";
    text: string;
    word?: string;
    ipa?: string;
  };
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
  playingMine: false,
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
  streak: 0,
  combo: 0,
  runXp: 0,
  bestHp: {},
  fontDelta: 0,
  badge: { text: "", tone: "c-dim" },
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

export default function EnglishBoss() {
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
    return G.errors[t.id] ?? {};
  };

  /** Practice list, worst first: last-attempt score ascending (a word the
   * player never said this attempt goes last), fail count breaks ties. */
  const worstWords = (): Array<[string, number]> => {
    const scoreOf = (w: string): number => {
      const hit = G.lastAssessment?.words.find(
        (x) =>
          x.word.toLowerCase() === w.toLowerCase() &&
          !x.errorType.includes("Insertion"),
      );
      return hit ? hit.accuracy : Number.POSITIVE_INFINITY;
    };
    return Object.entries(curErrors()).sort(
      (a, b) => scoreOf(a[0]) - scoreOf(b[0]) || b[1] - a[1],
    );
  };

  const bossIndex = (): number | null => {
    const i = G.targets.findIndex((t) => t.kind === "boss");
    return i >= 0 ? i : null;
  };

  /** Persist the in-progress run so a refresh restores it. State is saved
   * positionally over the multiword targets (ids are runtime-only); practice
   * drills are ephemeral and resolve to their origin sentence. */
  const persistRun = () => {
    if (!hasGame() || G.screen === "win" || G.screen === "recording") return;
    const base = G.targets;
    const sentences = base
      .filter((x) => x.kind === "sentence")
      .map((x) => x.reference);
    if (sentences.length === 0) return;
    saveRun({
      sentences,
      index: G.index,
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
    });
  };

  /** Rebuilds the saved run and re-derives the post-attempt view from the
   * persisted assessment under CURRENT rules, so a rule or threshold change
   * never leaves a stale verdict on screen. */
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

    G.targets = targets;
    G.index = Math.min(Math.max(0, saved.index), targets.length - 1);

    G.streak = saved.streak;
    G.combo = saved.combo;
    G.runXp = saved.runXp;
    G.totalAttempts = saved.totalAttempts;
    G.wordAttempts = saved.wordAttempts;

    G.lastAssessment = saved.assessment
      ? { ...saved.assessment, audioUrl: null }
      : null;
    G.badge = { text: "", tone: "c-dim" };
    G.feedback = { text: "", tone: "c-muted" };
    G.screen = G.lastAssessment ? saved.screen : "ready";

    let cur = G.targets[G.index];
    const a = G.lastAssessment;
    if (cur && cur.kind === "challenge") {
      if (a && (G.screen === "fail" || G.screen === "pass")) {
        // Rebuild the gauntlet exactly as it was read, from the assessment.
        const said = a.words
          .filter((w) => !w.errorType.includes("Insertion"))
          .map((w) => w.word);
        cur.reference = said.join(", ");
        cur.label = cur.reference;
      } else if (!prepareChallenge(cur)) {
        G.statusById[cur.id] = "defeated";
        G.index = Math.min(G.index + 1, G.targets.length - 1);
        cur = G.targets[G.index];
      }
    }
    if (a && cur && (G.screen === "fail" || G.screen === "pass")) {
      const multiword = isMultiword(cur);
      const verdict = judgeAssessment(
        a,
        multiword,
        G.settings.passThreshold,
        G.settings.redCutoff,
      );
      G.screen = verdict.passed ? "pass" : "fail";
      G.statusById[cur.id] = verdict.passed ? "defeated" : "failed";
      G.feedback = {
        text: verdict.passed
          ? `Superaste el umbral (${G.settings.passThreshold.toFixed(0)}%) sin ${multiword ? "palabras" : "sonidos"} en rojo.`
          : failHint(a, multiword, G.settings.passThreshold),
        tone: "c-muted",
      };
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

  const assessAbort = useRef<AbortController | null>(null);

  const reset = () => {
    // Panic button: discards the game. gen++ invalidates any in-flight
    // async work (a late assessment/TTS/tip is discarded).
    stopPlayback();
    G.playingMine = false;
    G.busy = false;
    G.busyLabel = null;
    G.lastAudioUrl = null;
    G.gen += 1;
    assessAbort.current?.abort();
    clearRun();
    showInput();
  };

  /** Hardest pending words across the whole run (gauntlet buckets excluded:
   * misses there already live in the sentence that produced them). */
  const challengeWords = (): string[] => {
    const kindById = new Map(G.targets.map((x) => [x.id, x.kind]));
    const tally: Record<string, number> = {};
    for (const [id, errs] of Object.entries(G.errors)) {
      if (kindById.get(Number(id)) === "challenge") continue;
      for (const [w, c] of Object.entries(errs)) tally[w] = (tally[w] ?? 0) + c;
    }
    return Object.entries(tally)
      .sort((x, y) => y[1] - x[1])
      .slice(0, CHALLENGE_MAX_WORDS)
      .map(([w]) => w);
  };

  /** Materializes the gauntlet on arrival. False = nothing to drill. */
  const prepareChallenge = (target: Target): boolean => {
    const words = challengeWords();
    if (words.length === 0) return false;
    target.reference = words.join(", ");
    target.label = target.reference;
    return true;
  };

  const enterReady = () => {
    G.screen = "ready";
    const cur = current();
    if (cur && cur.kind === "challenge" && !prepareChallenge(cur)) {
      // Free pass: no hard words earned yet — the gauntlet bows out.
      G.statusById[cur.id] = "defeated";
      if (G.index < G.targets.length - 1) G.index += 1;
      return enterReady();
    }
    G.gen += 1; // invalidates stale tips/results
    assessAbort.current?.abort();
    G.wordAttempts = 0;
    stopPlayback();
    G.playingMine = false;
    G.lastAudioUrl = null; // previous target's recording no longer applies
    G.chipsOpen = false; // expanded chips belong to previous target
    setBadge("", "c-dim");
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
    stopPlayback();
    G.playingMine = false;
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
    setFeedback("Esperá la luz azul. Todavía NO hables.", "c-dim");
    rerender();

    assessAbort.current?.abort();
    assessAbort.current = new AbortController();
    scorer()
      .assess(t.reference, {
        onStatus: (code) => {
          if (G.gen === myGen && G.screen === "recording") setRecordingStatus(code);
        },
        deviceId: G.micChosen,
        longForm: isLongForm(t),
        continuous: isContinuous(t),
        signal: assessAbort.current.signal,
      })
      .then((a) => {
        if (G.gen !== myGen || !hasGame() || G.screen === "input") return;
        onAssessment(a);
      });
  };

  const requestTip = (a: Assessment) => {
    const t = current();
    if (!t) return;
    // Drill: the word itself. Sentence: the worst red word gets the tip.
    let word = t.reference;
    let source = a.words[0];
    let attempts = G.wordAttempts;
    if (isMultiword(t)) {
      const red = a.words
        .filter(
          (w) =>
            !w.errorType.includes("Insertion") &&
            w.accuracy <= G.settings.redCutoff,
        )
        .sort((x, y) => x.accuracy - y.accuracy)[0];
      if (!red) return;
      word = red.word;
      source = red;
      attempts = curErrors()[red.word] ?? 1;
    }
    const phonemes: Array<[string, number]> = (source?.phonemes ?? []).map(
      (p) => [p.phoneme, p.accuracy],
    );
    const ipa =
      phonemes.length > 0
        ? `/${phonemes.map(([ph]) => ph).join("")}/`
        : undefined;
    G.coach = { mode: "loading", text: "", word, ipa };
    const myGen = G.gen; // if context changes before arrival, it's discarded
    coach()
      .tip(word, phonemes, a.recognizedText, attempts, G.totalAttempts)
      .then((tip) => {
        if (myGen !== G.gen || G.screen !== "fail") return;
        G.coach = tip
          ? { mode: "shown", text: tip, word, ipa }
          : { mode: "hidden", text: "" };
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
      clearAssessment();
      coachClear();
      setFeedback("", "c-muted"); // the pill already carries the error
      rerender();
      return;
    }

    const multiword = isMultiword(t);
    const threshold = G.settings.passThreshold;
    G.lastAssessment = a; // feeds inline feedback (sentence or phonemes)

    const units = assessmentUnits(a, multiword);
    if (multiword) {
      if (t.kind === "challenge") {
        // Gauntlet mastery: a word at/above the bar leaves EVERY list; a miss
        // keeps living in the sentence that produced it (no double counting).
        for (const [word, score] of units) {
          if (score >= threshold) {
            for (const errs of Object.values(G.errors)) delete errs[word];
          }
        }
      } else {
        // Per-word error counter: +1 for those below threshold; those that DO
        // reach it leave the list (mastered). Feeds the word gauntlets.
        const errs = (G.errors[t.id] ??= {});
        for (const [word, score] of units) {
          if (score < threshold) errs[word] = (errs[word] ?? 0) + 1;
          else delete errs[word];
        }
      }
      // Combo: consecutive PERFECT words (>= max(threshold, 97)), spans attempts.
      const perfectBar = Math.max(threshold, 97);
      for (const [, score] of units) {
        G.combo = score >= perfectBar ? G.combo + 1 : 0;
      }
    }

    G.bestHp[t.id] = Math.max(G.bestHp[t.id] ?? 0, a.accuracy);
    const verdict = judge(units, {
      accuracy: a.accuracy,
      threshold,
      redCutoff: G.settings.redCutoff,
    });

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
      setFeedback(
        `Superaste el umbral (${threshold.toFixed(0)}%) sin ${multiword ? "palabras" : "sonidos"} en rojo.`,
      );
      coachClear();
    } else {
      G.screen = "fail";
      G.streak = 0;
      G.combo = 0;
      flash("red");
      const partial = verdict.worstScore > G.settings.redCutoff;
      setBadge("", partial ? "c-amber" : "c-red");
      setFeedback(failHint(a, multiword, threshold));
      // DeepSeek tip: word drills always; sentences when a red word blocks.
      const redBlocked =
        multiword && redCount(a, true, G.settings.redCutoff) > 0;
      if (coach().available && (!multiword || redBlocked)) {
        requestTip(a);
      } else {
        coachClear();
      }
    }
    persistRun();
    rerender();
  };

  const startTts = (text: string) => {
    stopPlayback();
    G.playingMine = false;
    G.busy = true;
    G.busyLabel = "Reproduciendo…";
    const myGen = G.gen;
    rerender();
    scorer()
      .speak(text)
      .then((err) => {
        if (G.gen !== myGen) return;
        G.busy = false;
        G.busyLabel = null;
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

  const onHome = () => {
    if (G.screen === "input") return;
    // Home = start sheet. The saved run stays: a refresh restores the game.
    stopPlayback();
    G.playingMine = false;
    G.busy = false;
    G.busyLabel = null;
    G.gen += 1;
    assessAbort.current?.abort();
    showInput();
  };

  const onPlayMine = () => {
    if (G.screen === "input" || G.screen === "win" || !hasGame()) return;
    if (G.playingMine) {
      // Toggle: cut it short; the pending promise resolves and cleans up.
      stopPlayback();
      return;
    }
    if (G.busy) return;
    if (!G.lastAudioUrl) {
      const msg =
        G.screen === "fail" || G.screen === "pass"
          ? "Grabaste, pero no pude guardar el audio de ese micrófono."
          : "Todavía no grabaste nada. Grabá primero y después escuchate.";
      setFeedback(msg, "c-dim");
      rerender();
      return;
    }
    G.playingMine = true;
    const myGen = G.gen;
    rerender();
    playRecording(G.lastAudioUrl).then((err) => {
      if (G.gen !== myGen) return;
      G.playingMine = false;
      if (err) setFeedback(String(err), "c-red");
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
    applyUiFont(G.settings);
    G.stats = loadStats();
    G.paragraph = loadParagraph();
    const saved = loadRun();
    if (saved && !restoreRun(saved)) clearRun();
    rerender();
    refreshMics();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshMics);
    const onKeyDown = (e: KeyboardEvent) => handleKeyRef.current(e);
    window.addEventListener("keydown", onKeyDown);
    const setAppHeight = () => {
      const h = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--app-h", `${Math.round(h)}px`);
    };
    setAppHeight();
    window.visualViewport?.addEventListener("resize", setAppHeight);
    window.addEventListener("resize", setAppHeight);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.visualViewport?.removeEventListener("resize", setAppHeight);
      window.removeEventListener("resize", setAppHeight);
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshMics);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------ derived
  const t = current();
  const inGame = hasGame() && G.screen !== "input" && G.screen !== "win";
  const threshold = G.settings.passThreshold;

  const rows = G.targets;
  const activeRailId = t === null ? null : t.id;

  /** Alignment for inline feedback (only with assessment and multiword). */
  const aligned: Alignment | null =
    t !== null && isMultiword(t) && G.lastAssessment !== null
      ? alignWords(t.reference, G.lastAssessment.words)
      : null;

  /** Traffic light bands from scoring.ts — single source for BOTH the inline
   * sentence and the practice table so the colors never drift apart. */
  const tokClass = (score: number): string =>
    ({ ok: "", blue: " watch", amber: " warn", red: " bad" })[
      scoreBand(score, threshold, G.settings.redCutoff)
    ];
  const scoreTone = (score: number): string =>
    ({ ok: "c-accent", blue: "c-accent", amber: "c-amber", red: "c-red" })[
      scoreBand(score, threshold, G.settings.redCutoff)
    ];

  const metaLabel = (): string => {
    if (!t) return "";
    let base: string;
    if (t.kind === "boss") {
      base = "Jefe final";
    } else if (t.kind === "challenge") {
      base = "Reto de palabras";
    } else {
      const sentences = rows.filter((r) => r.kind === "sentence");
      const pos = sentences.findIndex((r) => r.id === t.id) + 1;
      base = `Oración ${pos} de ${sentences.length}`;
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
      base = t.label.length > 220 ? 20 : 23;
      floor = 12;
    } else {
      base = t.label.length > 90 ? 24 : 28;
      floor = 12;
    }
    return Math.max(floor, base + G.fontDelta);
  };

  /** What the current target is, for bar text. */
  const thingLabel = (): string =>
    !t ? "" : t.kind === "boss" ? "el párrafo" : t.kind === "challenge" ? "el reto" : "la oración";

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
      const reds = redCount(a, true, G.settings.redCutoff);
      const unit = "palabra";
      return {
        title: "Sigue practicando",
        cls: "c-fg",
        sub:
          reds > 0
            ? `saca del rojo ${reds} ${unit}${reds > 1 ? "s" : ""} para derrotar ${thingLabel()}`
            : `tu promedio quedó en ${a.accuracy.toFixed(0)}%: necesitas ${threshold.toFixed(0)}% o más`,
      };
    }
    if (G.screen !== "ready") return { title: "", cls: "c-fg", sub: "" };
    const que =
      t.kind === "boss"
        ? "Leé TODO el párrafo, podés pausar entre oraciones."
        : t.kind === "challenge"
          ? "Tus palabras difíciles: léelas una por una, fuerte y claro."
          : "Leé la oración completa, fuerte y claro.";
    return { title: "A leer", cls: "c-fg", sub: que };
  };

  /** Celebration card title/CTA ("6a"). */
  const defeatTitle = (): string =>
    !t
      ? ""
      : t.kind === "boss"
        ? "¡Jefe derrotado!"
        : t.kind === "challenge"
          ? "¡Reto superado!"
          : "¡Oración derrotada!";
  const nextLabel = (): string =>
    G.index >= G.targets.length - 1 ? "Terminar" : "Siguiente oración";


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
          : G.wordAttempts >= 1
            ? `${G.wordAttempts} intento${G.wordAttempts > 1 ? "s" : ""}`
            : null;
        const sentenceNo =
          target.kind === "sentence"
            ? rows.filter((r) => r.kind === "sentence").findIndex((r) => r.id === target.id) + 1
            : 0;
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
              {target.kind === "boss" ? (
                <Crown size={11} />
              ) : target.kind === "challenge" ? (
                <Zap size={11} />
              ) : (
                sentenceNo
              )}
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
          <button className="pt-brand-link" onClick={onHome} title="Ir al inicio">
            <span className="brand-dot" />
            English Boss
          </button>
          <span className="pt-version" title="Versión desplegada">
            {VERSION}
            {import.meta.env.DEV ? "-dev" : ""}
          </span>
          <span className="pt-credit">
            Construido por{" "}
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
                {/* left card: image dropzone (OCR) */}
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
                  <div className="drop-title">Soltá una imagen</div>
                  <div className="drop-desc">
                    Extraemos el texto de la foto (apunte, libro, captura) y
                    armamos los sub-jefes por ti.
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

                {/* right card: paste/type paragraph */}
                <div className="pt-card">
                  <div className="pt-card-head">
                    <div className="pt-card-label">≣ …o pegá un párrafo</div>
                    {G.paragraph.trim().length > 0 && (
                      <button
                        className="pt-link"
                        tabIndex={-1}
                        title="Vaciar el párrafo"
                        onClick={() => {
                          G.paragraph = "";
                          saveParagraph("");
                          rerender();
                        }}
                      >
                        <X size={11} /> limpiar
                      </button>
                    )}
                  </div>
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

              {/* READ: the speaker lives INSIDE the sentence flow — the
                  text gets the full stage width. */}
              <div className="pt-readrow">
                <div className="pt-readbody">
                  {(
                    <p className="pt-sentence" style={{ fontSize: sentenceFontSize() }}>
                      <button
                        className="pt-speak inline"
                        tabIndex={-1}
                        onClick={onRepeat}
                        disabled={G.busy}
                        title={`Escuchar cómo se dice (${keyLabel("correct")})`}
                      >
                        <Volume2 size={14} />
                      </button>{" "}
                      {aligned
                        ? aligned.tokens.map((tok, i) => {
                          const cls = tok.omitted
                            ? " omit"
                            : tok.score
                              ? tokClass(tok.score.accuracy)
                              : "";
                          const showSup =
                            tok.score !== null &&
                            (tok.omitted || tok.score.accuracy < threshold);
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
                                      {tok.omitted
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
                  disabled={(G.busy || !G.lastAudioUrl) && !G.playingMine}
                  title={
                    G.playingMine
                      ? "Detener la reproducción"
                      : G.lastAudioUrl
                        ? `Escuchar tu última grabación (${keyLabel("mine")})`
                        : "Grabá primero para poder escucharte"
                  }
                >
                  {G.playingMine ? (
                    <>
                      <Square size={13} /> Detener
                    </>
                  ) : (
                    <>
                      <Ear size={13} /> Escucha tu respuesta
                    </>
                  )}
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
                  style={{ fontSize: Math.max(13, 16 + G.fontDelta) }}
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
                      <button className="pt-link" tabIndex={-1} onClick={onRetry}>
                        reintentar
                      </button>
                      {" · aparecerán en el próximo reto ⚡"}
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
                            // Blue rows are the least urgent: on phones they
                            // pack two per row instead of a full one each.
                            const compact =
                              lastW !== undefined &&
                              ["blue", "ok"].includes(
                                scoreBand(lastW.accuracy, threshold, G.settings.redCutoff),
                              );
                            return (
                              <button
                                key={w}
                                className={`ptw-row${compact ? " compact" : ""}`}
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
                                {G.lastAudioUrl &&
                                  lastW?.offsetMs !== undefined &&
                                  lastW.durationMs !== undefined && (
                                    <span
                                      className="ptw-clip"
                                      role="button"
                                      title="Escuchar cómo la dijiste"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        stopPlayback();
                                        void playClip(
                                          G.lastAudioUrl!,
                                          lastW.offsetMs! - CLIP_PAD_BEFORE_MS,
                                          lastW.durationMs! +
                                            CLIP_PAD_BEFORE_MS +
                                            CLIP_PAD_AFTER_MS,
                                        );
                                      }}
                                    >
                                      <Ear size={13} />
                                    </span>
                                  )}
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
                      const reds = redCount(
                        G.lastAssessment,
                        isMultiword(t),
                        G.settings.redCutoff,
                      );
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
                  <div className="pt-coach-head">
                    <span className="pt-coach-tag">
                      <Brain size={13} /> Coach
                    </span>
                    {G.coach.word && (
                      <span className="pt-coach-word">
                        {G.coach.word}
                        {G.coach.ipa && (
                          <span className="pt-coach-ipa"> · {G.coach.ipa}</span>
                        )}
                      </span>
                    )}
                  </div>
                  {G.coach.mode === "loading"
                    ? "pensando un consejo…"
                    : G.coach.text}
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
            applyUiFont(G.settings); // drop any unsaved font preview
            rerender();
          }}
          onSave={(s) => {
            G.settings = s;
            saveSettings(s);
            applyUiFont(s);
            G.showSettings = false;
            rerender();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- settings
const applyUiFont = (s: Settings) => {
  document.documentElement.style.fontSize = `${UI_FONT_BASE_PX + s.uiFontDelta}px`;
};

function SettingsModal(props: {
  settings: Settings;
  fontDelta: number;
  onFont: (step: number) => void;
  onClose: () => void;
  onSave: (s: Settings) => void;
}) {
  const draft = useRef<Settings>({ ...props.settings });
  const [, force] = useReducer((x: number) => x + 1, 0);
  const connTest = useRef<{ text: string; tone: string } | null>(null);

  /** Pinpoints "error 1006" causes without guessing: an issueToken call
   * validates region (DNS) and key (401) in one shot. */
  const testConnection = async () => {
    const region = draft.current.speechRegion.trim();
    const key = draft.current.speechKey.trim();
    if (!region || !key) {
      connTest.current = { text: "Falta la key o la región.", tone: "c-red" };
      force();
      return;
    }
    connTest.current = { text: "Probando conexión…", tone: "c-accent" };
    force();
    try {
      const resp = await fetch(
        `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
        {
          method: "POST",
          headers: { "Ocp-Apim-Subscription-Key": key },
          signal: AbortSignal.timeout(10_000),
        },
      );
      connTest.current = resp.ok
        ? { text: "✓ Conexión OK: región y key válidas.", tone: "c-green" }
        : resp.status === 401 || resp.status === 403
          ? {
              text: "✗ La región responde pero la key es inválida (o es de otra región).",
              tone: "c-red",
            }
          : { text: `✗ El servidor respondió ${resp.status}.`, tone: "c-red" };
    } catch {
      connTest.current = {
        text: `✗ No existe/no responde el servidor para la región "${region}". Usa el identificador corto (ej. eastus, westus2), o tu red bloquea Azure.`,
        tone: "c-red",
      };
    }
    force();
  };

  const dsTest = useRef<{ text: string; tone: string } | null>(null);
  const testDeepSeek = async () => {
    const key = draft.current.deepseekKey.trim();
    const base = draft.current.deepseekBaseUrl.trim().replace(/\/+$/, "");
    if (!key) {
      dsTest.current = { text: "Falta la key de DeepSeek.", tone: "c-red" };
      force();
      return;
    }
    dsTest.current = { text: "Probando conexión…", tone: "c-accent" };
    force();
    try {
      const resp = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      });
      dsTest.current = resp.ok
        ? { text: "✓ Conexión OK: el coach con IA está disponible.", tone: "c-green" }
        : resp.status === 401 || resp.status === 403
          ? { text: "✗ La key de DeepSeek es inválida.", tone: "c-red" }
          : { text: `✗ El servidor respondió ${resp.status}.`, tone: "c-red" };
    } catch {
      dsTest.current = {
        text: "✗ No se pudo conectar: el navegador o tu red bloquea la API (CORS). El juego usará las pistas estáticas.",
        tone: "c-red",
      };
    }
    force();
  };

  const outOfRange = (
    key: keyof Settings,
    opts: { min?: number; max?: number },
  ): boolean => {
    const v = draft.current[key];
    if (typeof v !== "number") return false;
    return (
      !Number.isFinite(v) ||
      (opts.min !== undefined && v < opts.min) ||
      (opts.max !== undefined && v > opts.max)
    );
  };

  const draftValid =
    !outOfRange("passThreshold", { min: MIN_THRESHOLD, max: 100 }) &&
    !outOfRange("redCutoff", { min: 0, max: 79 }) &&
    !outOfRange("endSilenceMs", { min: MIN_SILENCE_MS, max: 10000 });

  const locked = draft.current.level !== "custom";

  const field = (
    label: string,
    key: keyof Settings,
    opts: {
      type?: string;
      placeholder?: string;
      min?: number;
      max?: number;
      locked?: boolean;
    } = {},
  ) => {
    const invalid = outOfRange(key, opts);
    return (
      <div className="pt-field">
        <label>{label}</label>
        <input
          type={opts.type ?? "text"}
          placeholder={opts.placeholder}
          min={opts.min}
          max={opts.max}
          disabled={opts.locked}
          className={invalid ? "invalid" : undefined}
          aria-invalid={invalid}
          value={String(draft.current[key])}
          onChange={(e) => {
            const value = e.target.value;
            const target = draft.current as unknown as Record<string, unknown>;
            target[key] = typeof props.settings[key] === "number" ? Number(value) || 0 : value;
            force();
          }}
        />
        {invalid && (
          <span className="pt-field-error">
            {opts.min !== undefined && opts.max !== undefined
              ? `Debe estar entre ${opts.min} y ${opts.max}`
              : "Valor inválido"}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="pt-modal-backdrop" onClick={props.onClose}>
      <div className="pt-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Ajustes</h2>
        <p className="note">
          Todo se guarda SOLO en tu navegador (localStorage). El scoring usa
          Azure Pronunciation Assessment: necesitás una key de Speech (el tier
          F0 gratis alcanza).
        </p>
        <div className="pt-refresh-row">
          <span className="c-muted">Versión {VERSION}</span>
          <button
            className="pt-btn sm"
            title="Recargar la app para traer la versión más reciente (útil en PWA instalada)"
            onClick={() => window.location.reload()}
          >
            <RotateCcw size={13} /> Refresh
          </button>
        </div>
        <fieldset>
          <legend>Azure Speech (obligatorio)</legend>
          {field("AZURE_SPEECH_KEY", "speechKey", { type: "password", placeholder: "tu key de Azure Speech" })}
          {field("Región", "speechRegion", { placeholder: "p. ej. eastus" })}
          <div className="pt-field">
            <label></label>
            <div className="pt-conn-test">
              <button className="pt-btn sm" onClick={testConnection}>
                Probar conexión
              </button>
              {connTest.current && (
                <span className={`conn-msg ${connTest.current.tone}`}>
                  {connTest.current.text}
                </span>
              )}
            </div>
          </div>
        </fieldset>
        <fieldset>
          <legend>Juego</legend>
          <div className="pt-field">
            <label>Nivel</label>
            <div className="pt-preset-row">
              {LEVEL_PRESETS.map((p) => (
                <button
                  key={p.key}
                  className={`pt-btn sm${draft.current.level === p.key ? " success" : ""}`}
                  title={`Umbral ${p.passThreshold} · corte de rojo ${p.redCutoff} · silencio ${p.endSilenceMs} ms`}
                  onClick={() => {
                    draft.current.level = p.key;
                    draft.current.passThreshold = p.passThreshold;
                    draft.current.redCutoff = p.redCutoff;
                    draft.current.endSilenceMs = p.endSilenceMs;
                    force();
                  }}
                >
                  {p.name}
                </button>
              ))}
              <button
                className={`pt-btn sm${draft.current.level === "custom" ? " success" : ""}`}
                title="Tú decides los números"
                onClick={() => {
                  draft.current.level = "custom";
                  force();
                }}
              >
                Custom
              </button>
            </div>
          </div>
          {field("Umbral de aprobado", "passThreshold", {
            type: "number",
            min: 80,
            max: 100,
            placeholder: "mínimo 80",
            locked,
          })}
          {field("Derrota por palabra", "redCutoff", {
            type: "number",
            min: 0,
            max: 79,
            placeholder: "≤ este número, la palabra veta el triunfo",
            locked,
          })}
          {field("Silencio de corte (ms)", "endSilenceMs", {
            type: "number",
            min: 300,
            max: 10000,
            placeholder: "menos = evalúa más rápido",
            locked,
          })}
          <div className="pt-field">
            <label>Tamaño de la plataforma</label>
            <div className="pt-font-controls">
              <button
                className="pt-btn sm"
                onClick={() => {
                  draft.current.uiFontDelta = clampUiFontDelta(
                    draft.current.uiFontDelta - 1,
                  );
                  applyUiFont(draft.current); // live preview; Cancel reverts
                  force();
                }}
                title="Achicar todo el texto de la plataforma"
              >
                A−
              </button>
              <span className="font-val">
                {draft.current.uiFontDelta > 0
                  ? `+${draft.current.uiFontDelta}`
                  : draft.current.uiFontDelta}
              </span>
              <button
                className="pt-btn sm"
                onClick={() => {
                  draft.current.uiFontDelta = clampUiFontDelta(
                    draft.current.uiFontDelta + 1,
                  );
                  applyUiFont(draft.current); // live preview; Cancel reverts
                  force();
                }}
                title="Agrandar todo el texto de la plataforma"
              >
                A+
              </button>
            </div>
          </div>
          <div className="pt-field">
            <label>Tamaño de la oración</label>
            <div className="pt-font-controls">
              <button
                className="pt-btn sm"
                onClick={() => props.onFont(-2)}
                title="Achicar la oración a leer"
              >
                A−
              </button>
              <span className="font-val">
                {props.fontDelta > 0 ? `+${props.fontDelta}` : props.fontDelta}
              </span>
              <button
                className="pt-btn sm"
                onClick={() => props.onFont(+2)}
                title="Agrandar la oración a leer"
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
          <div className="pt-field">
            <label></label>
            <div className="pt-conn-test">
              <button className="pt-btn sm" onClick={testDeepSeek}>
                Probar conexión
              </button>
              {dsTest.current && (
                <span className={`conn-msg ${dsTest.current.tone}`}>
                  {dsTest.current.text}
                </span>
              )}
            </div>
          </div>
        </fieldset>
        <div className="pt-modal-actions">
          <button className="pt-btn" onClick={props.onClose}>
            Cancelar
          </button>
          <button
            className="pt-btn primary"
            disabled={!draftValid}
            title={draftValid ? undefined : "Corrige los campos en rojo"}
            onClick={() => {
              // Mobile keyboards sneak spaces into pasted keys/regions, and a
              // "eastus " region breaks the SDK's WebSocket URL (error 1006).
              const clean = { ...draft.current } as unknown as Record<string, unknown>;
              for (const [k, v] of Object.entries(clean)) {
                if (typeof v === "string") clean[k] = v.trim();
              }
              const s = clean as unknown as Settings;
              s.passThreshold = clampThreshold(s.passThreshold);
              s.redCutoff = clampRedCutoff(s.redCutoff);
              s.endSilenceMs = clampSilence(s.endSilenceMs);
              props.onSave(s);
            }}
          >
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

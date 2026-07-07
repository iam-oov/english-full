/** Azure Speech adapter (JavaScript SDK): pronunciation assessment + TTS.
 *
 * This is the ONLY part that talks to Azure. The rest of the game asks
 * "assess this" and gets a clean `Assessment` back; if the engine is swapped
 * tomorrow, only this file changes. The own-voice capture for "hear your
 * voice" uses getUserMedia + MediaRecorder alongside the SDK's mic: if it
 * fails, scoring continues, only playback is lost.
 */

import * as sdk from "microsoft-cognitiveservices-speech-sdk";

import type { Assessment, PhonemeScore, WordScore } from "./types";
import { errorAssessment } from "./types";
import { TARGET_LANGUAGE, TTS_PITCH, TTS_RATE, TTS_VOICE } from "./constants";
import type { Settings } from "./config";
import type { AssessOptions, OnStatus, ScorerPort } from "./ports";

export type { AssessOptions, OnStatus, StatusCode } from "./ports";

/** A bare "Unable to contact server 1006" gives the player nothing to act
 * on; append the two usual culprits (region typo / browser shields). */
function cancelMessage(reason: string, errorDetails?: string): string {
  let msg = `Cancelado: ${reason}.`;
  if (errorDetails) msg += ` ${errorDetails}`;
  if (errorDetails?.includes("Unable to contact server")) {
    msg +=
      " — Revisa la región en Ajustes y, si usas Brave u otro bloqueador, desactiva los escudos para este sitio.";
  }
  return msg;
}

/** Shape of the detailed JSON the service returns (NBest[0]). */
interface RawWord {
  Word: string;
  /** 100-ns ticks from the start of the audio stream. */
  Offset?: number;
  Duration?: number;
  PronunciationAssessment?: { AccuracyScore?: number; ErrorType?: string };
  Phonemes?: Array<{
    Phoneme: string;
    PronunciationAssessment?: { AccuracyScore?: number };
  }>;
}

interface RawNBest {
  PronunciationAssessment?: {
    AccuracyScore?: number;
    PronScore?: number;
    CompletenessScore?: number;
    FluencyScore?: number;
  };
  Words?: RawWord[];
}

function parseNBest(json: string | undefined): RawNBest | null {
  if (!json) return null;
  try {
    const nbest: unknown = JSON.parse(json)?.NBest?.[0];
    return typeof nbest === "object" && nbest !== null
      ? (nbest as RawNBest)
      : null;
  } catch {
    return null;
  }
}

function parseWords(raw: RawWord[] | undefined): WordScore[] {
  return (raw ?? []).map((w) => {
    const phonemes: PhonemeScore[] = (w.Phonemes ?? []).map((p) => ({
      phoneme: p.Phoneme,
      accuracy: p.PronunciationAssessment?.AccuracyScore ?? 0,
    }));
    return {
      word: w.Word,
      accuracy: w.PronunciationAssessment?.AccuracyScore ?? 0,
      errorType: w.PronunciationAssessment?.ErrorType ?? "None",
      phonemes,
      offsetMs: w.Offset !== undefined ? w.Offset / 10_000 : undefined,
      durationMs: w.Duration !== undefined ? w.Duration / 10_000 : undefined,
    };
  });
}

/** Records your voice with MediaRecorder while Azure listens, so it can be
 * played back later. Best-effort: if the browser refuses, it returns null
 * and scoring continues as usual. */
class OwnVoiceCapture {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];

  async start(deviceId?: string): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      this.recorder = new MediaRecorder(this.stream);
      this.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };
      this.recorder.start();
    } catch {
      this.recorder = null; // no own-voice capture: only playback is lost
    }
  }

  async stop(): Promise<string | null> {
    const recorder = this.recorder;
    if (recorder === null) return null;
    const url = await new Promise<string | null>((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType });
        resolve(blob.size > 0 ? URL.createObjectURL(blob) : null);
      };
      try {
        recorder.stop();
      } catch {
        resolve(null);
      }
    });
    this.stream?.getTracks().forEach((t) => t.stop());
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    return url;
  }
}

export class Scorer implements ScorerPort {
  constructor(private settings: Settings) {}

  private speechConfig(longForm: boolean): sdk.SpeechConfig {
    // Trim defensively: settings saved with a stray space (mobile keyboards)
    // produce an invalid WebSocket host and a bare 1006 error.
    const config = sdk.SpeechConfig.fromSubscription(
      this.settings.speechKey.trim(),
      this.settings.speechRegion.trim(),
    );
    config.speechRecognitionLanguage = TARGET_LANGUAGE;
    // More patience to START speaking (default ~5s): avoids the "didn't hear you"
    // while the mic was still connecting.
    config.setProperty(
      sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
      "15000",
    );
    // Silence that marks the END of speech: more slack for sentences/paragraph.
    config.setProperty(
      sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
      String(longForm ? this.endSilenceMs() : Math.round(this.endSilenceMs() * 0.4)),
    );
    return config;
  }

  private endSilenceMs(): number {
    const v = this.settings.endSilenceMs;
    return Number.isFinite(v) && v >= 300 ? v : 1500;
  }

  private buildRecognizer(
    referenceText: string,
    opts: AssessOptions,
  ): sdk.SpeechRecognizer {
    const audioConfig = opts.deviceId
      ? sdk.AudioConfig.fromMicrophoneInput(opts.deviceId)
      : sdk.AudioConfig.fromDefaultMicrophoneInput();
    const recognizer = new sdk.SpeechRecognizer(
      this.speechConfig(opts.longForm ?? false),
      audioConfig,
    );
    const pronConfig = new sdk.PronunciationAssessmentConfig(
      referenceText,
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme,
      true, // enableMiscue
    );
    // IPA = the dictionaries' notation (ð, ɪ, w...), more useful for
    // learning than the default SAPI set (dh, ih, w...).
    pronConfig.phonemeAlphabet = "IPA";
    pronConfig.applyTo(recognizer);

    const onStatus = opts.onStatus;
    if (onStatus) {
      recognizer.sessionStarted = () => onStatus("listening");
      recognizer.speechStartDetected = () => onStatus("speech");
      if (!opts.continuous) {
        // In continuous mode we emit "processing" when we cut off ourselves.
        recognizer.speechEndDetected = () => onStatus("processing");
      }
    }
    return recognizer;
  }

  /** Listens to the microphone and assesses pronunciation against referenceText. */
  async assess(referenceText: string, opts: AssessOptions = {}): Promise<Assessment> {
    if (opts.signal?.aborted) return errorAssessment("Cancelado.");
    const capture = new OwnVoiceCapture();
    try {
      await capture.start(opts.deviceId);
      const recognizer = this.buildRecognizer(referenceText, opts);
      // An abandoned attempt must release the microphone immediately, not
      // after the recognizer's own timeout: two recognizers contending for
      // the mic is the failure mode this prevents.
      const onAbort = () => {
        try {
          if (opts.continuous) recognizer.stopContinuousRecognitionAsync();
          else recognizer.close();
        } catch {
          // already closed
        }
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      let assessment: Assessment;
      try {
        assessment = opts.continuous
          ? await this.recognizeContinuous(recognizer, referenceText, opts.onStatus)
          : await this.recognizeOnce(recognizer);
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
        try {
          recognizer.close();
        } catch {
          // already closed by abort
        }
      }
      assessment.audioUrl = await capture.stop();
      // Cross-check on "heard nothing": our own recording tells WHICH side
      // is deaf — the phone's mic or the recognition service.
      if (assessment.error?.startsWith("No te escuché")) {
        assessment.error += assessment.audioUrl
          ? " Tu micrófono SÍ grabó: usa «Escuchar tu respuesta» para verificar qué captó."
          : " Tu micrófono tampoco grabó nada localmente: revisa el permiso del mic o si otra app lo está usando.";
      }
      return assessment;
    } catch (exc) {
      await capture.stop();
      return errorAssessment(`Error al evaluar: ${String(exc)}`);
    }
  }

  private recognizeOnce(recognizer: sdk.SpeechRecognizer): Promise<Assessment> {
    return new Promise((resolve) => {
      recognizer.recognizeOnceAsync(
        (result) => resolve(this.toAssessment(result)),
        (err) => resolve(errorAssessment(`Error al evaluar: ${err}`)),
      );
    });
  }

  /** CONTINUOUS recognition (for the boss = the entire paragraph). Accumulates
   * the recognized phrases and cuts off after ~2.5s of prolonged silence. */
  private recognizeContinuous(
    recognizer: sdk.SpeechRecognizer,
    referenceText: string,
    onStatus?: OnStatus,
  ): Promise<Assessment> {
    return new Promise((resolve) => {
      const words: WordScore[] = [];
      const texts: string[] = [];
      const fluencies: number[] = [];
      let cancelMsg: string | null = null;
      let spoke = false;
      let last = performance.now(); // last moment with voice activity
      const start = last;

      const finish = () => {
        clearInterval(watchdog);
        onStatus?.("processing");
        recognizer.stopContinuousRecognitionAsync(
          () => resolve(build()),
          () => resolve(build()),
        );
      };

      const build = (): Assessment => {
        if (cancelMsg) {
          console.error("[scorer] continuous recognition canceled:", cancelMsg);
          return errorAssessment(cancelMsg);
        }
        if (words.length === 0) {
          const detail = `voz detectada: ${spoke ? "sí" : "no"} · frases reconocidas: ${texts.length} · ${((performance.now() - start) / 1000).toFixed(1)}s`;
          console.error("[scorer] continuous recognition heard nothing:", {
            speechDetected: spoke,
            recognizedTexts: texts,
            elapsedMs: Math.round(performance.now() - start),
          });
          return errorAssessment(`No te escuché (${detail}). Probá de nuevo.`);
        }
        const accuracy =
          words.reduce((acc, w) => acc + w.accuracy, 0) / words.length;
        const fluency =
          fluencies.length > 0
            ? fluencies.reduce((a, b) => a + b, 0) / fluencies.length
            : 0;
        const said = words.filter((w) => !w.errorType.includes("Omission")).length;
        const refCount = Math.max(1, referenceText.split(/\s+/).length);
        return {
          recognizedText: texts.join(" "),
          accuracy,
          pronunciation: accuracy,
          completeness: Math.min(100, (100 * said) / refCount),
          fluency,
          words,
          error: null,
          audioUrl: null,
        };
      };

      recognizer.recognizing = () => {
        last = performance.now();
      };
      recognizer.recognized = (_s, e) => {
        last = performance.now();
        if (e.result.reason !== sdk.ResultReason.RecognizedSpeech) return;
        if (e.result.text) texts.push(e.result.text);
        const nbest = parseNBest(
          e.result.properties.getProperty(
            sdk.PropertyId.SpeechServiceResponse_JsonResult,
          ),
        );
        if (!nbest) return;
        const fluency = nbest.PronunciationAssessment?.FluencyScore;
        if (fluency) fluencies.push(fluency);
        words.push(...parseWords(nbest.Words));
      };
      recognizer.speechStartDetected = () => {
        spoke = true;
        last = performance.now();
      };
      recognizer.canceled = (_s, e) => {
        cancelMsg = cancelMessage(sdk.CancellationReason[e.reason], e.errorDetails);
        finish();
      };

      const watchdog = setInterval(() => {
        const now = performance.now();
        if (spoke && now - last > this.endSilenceMs() + 500) finish();
        else if (!spoke && now - start > 15000) finish(); // you never started speaking
        else if (now - start > 180000) finish(); // safety cap
      }, 150);

      recognizer.startContinuousRecognitionAsync(
        () => {},
        (err) => {
          clearInterval(watchdog);
          resolve(errorAssessment(`Error al evaluar: ${err}`));
        },
      );
    });
  }

  /** SSML with the fixed voice profile. */
  private buildSsml(text: string): string {
    const safe = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return (
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ' +
      `xml:lang="${TARGET_LANGUAGE}">` +
      `<voice name="${TTS_VOICE}">` +
      `<prosody rate="${TTS_RATE}" pitch="${TTS_PITCH}">` +
      `${safe}</prosody></voice></speak>`
    );
  }

  /** Plays 'text' with a neural voice ("hear how it's said").
   * Returns an error message, or null on success. The promise resolves when
   * playback FINISHES (SpeakerAudioDestination.onAudioEnd), so the UI keeps
   * the 'busy' state while it plays. */
  speak(text: string): Promise<string | null> {
    return new Promise((resolve) => {
      let synthesizer: sdk.SpeechSynthesizer | null = null;
      let fallback: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const done = (err: string | null) => {
        // Idempotent: onAudioEnd, the fallback timer and the SDK callbacks race.
        if (settled) return;
        settled = true;
        if (fallback) clearTimeout(fallback);
        try {
          synthesizer?.close();
        } catch {
          // already closed
        }
        synthesizer = null;
        resolve(err);
      };
      try {
        const player = new sdk.SpeakerAudioDestination();
        const speechConfig = sdk.SpeechConfig.fromSubscription(
          this.settings.speechKey,
          this.settings.speechRegion,
        );
        synthesizer = new sdk.SpeechSynthesizer(
          speechConfig,
          sdk.AudioConfig.fromSpeakerOutput(player),
        );
        player.onAudioEnd = () => done(null);
        synthesizer.speakSsmlAsync(
          this.buildSsml(text),
          (result) => {
            if (result.reason === sdk.ResultReason.Canceled) {
              done(`TTS cancelado. ${result.errorDetails ?? ""}`.trim());
              return;
            }
            // onAudioEnd doesn't fire reliably in every browser; without a
            // fallback the game stays busy forever. audioDuration is in
            // 100ns ticks; the margin absorbs playback start latency.
            const playbackMs =
              result.audioDuration > 0 ? result.audioDuration / 10_000 : 5000;
            fallback = setTimeout(() => done(null), playbackMs + 1500);
          },
          (err) => done(`No pude reproducir el audio: ${err}`),
        );
      } catch (exc) {
        done(`No pude reproducir el audio: ${String(exc)}`);
      }
    });
  }

  /** Translation of the raw Azure result into our Assessment. */
  private toAssessment(result: sdk.SpeechRecognitionResult): Assessment {
    if (result.reason === sdk.ResultReason.NoMatch) {
      // Mobile players have no console, so the technical cause goes into
      // the UI message too (InitialSilenceTimeout = mic silent, ...).
      let detail = "sin detalles del SDK";
      try {
        const noMatch = sdk.NoMatchDetails.fromResult(result);
        const causes: Record<number, string> = {
          [sdk.NoMatchReason.InitialSilenceTimeout]:
            "no detecté voz, solo silencio inicial",
          [sdk.NoMatchReason.InitialBabbleTimeout]: "solo detecté ruido de fondo",
          [sdk.NoMatchReason.NotRecognized]:
            "detecté sonido pero no reconocí palabras",
        };
        detail = causes[noMatch.reason] ?? `NoMatchReason=${noMatch.reason}`;
        const seconds = Number(result.duration) / 10_000_000;
        if (Number.isFinite(seconds) && seconds > 0) {
          detail += ` · ${seconds.toFixed(1)}s de audio`;
        }
        console.error("[scorer] Azure NoMatch:", detail, {
          resultText: result.text,
          json: result.properties.getProperty(
            sdk.PropertyId.SpeechServiceResponse_JsonResult,
          ),
        });
      } catch (exc) {
        console.error("[scorer] Azure NoMatch (no details available):", exc);
      }
      return errorAssessment(`No te escuché (${detail}). Probá de nuevo.`);
    }
    if (result.reason === sdk.ResultReason.Canceled) {
      const details = sdk.CancellationDetails.fromResult(result);
      const msg = cancelMessage(
        sdk.CancellationReason[details.reason],
        details.errorDetails,
      );
      console.error("[scorer] Azure Canceled:", msg);
      return errorAssessment(msg);
    }

    const nbest = parseNBest(
      result.properties.getProperty(
        sdk.PropertyId.SpeechServiceResponse_JsonResult,
      ),
    );
    const pron = nbest?.PronunciationAssessment ?? {};
    return {
      recognizedText: result.text ?? "",
      accuracy: pron.AccuracyScore ?? 0,
      pronunciation: pron.PronScore ?? 0,
      completeness: pron.CompletenessScore ?? 0,
      fluency: pron.FluencyScore ?? 0,
      words: parseWords(nbest?.Words),
      error: null,
      audioUrl: null,
    };
  }
}

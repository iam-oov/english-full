/** Adapter de Azure Speech (SDK de JavaScript): pronunciation assessment + TTS.
 *
 * Es la ÚNICA parte que habla con Azure — espejo de `scorer.py`. El resto del
 * juego pide "evaluá esto" y recibe un `Assessment` limpio; si mañana se cambia
 * el motor, solo se toca este archivo.
 *
 * Diferencias con el escritorio, dictadas por el navegador:
 * - No hay hilos: el SDK de JS ya es asíncrono, así que `assess`/`speak`
 *   devuelven promesas y la UI simplemente las await-ea.
 * - La captura propia para "escuchá tu voz" usa getUserMedia + MediaRecorder
 *   en paralelo al mic del SDK (mismo rol que sounddevice + push stream en
 *   Python): si falla, el scoring sigue, solo se pierde la reproducción.
 */

import * as sdk from "microsoft-cognitiveservices-speech-sdk";

import type { Assessment, PhonemeScore, WordScore } from "./types";
import { errorAssessment } from "./types";
import type { Settings } from "./config";

export type StatusCode = "listening" | "speech" | "processing";
export type OnStatus = (code: StatusCode) => void;

export interface AssessOptions {
  onStatus?: OnStatus;
  /** deviceId del micrófono elegido; undefined = predeterminado del sistema */
  deviceId?: string;
  /** tolera pausas más largas entre palabras antes de cortar (oración/jefe) */
  longForm?: boolean;
  /** reconocimiento CONTINUO, sin el tope de ~15s de recognizeOnce (jefe) */
  continuous?: boolean;
}

/** Forma del JSON detallado que devuelve el servicio (NBest[0]). */
interface RawWord {
  Word: string;
  PronunciationAssessment?: { AccuracyScore?: number; ErrorType?: string };
  Phonemes?: Array<{
    Phoneme: string;
    PronunciationAssessment?: { AccuracyScore?: number };
  }>;
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
    };
  });
}

/** Graba tu voz con MediaRecorder mientras Azure escucha, para poder
 * reproducirla después. Best-effort: si el navegador no deja, se devuelve
 * null y el scoring sigue igual. */
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
      this.recorder = null; // sin captura propia: solo se pierde el playback
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

export class Scorer {
  constructor(private settings: Settings) {}

  private speechConfig(longForm: boolean): sdk.SpeechConfig {
    const config = sdk.SpeechConfig.fromSubscription(
      this.settings.speechKey,
      this.settings.speechRegion,
    );
    config.speechRecognitionLanguage = this.settings.targetLanguage;
    // Más paciencia para EMPEZAR a hablar (default ~5s): evita el "no te
    // escuché" mientras el mic todavía se estaba conectando.
    config.setProperty(
      sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
      "15000",
    );
    // Silencio que marca el FIN del habla: más margen en oraciones/párrafo.
    config.setProperty(
      sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
      longForm ? "3000" : "1200",
    );
    return config;
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
    // IPA = la notación de los diccionarios (ð, ɪ, w...), más útil para
    // aprender que el set SAPI por defecto (dh, ih, w...).
    pronConfig.phonemeAlphabet = "IPA";
    pronConfig.applyTo(recognizer);

    const onStatus = opts.onStatus;
    if (onStatus) {
      recognizer.sessionStarted = () => onStatus("listening");
      recognizer.speechStartDetected = () => onStatus("speech");
      if (!opts.continuous) {
        // En continuo el "processing" lo emitimos al cortar nosotros.
        recognizer.speechEndDetected = () => onStatus("processing");
      }
    }
    return recognizer;
  }

  /** Escucha el micrófono y evalúa la pronunciación contra referenceText. */
  async assess(referenceText: string, opts: AssessOptions = {}): Promise<Assessment> {
    const capture = new OwnVoiceCapture();
    try {
      await capture.start(opts.deviceId);
      const recognizer = this.buildRecognizer(referenceText, opts);
      let assessment: Assessment;
      try {
        assessment = opts.continuous
          ? await this.recognizeContinuous(recognizer, referenceText, opts.onStatus)
          : await this.recognizeOnce(recognizer);
      } finally {
        recognizer.close();
      }
      assessment.audioUrl = await capture.stop();
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

  /** Reconocimiento CONTINUO (para el jefe = párrafo entero). Acumula las
   * frases reconocidas y corta tras ~3.5s de silencio prolongado. */
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
      let last = performance.now(); // último momento con actividad de voz
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
        if (cancelMsg) return errorAssessment(cancelMsg);
        if (words.length === 0) {
          return errorAssessment("No te escuché. Probá de nuevo.");
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
        try {
          const json = e.result.properties.getProperty(
            sdk.PropertyId.SpeechServiceResponse_JsonResult,
          );
          const nbest = JSON.parse(json)?.NBest?.[0];
          if (!nbest) return;
          const fluency = nbest.PronunciationAssessment?.FluencyScore;
          if (fluency) fluencies.push(fluency);
          words.push(...parseWords(nbest.Words));
        } catch {
          // frase sin desglose: se ignora, igual que en el escritorio
        }
      };
      recognizer.speechStartDetected = () => {
        spoke = true;
        last = performance.now();
      };
      recognizer.canceled = (_s, e) => {
        cancelMsg = `Cancelado: ${sdk.CancellationReason[e.reason]}.`;
        if (e.errorDetails) cancelMsg += ` ${e.errorDetails}`;
        finish();
      };

      const watchdog = setInterval(() => {
        const now = performance.now();
        if (spoke && now - last > 3500) finish(); // terminaste de leer
        else if (!spoke && now - start > 15000) finish(); // no empezaste a hablar
        else if (now - start > 180000) finish(); // tope de seguridad
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

  /** SSML con la voz, el TONO (pitch) y la VELOCIDAD (rate) configurados. */
  private buildSsml(text: string): string {
    const safe = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return (
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ' +
      `xml:lang="${this.settings.targetLanguage}">` +
      `<voice name="${this.settings.ttsVoice}">` +
      `<prosody rate="${this.settings.ttsRate}" pitch="${this.settings.ttsPitch}">` +
      `${safe}</prosody></voice></speak>`
    );
  }

  /** Reproduce 'text' con voz neural ("escuchá cómo se dice").
   * Devuelve un mensaje de error, o null si salió bien. La promesa se resuelve
   * cuando TERMINA de sonar (SpeakerAudioDestination.onAudioEnd), para que la
   * UI mantenga el 'busy' mientras suena, como en el escritorio. */
  speak(text: string): Promise<string | null> {
    return new Promise((resolve) => {
      let synthesizer: sdk.SpeechSynthesizer | null = null;
      const done = (err: string | null) => {
        synthesizer?.close();
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
            }
            // si salió bien, esperamos onAudioEnd para soltar el busy
          },
          (err) => done(`No pude reproducir el audio: ${err}`),
        );
      } catch (exc) {
        done(`No pude reproducir el audio: ${String(exc)}`);
      }
    });
  }

  /** Traducción del resultado crudo de Azure a nuestro Assessment. */
  private toAssessment(result: sdk.SpeechRecognitionResult): Assessment {
    if (result.reason === sdk.ResultReason.NoMatch) {
      return errorAssessment("No te escuché. Probá de nuevo.");
    }
    if (result.reason === sdk.ResultReason.Canceled) {
      const details = sdk.CancellationDetails.fromResult(result);
      let msg = `Cancelado: ${sdk.CancellationReason[details.reason]}.`;
      if (details.errorDetails) msg += ` ${details.errorDetails}`;
      return errorAssessment(msg);
    }

    let nbest: any = null;
    try {
      const json = result.properties.getProperty(
        sdk.PropertyId.SpeechServiceResponse_JsonResult,
      );
      nbest = JSON.parse(json)?.NBest?.[0] ?? null;
    } catch {
      nbest = null;
    }
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

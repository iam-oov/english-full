"""Adapter de Azure Speech: pronunciation assessment + texto a voz (TTS).

Esta es la unica parte que habla con Azure. El resto del juego no sabe que por
debajo hay un servicio en la nube: le pedimos "evaluá esta palabra" y nos
devuelve un Assessment limpio. Esa es la frontera (hexagonal, si querés ponerle
nombre): si manana cambiamos a un motor offline, solo tocamos este archivo.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
import wave
from dataclasses import dataclass, field

import azure.cognitiveservices.speech as speechsdk

from config import Config

# Formato de audio para la captura: 16 kHz, 16-bit, mono PCM (lo que espera
# Azure y lo que graba sounddevice como int16).
_SAMPLE_RATE = 16000
_SAMPLE_WIDTH = 2  # bytes (16-bit)


@dataclass
class PhonemeScore:
    phoneme: str
    accuracy: float


@dataclass
class WordScore:
    word: str
    accuracy: float
    error_type: str  # "None", "Omission", "Insertion", "Mispronunciation"
    phonemes: list[PhonemeScore] = field(default_factory=list)


@dataclass
class Assessment:
    """Resultado limpio de evaluar una pronunciacion."""

    recognized_text: str
    accuracy: float        # que tan bien pronunciados los sonidos (0-100)
    pronunciation: float   # score global combinado (0-100)
    completeness: float    # cuanto del texto objetivo dijiste (0-100)
    fluency: float         # fluidez/ritmo (0-100)
    words: list[WordScore] = field(default_factory=list)
    error: str | None = None  # mensaje si algo salio mal (no hubo voz, etc.)
    audio_path: str | None = None  # .wav con lo que dijiste (para reproducir)

    @property
    def ok(self) -> bool:
        return self.error is None

    def weak_phonemes(self, limit: int = 5, below: float = 80.0) -> list[PhonemeScore]:
        """Fonemas peor pronunciados (para la palabra unica)."""
        all_ph = [p for w in self.words for p in w.phonemes]
        weak = sorted((p for p in all_ph if p.accuracy < below), key=lambda p: p.accuracy)
        return weak[:limit]

    def weak_words(self, limit: int = 5, below: float = 80.0) -> list[WordScore]:
        """Palabras peor pronunciadas (para el jefe final / oracion)."""
        weak = sorted((w for w in self.words if w.accuracy < below), key=lambda w: w.accuracy)
        return weak[:limit]


class Scorer:
    def __init__(self, config: Config) -> None:
        self._config = config
        self._capture_error: str | None = None  # ultimo error de captura del mic

    # --- helpers de construccion (uno nuevo por llamada => thread-safe) ---

    def _pick_samplerate(self, device) -> int:
        """Elige una frecuencia que el mic soporte: 16k si puede (lo ideal para
        Azure), si no la nativa del aparato. Los 'hw:' crudos de ALSA NO hacen
        16k, por eso no se puede forzar."""
        import sounddevice as sd

        try:
            sd.check_input_settings(
                device=device, samplerate=_SAMPLE_RATE, channels=1, dtype="int16"
            )
            return _SAMPLE_RATE
        except Exception:
            info = sd.query_devices(device, "input")
            return int(info["default_samplerate"])

    def _speech_config(self) -> speechsdk.SpeechConfig:
        return speechsdk.SpeechConfig(
            subscription=self._config.speech_key,
            region=self._config.speech_region,
        )

    # --- API publica -----------------------------------------------------

    def assess(
        self,
        reference_text: str,
        on_status=None,
        device=None,
        long_form: bool = False,
        continuous: bool = False,
    ) -> Assessment:
        """Graba del microfono y evalua la pronunciacion contra reference_text.

        Bloquea hasta que detecta que terminaste de hablar (silencio). Por eso
        SIEMPRE se llama desde un hilo aparte, nunca desde el de la UI.

        long_form=True (oraciones/parrafo) tolera pausas mas largas entre
        palabras antes de cortar (asi leer el parrafo con pausas no lo corta).

        continuous=True (jefe final = parrafo entero): usa reconocimiento CONTINUO
        en vez de recognize_once, que tiene un tope de ~15s por enunciado. El
        continuo acumula todas las frases hasta que detectamos silencio prolongado.

        on_status(code) -opcional- se llama en momentos clave para que la UI
        muestre un "semaforo": "listening" (ya escucha, hablá), "speech" (te
        escucho), "processing" (terminaste, analizando). OJO: se dispara en
        hilos internos del SDK, asi que el callback debe ser thread-safe
        (en la practica: solo encolar mensajes, nunca tocar tkinter directo).
        """
        try:
            speech_config = self._speech_config()
            # Mas paciencia para EMPEZAR a hablar (default ~5s): evita el
            # "no te escuché" cuando el mic todavia se estaba conectando.
            speech_config.set_property(
                speechsdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
                "15000",
            )
            # Silencio que marca el FIN del habla. Para una palabra alcanza poco;
            # para oraciones/parrafo damos mas margen para pausar entre palabras.
            speech_config.set_property(
                speechsdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
                "3000" if long_form else "1200",
            )
            # Intentamos capturar el audio nosotros (con sounddevice) para poder
            # REPRODUCIR despues lo que dijiste, y se lo damos a Azure por un push
            # stream. Si algo falla (sin sounddevice/portaudio, mic raro), caemos
            # al micrófono directo: el scoring sigue, solo no hay reproduccion.
            frames = bytearray()
            stream, push, capture_rate = self._open_capture(frames, device)
            if push is not None:
                audio_config = speechsdk.audio.AudioConfig(stream=push)
            else:
                audio_config = speechsdk.audio.AudioConfig(use_default_microphone=True)

            pron_config = speechsdk.PronunciationAssessmentConfig(
                reference_text=reference_text,
                grading_system=speechsdk.PronunciationAssessmentGradingSystem.HundredMark,
                granularity=speechsdk.PronunciationAssessmentGranularity.Phoneme,
                enable_miscue=True,
            )
            # IPA = la notacion de los diccionarios (ð, ɪ, w...), mas util para
            # aprender que el set SAPI por defecto (dh, ih, w...).
            pron_config.phoneme_alphabet = "IPA"

            recognizer = speechsdk.SpeechRecognizer(
                speech_config=speech_config,
                language=self._config.target_language,
                audio_config=audio_config,
            )
            pron_config.apply_to(recognizer)

            if on_status is not None:
                # El SDK pasa un evento al callback; lo ignoramos.
                recognizer.session_started.connect(lambda _e: on_status("listening"))
                recognizer.speech_start_detected.connect(lambda _e: on_status("speech"))
                if not continuous:
                    # En continuo el "processing" lo emitimos al cortar nosotros.
                    recognizer.speech_end_detected.connect(
                        lambda _e: on_status("processing")
                    )

            if continuous:
                assessment = self._recognize_continuous(
                    recognizer, reference_text, on_status
                )
            else:
                assessment = self._to_assessment(recognizer.recognize_once())

            # Cerramos la captura (primero el stream, asi el callback deja de
            # escribir, luego el push) y guardamos el .wav.
            wav_path = None
            if stream is not None:
                try:
                    stream.stop()
                    stream.close()
                    if push is not None:
                        push.close()
                    wav_path = self._save_wav(frames, capture_rate)
                except Exception:
                    wav_path = None

            assessment.audio_path = wav_path
            return assessment
        except Exception as exc:  # mic ausente, red caida, etc.
            return Assessment("", 0, 0, 0, 0, error=f"Error al evaluar: {exc}")

    def _recognize_continuous(
        self, recognizer, reference_text: str, on_status=None
    ) -> Assessment:
        """Reconocimiento CONTINUO (para el jefe = parrafo entero). Acumula las
        frases reconocidas y corta tras ~3.5s de silencio prolongado. Asi se
        evita el tope de ~15s de recognize_once."""
        import threading

        done = threading.Event()
        words: list[WordScore] = []
        texts: list[str] = []
        fluencies: list[float] = []
        err: dict[str, str] = {}
        last = [time.monotonic()]  # ultimo momento con actividad de voz
        spoke = [False]

        def on_recognizing(_evt):
            last[0] = time.monotonic()

        def on_recognized(evt):
            last[0] = time.monotonic()
            r = evt.result
            if r.reason != speechsdk.ResultReason.RecognizedSpeech:
                return
            if r.text:
                texts.append(r.text)
            try:
                pron = speechsdk.PronunciationAssessmentResult(r)
                if pron.fluency_score:
                    fluencies.append(pron.fluency_score)
                for w in pron.words or []:
                    phs = [
                        PhonemeScore(p.phoneme, p.accuracy_score)
                        for p in (w.phonemes or [])
                    ]
                    words.append(
                        WordScore(w.word, w.accuracy_score, str(w.error_type), phs)
                    )
            except Exception:
                pass

        def on_speech_start(_evt):
            spoke[0] = True
            last[0] = time.monotonic()

        def on_canceled(evt):
            details = getattr(evt, "cancellation_details", None)
            msg = "Cancelado."
            if details is not None:
                msg = f"Cancelado: {details.reason}."
                if details.error_details:
                    msg += f" {details.error_details}"
            err["msg"] = msg
            done.set()

        recognizer.recognizing.connect(on_recognizing)
        recognizer.recognized.connect(on_recognized)
        recognizer.speech_start_detected.connect(on_speech_start)
        recognizer.canceled.connect(on_canceled)
        recognizer.session_stopped.connect(lambda _e: done.set())

        recognizer.start_continuous_recognition()
        start = time.monotonic()
        while not done.is_set():
            time.sleep(0.15)
            now = time.monotonic()
            if spoke[0] and (now - last[0]) > 3.5:
                break  # terminaste de leer (silencio prolongado)
            if not spoke[0] and (now - start) > 15:
                break  # no empezaste a hablar
            if (now - start) > 180:
                break  # tope de seguridad
        if on_status is not None:
            on_status("processing")
        try:
            recognizer.stop_continuous_recognition()
        except Exception:
            pass

        if err.get("msg"):
            return Assessment("", 0, 0, 0, 0, error=err["msg"])
        if not words:
            return Assessment("", 0, 0, 0, 0, error="No te escuché. Probá de nuevo.")
        accuracy = sum(w.accuracy for w in words) / len(words)
        fluency = sum(fluencies) / len(fluencies) if fluencies else 0.0
        said = len([w for w in words if "Omission" not in w.error_type])
        ref_count = max(1, len(reference_text.split()))
        completeness = min(100.0, 100.0 * said / ref_count)
        return Assessment(
            recognized_text=" ".join(texts),
            accuracy=accuracy,
            pronunciation=accuracy,
            completeness=completeness,
            fluency=fluency,
            words=words,
        )

    def _open_capture(self, frames: bytearray, device=None):
        """Abre la captura del mic con sounddevice y la arranca.

        'device' es el indice (o nombre) del microfono elegido; None = el
        predeterminado del sistema. Devuelve (stream, push_stream, samplerate) si
        pudo, o (None, None, None) si no (sin sounddevice/portaudio, mic raro).
        El callback escribe cada bloque TANTO al push de Azure como al buffer
        'frames' (para el .wav). Usa la frecuencia que el mic soporte (no fuerza
        16k: los 'hw:' de ALSA no lo soportan).
        """
        self._capture_error = None
        try:
            import sounddevice as sd

            samplerate = self._pick_samplerate(device)
            push = speechsdk.audio.PushAudioInputStream(
                stream_format=speechsdk.audio.AudioStreamFormat(
                    samples_per_second=samplerate, bits_per_sample=16, channels=1
                )
            )

            def _callback(indata, _frame_count, _time_info, _status):
                data = bytes(indata)
                push.write(data)
                frames.extend(data)

            stream = sd.RawInputStream(
                samplerate=samplerate,
                channels=1,
                dtype="int16",
                device=device,
                callback=_callback,
            )
            stream.start()
            return stream, push, samplerate
        except Exception as exc:
            self._capture_error = str(exc)
            return None, None, None

    def _save_wav(
        self, frames: bytearray, samplerate: int = _SAMPLE_RATE,
        name: str = "pron_tetris_last.wav",
    ) -> str | None:
        """Vuelca el PCM capturado a un .wav temporal (se sobreescribe cada vez)."""
        if not frames:
            return None
        path = os.path.join(tempfile.gettempdir(), name)
        with wave.open(path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(_SAMPLE_WIDTH)
            wf.setframerate(samplerate)
            wf.writeframes(bytes(frames))
        return path

    def record_test(self, device=None, seconds: float = 3.0):
        """Graba 'seconds' del mic elegido para PROBARLO. Devuelve (wav_path, error).

        Independiente de Azure: solo graba y luego la UI lo reproduce. Bloquea
        (el sleep): llamar desde un hilo aparte.
        """
        try:
            import sounddevice as sd

            samplerate = self._pick_samplerate(device)
            frames = bytearray()

            def _callback(indata, _fc, _ti, _st):
                frames.extend(bytes(indata))

            stream = sd.RawInputStream(
                samplerate=samplerate, channels=1, dtype="int16",
                device=device, callback=_callback,
            )
            stream.start()
            time.sleep(seconds)
            stream.stop()
            stream.close()
            path = self._save_wav(frames, samplerate, name="pron_tetris_mictest.wav")
            if not path:
                return None, "No se capturó audio. ¿El micrófono está mudo o sin permiso?"
            return path, None
        except Exception as exc:
            return None, f"No pude grabar la prueba: {exc}"

    def play_recording(self, path: str) -> str | None:
        """Reproduce el .wav de lo que dijiste. Devuelve error o None. Bloquea."""
        if not path or not os.path.exists(path):
            return "Todavía no hay grabación para reproducir."
        players = (
            ("aplay", ["-q"]),
            ("paplay", []),
            ("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet"]),
        )
        for player, args in players:
            if shutil.which(player):
                try:
                    subprocess.run(
                        [player, *args, path],
                        check=True,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    return None
                except Exception as exc:
                    return f"No pude reproducir tu grabación: {exc}"
        return "No encontré reproductor de audio (instalá alsa-utils o pulseaudio-utils)."

    def _build_ssml(self, text: str) -> str:
        """SSML con la voz, el TONO (pitch) y la VELOCIDAD (rate) configurados.

        Azure soporta cambiar tono/velocidad via <prosody> (no hace falta Google):
        TTS_PITCH/TTS_RATE en .env aceptan '+10%', '-15%', '0%', 'slow', etc.
        """
        safe = (
            text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        )
        return (
            '<speak version="1.0" '
            'xmlns="http://www.w3.org/2001/10/synthesis" '
            f'xml:lang="{self._config.target_language}">'
            f'<voice name="{self._config.tts_voice}">'
            f'<prosody rate="{self._config.tts_rate}" '
            f'pitch="{self._config.tts_pitch}">{safe}</prosody>'
            "</voice></speak>"
        )

    def speak(self, text: str) -> str | None:
        """Reproduce 'text' con voz neural por el parlante (el 'escuchá como se dice').

        Devuelve un mensaje de error, o None si salio bien. Bloquea: llamar
        desde un hilo aparte. Ojo: la SALIDA usa AudioOutputConfig
        (use_default_speaker), NO AudioConfig (esa es para la ENTRADA / mic).
        """
        try:
            speech_config = self._speech_config()
            audio_config = speechsdk.audio.AudioOutputConfig(use_default_speaker=True)
            synthesizer = speechsdk.SpeechSynthesizer(
                speech_config=speech_config, audio_config=audio_config
            )
            # SSML para poder controlar voz + tono + velocidad.
            result = synthesizer.speak_ssml_async(self._build_ssml(text)).get()
            if result.reason == speechsdk.ResultReason.Canceled:
                details = result.cancellation_details
                msg = f"TTS cancelado: {details.reason}."
                if details.error_details:
                    msg += f" {details.error_details}"
                return msg
            return None
        except Exception as exc:
            return f"No pude reproducir el audio: {exc}"

    # --- traduccion del resultado crudo de Azure a nuestro Assessment ----

    def _to_assessment(self, result: "speechsdk.SpeechRecognitionResult") -> Assessment:
        if result.reason == speechsdk.ResultReason.NoMatch:
            return Assessment("", 0, 0, 0, 0, error="No te escuché. Probá de nuevo.")

        if result.reason == speechsdk.ResultReason.Canceled:
            details = result.cancellation_details
            msg = f"Cancelado: {details.reason}."
            if details.error_details:
                msg += f" {details.error_details}"
            return Assessment("", 0, 0, 0, 0, error=msg)

        pron = speechsdk.PronunciationAssessmentResult(result)

        words: list[WordScore] = []
        for w in pron.words or []:
            phonemes = [
                PhonemeScore(phoneme=p.phoneme, accuracy=p.accuracy_score)
                for p in (w.phonemes or [])
            ]
            words.append(
                WordScore(
                    word=w.word,
                    accuracy=w.accuracy_score,
                    error_type=str(w.error_type),
                    phonemes=phonemes,
                )
            )

        return Assessment(
            recognized_text=result.text,
            accuracy=pron.accuracy_score,
            pronunciation=pron.pronunciation_score,
            completeness=pron.completeness_score,
            fluency=pron.fluency_score,
            words=words,
        )

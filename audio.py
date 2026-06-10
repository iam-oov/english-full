"""Audio local del juego: elegir frecuencia del mic, guardar WAV, grabar una
prueba de microfono y reproducir un WAV. NADA de esto toca Azure: es captura y
reproduccion local (sounddevice + reproductores del sistema: aplay/paplay/ffplay).

Vive separado de scorer.py (el adapter de Azure) a proposito: grabar una prueba
de mic y reproducir un .wav no son responsabilidad del scoring en la nube (ISP).
Los helpers `pick_samplerate`/`save_wav` los comparte scorer.py para la captura
que hace durante `assess` (de ahi que sean funciones de modulo, no metodos).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
import wave

# Formato de audio para la captura: 16 kHz, 16-bit, mono PCM (lo que espera
# Azure y lo que graba sounddevice como int16).
SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2  # bytes (16-bit)


def pick_samplerate(device) -> int:
    """Elige una frecuencia que el mic soporte: 16k si puede (lo ideal para
    Azure), si no la nativa del aparato. Los 'hw:' crudos de ALSA NO hacen 16k,
    por eso no se puede forzar."""
    import sounddevice as sd

    try:
        sd.check_input_settings(
            device=device, samplerate=SAMPLE_RATE, channels=1, dtype="int16"
        )
        return SAMPLE_RATE
    except Exception:
        info = sd.query_devices(device, "input")
        return int(info["default_samplerate"])


def save_wav(
    frames: bytearray, samplerate: int = SAMPLE_RATE,
    name: str = "pron_tetris_last.wav",
) -> str | None:
    """Vuelca el PCM capturado a un .wav temporal (se sobreescribe cada vez)."""
    if not frames:
        return None
    path = os.path.join(tempfile.gettempdir(), name)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(samplerate)
        wf.writeframes(bytes(frames))
    return path


class LocalAudio:
    """Grabacion de prueba del mic + reproduccion de WAVs. Sin Azure."""

    def record_test(self, device=None, seconds: float = 3.0):
        """Graba 'seconds' del mic elegido para PROBARLO. Devuelve (wav_path, error).

        Independiente de Azure: solo graba y luego la UI lo reproduce. Bloquea
        (el sleep): llamar desde un hilo aparte.
        """
        try:
            import sounddevice as sd

            samplerate = pick_samplerate(device)
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
            path = save_wav(frames, samplerate, name="pron_tetris_mictest.wav")
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

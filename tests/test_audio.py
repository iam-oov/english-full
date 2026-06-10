"""Tests del audio local (sin Azure): reproduccion de WAV y forma del puerto.

`LocalAudio` (grabar prueba de mic + reproducir WAV) se separo de `Scorer` (el
adapter de Azure): grabar/reproducir local no es responsabilidad del scoring en
la nube (ISP). Ninguno de estos metodos toca Azure.
"""

from __future__ import annotations

from audio import LocalAudio


def test_play_recording_missing_path_returns_error():
    # Sin hardware: un path inexistente devuelve un mensaje, nunca lanza.
    err = LocalAudio().play_recording("/no/such/file.wav")
    assert isinstance(err, str) and err


def test_play_recording_empty_path_returns_error():
    err = LocalAudio().play_recording("")
    assert isinstance(err, str) and err


def test_local_audio_exposes_audio_io_methods():
    audio = LocalAudio()
    assert callable(audio.record_test)
    assert callable(audio.play_recording)

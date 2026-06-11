"""App testeada CON DOBLES, sin Azure ni DeepSeek — el pago del DIP.

Antes de inyectar los puertos, esto era imposible: App instanciaba Scorer/Coach
concretos y la cadena de imports exigia el SDK de Azure. Ahora le pasamos dobles
de test y verificamos que la regla de aprobado mueve el estado del juego como
corresponde, sin tocar la nube.
"""

from __future__ import annotations

import tkinter as tk

import pytest

from app import App
from assessment import Assessment, WordScore
from config import Config
from progress import InMemoryProgressStore


def _config(**over) -> Config:
    base = dict(
        speech_key="test-key",
        speech_region="eastus",
        target_language="en-US",
        tts_voice="en-US-AndrewNeural",
        tts_pitch="0%",
        tts_rate="0%",
        pass_threshold=94.0,
        near_miss_margin=5.0,
        cefr_level="B2",
        deepseek_key="",
        deepseek_model="deepseek-chat",
        deepseek_base_url="https://api.deepseek.com",
    )
    base.update(over)
    return Config(**base)


class FakeScorer:
    """Doble del puerto PronunciationScorer (sin Azure)."""

    def assess(self, reference_text, on_status=None, device=None,
               long_form=False, continuous=False):
        raise AssertionError("assess() no deberia llamarse en este test")

    def speak(self, text):
        return None


class FakeCoach:
    """Doble del puerto PronunciationCoach (sin DeepSeek)."""

    @property
    def available(self) -> bool:
        return False

    def tip(self, *args, **kwargs):
        return None


class FakeAudio:
    """Doble del puerto AudioIO (sin sonido real)."""

    def record_test(self, device=None, seconds=3.0):
        return (None, None)

    def play_recording(self, path):
        return None


@pytest.fixture
def app():
    root = tk.Tk()
    instance = App(
        root, _config(), FakeScorer(), FakeCoach(), FakeAudio(),
        store=InMemoryProgressStore(),
    )
    instance._begin_game(["hello world"])
    yield instance
    root.destroy()


def test_all_words_above_threshold_marks_pass(app):
    a = Assessment(
        recognized_text="hello world",
        accuracy=98.0,
        pronunciation=98.0,
        completeness=100.0,
        fluency=95.0,
        words=[
            WordScore("hello", 97.0, "None", []),
            WordScore("world", 99.0, "None", []),
        ],
    )
    app._on_assessment(a)
    assert app.state == "pass"


def test_one_word_below_threshold_marks_fail(app):
    a = Assessment(
        recognized_text="hello world",
        accuracy=80.0,
        pronunciation=80.0,
        completeness=100.0,
        fluency=80.0,
        words=[
            WordScore("hello", 60.0, "None", []),
            WordScore("world", 99.0, "None", []),
        ],
    )
    app._on_assessment(a)
    assert app.state == "fail"


def test_near_miss_pass_path_does_not_raise(app):
    # Todas las palabras por debajo del umbral, pero el promedio cae en la ventana
    # near-miss (89 <= 91 < 94) y el reconocedor escucho el texto correcto:
    # pasa por la 2da via (by_recognition). Este es el branch de display que el
    # refactor del paso #2 dejo con un `margin` huerfano (NameError).
    a = Assessment(
        recognized_text="hello world",
        accuracy=91.0,
        pronunciation=91.0,
        completeness=100.0,
        fluency=90.0,
        words=[
            WordScore("hello", 90.0, "None", []),
            WordScore("world", 92.0, "None", []),
        ],
    )
    app._on_assessment(a)  # no debe lanzar
    assert app.state == "pass"

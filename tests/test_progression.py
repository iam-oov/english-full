"""Tests de la capa RPG (XP, racha, combo, persistencia) con dobles.

Construyen un App real (como test_app_integration) pero con un ProgressStore EN
MEMORIA, y verifican que las mecanicas se muevan en _on_assessment sin cambiar las
transiciones de estado ni tocar disco. La unica escritura ocurre en _win.
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
        speech_key="test-key", speech_region="eastus", target_language="en-US",
        tts_voice="en-US-AndrewNeural", tts_pitch="0%", tts_rate="0%",
        pass_threshold=94.0, near_miss_margin=5.0, cefr_level="B2",
        deepseek_key="", deepseek_model="deepseek-chat",
        deepseek_base_url="https://api.deepseek.com",
    )
    base.update(over)
    return Config(**base)


class _FakeScorer:
    def assess(self, *a, **k):
        raise AssertionError("assess no se llama en estos tests")

    def speak(self, text):
        return None


class _FakeCoach:
    @property
    def available(self) -> bool:
        return False

    def tip(self, *a, **k):
        return None


class _FakeAudio:
    def record_test(self, device=None, seconds=3.0):
        return (None, None)

    def play_recording(self, path):
        return None


def _assessment(words, accuracy=None, recognized="hello world") -> Assessment:
    """Assessment de prueba. `words` = lista de (texto, accuracy)."""
    ws = [WordScore(w, sc, "None", []) for w, sc in words]
    acc = accuracy if accuracy is not None else sum(s for _, s in words) / len(words)
    return Assessment(
        recognized_text=recognized, accuracy=acc, pronunciation=acc,
        completeness=100.0, fluency=acc, words=ws,
    )


@pytest.fixture
def make_app():
    roots: list[tk.Tk] = []

    def _make(store=None):
        root = tk.Tk()
        roots.append(root)
        app = App(
            root, _config(), _FakeScorer(), _FakeCoach(), _FakeAudio(),
            store=store or InMemoryProgressStore(),
        )
        app._begin_game(["hello world"])
        return app

    yield _make
    for r in roots:
        r.destroy()


def test_xp_awarded_on_first_defeat_only(make_app):
    store = InMemoryProgressStore()
    app = make_app(store)
    app._on_assessment(_assessment([("hello", 97.0), ("world", 99.0)]))
    assert app.state == "pass"
    assert app._run_xp == 40
    assert store.load().total_xp == 40
    # Re-pasar el MISMO objetivo no suma XP (prev_status ya es "defeated").
    app._on_assessment(_assessment([("hello", 98.0), ("world", 99.0)]))
    assert app._run_xp == 40
    assert store.load().total_xp == 40


def test_streak_increments_on_pass_and_resets_on_fail(make_app):
    app = make_app()
    app._on_assessment(_assessment([("hello", 97.0), ("world", 99.0)]))
    assert app._streak == 1
    app._on_assessment(_assessment([("hello", 60.0), ("world", 99.0)], accuracy=80.0))
    assert app.state == "fail"
    assert app._streak == 0


def test_combo_counts_perfect_words_then_resets_on_fail(make_app):
    app = make_app()
    app._on_assessment(_assessment([("hello", 98.0), ("world", 99.0)]))
    assert app._combo == 2
    # Un intento que FALLA rompe el combo aunque tenga palabras perfectas.
    app._on_assessment(_assessment([("hello", 60.0), ("world", 99.0)], accuracy=80.0))
    assert app._combo == 0


def test_best_hp_tracks_max_and_never_drops(make_app):
    app = make_app()
    tid = id(app.game.current)
    app._on_assessment(_assessment([("hello", 70.0), ("world", 70.0)], accuracy=70.0))
    assert app._best_hp[tid] == 70.0
    app._on_assessment(_assessment([("hello", 85.0), ("world", 85.0)], accuracy=85.0))
    assert app._best_hp[tid] == 85.0
    # Un intento peor NO baja el HP (la barra solo se llena).
    app._on_assessment(_assessment([("hello", 60.0), ("world", 60.0)], accuracy=60.0))
    assert app._best_hp[tid] == 85.0


def test_no_disk_write_during_assessment(make_app):
    store = InMemoryProgressStore()
    app = make_app(store)
    app._on_assessment(_assessment([("hello", 97.0), ("world", 99.0)]))
    app._on_assessment(_assessment([("hello", 60.0), ("world", 99.0)], accuracy=80.0))
    assert store.save_count == 0  # _on_assessment NUNCA persiste


def test_font_bump_changes_delta_and_size(make_app):
    app = make_app()  # _begin_game -> estado "ready" con la oracion como objetivo
    base = app._target_font_size(app.game.current)
    app._on_font_bigger()
    assert app._font_delta == 2
    assert app._target_font_size(app.game.current) == base + 2
    app._on_font_smaller()
    app._on_font_smaller()
    assert app._font_delta == -2


def test_font_bump_noop_in_input(make_app):
    app = make_app()
    app._show_input()  # vuelve a estado "input": P/L no deben tocar la fuente
    app._on_font_bigger()
    assert app._font_delta == 0


def test_font_bump_clamps(make_app):
    app = make_app()
    for _ in range(20):
        app._on_font_bigger()
    assert app._font_delta == 16  # tope superior
    for _ in range(40):
        app._on_font_smaller()
    assert app._font_delta == -6  # tope inferior


def test_win_persists_stats(make_app):
    store = InMemoryProgressStore()
    app = make_app(store)
    app._on_assessment(_assessment([("hello", 97.0), ("world", 99.0)]))
    assert store.save_count == 0
    app._win()
    assert store.save_count == 1
    saved = store.load()
    assert saved.total_xp == 40
    assert saved.best_streak == 1

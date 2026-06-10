"""Tests de la regla de aprobado del juego (dominio puro, sin Azure ni tkinter).

Esta es la regla que el CLAUDE.md marca como "clave, no es obvia":
  - REGLA 1 (estricta): se derrota un objetivo solo si TODOS los sonidos
    (fonemas de una palabra, o palabras de un jefe) superan el umbral. No el
    promedio.
  - REGLA 2 (near-miss): si el PROMEDIO quedo a <= margin puntos por DEBAJO del
    umbral Y el reconocedor escucho el texto correcto, pasa igual.
"""

from __future__ import annotations

from scoring import Verdict, judge

THRESHOLD = 94.0
MARGIN = 5.0


def _judge(units, accuracy, recognized_ok):
    return judge(
        units,
        accuracy=accuracy,
        recognized_ok=recognized_ok,
        threshold=THRESHOLD,
        near_miss_margin=MARGIN,
    )


def test_all_sounds_above_threshold_passes_strict():
    units = [("h", 96.0), ("ɪ", 95.0), ("z", 99.0)]
    v = _judge(units, accuracy=96.0, recognized_ok=True)
    assert v.passed
    assert not v.by_recognition


def test_high_average_but_one_phoneme_fails_does_not_rescue():
    # El caso del CLAUDE.md: "entered" con promedio alto pero d=73%.
    # La regla 1 gana: un solo sonido por debajo del umbral = NO derrotada.
    units = [("ɛ", 99.0), ("n", 98.0), ("t", 97.0), ("ɚ", 99.0), ("d", 73.0)]
    v = _judge(units, accuracy=96.0, recognized_ok=True)
    assert not v.passed
    assert not v.by_recognition
    assert v.worst_label == "d"
    assert v.worst_score == 73.0


def test_near_miss_with_correct_recognition_passes():
    # Promedio por debajo del umbral pero dentro del margen + reconocido OK.
    units = [("h", 92.0), ("aɪ", 90.0)]
    v = _judge(units, accuracy=91.0, recognized_ok=True)
    assert v.passed
    assert v.by_recognition


def test_near_miss_without_correct_recognition_fails():
    units = [("h", 92.0), ("aɪ", 90.0)]
    v = _judge(units, accuracy=91.0, recognized_ok=False)
    assert not v.passed
    assert not v.by_recognition


def test_below_near_miss_window_fails_even_if_recognized():
    # accuracy por debajo de (threshold - margin): ni el near-miss rescata.
    units = [("h", 70.0)]
    v = _judge(units, accuracy=70.0, recognized_ok=True)
    assert not v.passed


def test_near_miss_lower_boundary_is_inclusive():
    # accuracy == threshold - margin (89) debe entrar a la ventana near-miss.
    units = [("h", 89.0)]
    v = _judge(units, accuracy=THRESHOLD - MARGIN, recognized_ok=True)
    assert v.passed
    assert v.by_recognition


def test_empty_units_falls_back_to_accuracy_pass():
    v = _judge([], accuracy=95.0, recognized_ok=False)
    assert v.passed
    assert not v.by_recognition
    assert v.worst_label is None
    assert v.worst_score == 95.0


def test_empty_units_below_threshold_rescued_by_recognition():
    v = _judge([], accuracy=90.0, recognized_ok=True)
    assert v.passed
    assert v.by_recognition
    assert v.worst_label is None


def test_worst_label_is_the_minimum_score():
    units = [("a", 95.0), ("b", 80.0), ("c", 99.0)]
    v = _judge(units, accuracy=91.0, recognized_ok=False)
    assert v.worst_label == "b"
    assert v.worst_score == 80.0


def test_returns_verdict_type():
    v = _judge([("a", 99.0)], accuracy=99.0, recognized_ok=True)
    assert isinstance(v, Verdict)

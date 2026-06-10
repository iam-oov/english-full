"""Regla de aprobado del juego — dominio puro, sin Azure ni tkinter.

Esta es la regla "clave, no obvia" del juego, extraida de la UI para poder
testearla sin micrófono ni ventana. Dos vias para derrotar un objetivo:

  REGLA 1 (estricta): TODOS los sonidos (los fonemas de una palabra, o las
    palabras de una oracion/jefe) deben superar el umbral. NO el promedio.
    Asi un solo fonema flojo (ej: "entered" 96% pero con d=73%) no pasa.

  REGLA 2 (near-miss): si el PROMEDIO quedo a no mas de `near_miss_margin`
    puntos por DEBAJO del umbral Y el reconocedor escucho el texto correcto,
    pasa igual. Solo rescata cuando el promedio quedo CORTO: si ya esta arriba
    del umbral pero un sonido fallo, gana la regla 1 (no rescata).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Verdict:
    """Resultado de juzgar un intento contra la regla de aprobado."""

    passed: bool
    by_recognition: bool  # gano por la 2da via (near-miss), no por la estricta
    worst_label: str | None  # sonido/palabra peor puntuada (None si no hay desglose)
    worst_score: float


def judge(
    units: list[tuple[str, float]],
    *,
    accuracy: float,
    recognized_ok: bool,
    threshold: float,
    near_miss_margin: float,
) -> Verdict:
    """Decide si un intento derrota el objetivo.

    `units` es el desglose (label, score) por fonema o por palabra. `accuracy`
    es el score global del intento (el promedio que reporta el motor). Si no hay
    desglose, se cae a comparar `accuracy` contra el umbral.
    """
    # REGLA 1 (estricta): cada sonido debe superar el umbral.
    if units:
        passed_strict = all(score >= threshold for _label, score in units)
        worst_label, worst_score = min(units, key=lambda u: u[1])
    else:
        passed_strict = accuracy >= threshold
        worst_label, worst_score = None, accuracy

    # REGLA 2 (near-miss): solo rescata si el promedio quedo CORTO (por debajo del
    # umbral) pero por <= margin, y el reconocedor escucho el texto correcto.
    near = (threshold - near_miss_margin) <= accuracy < threshold
    passed = passed_strict or (near and recognized_ok)
    by_recognition = passed and not passed_strict

    return Verdict(
        passed=passed,
        by_recognition=by_recognition,
        worst_label=worst_label,
        worst_score=worst_score,
    )

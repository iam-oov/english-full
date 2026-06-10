"""Puertos (contratos) del juego — la frontera hexagonal hecha explicita.

`app.py` depende de ESTOS protocolos, no de los adaptadores concretos (Scorer
con Azure, Coach con DeepSeek). Asi se cumple el DIP: la UI no conoce la
infraestructura, solo la forma que necesita. El wiring concreto vive en el
composition root (main() en app.py).

Son typing.Protocol (tipado estructural): Scorer y Coach NO heredan de nada,
solo cumplen la forma. Un doble de test que implemente estos metodos sirve igual.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from assessment import Assessment


class PronunciationScorer(Protocol):
    """Captura del microfono + scoring de pronunciacion + TTS. Habla con Azure."""

    def assess(
        self,
        reference_text: str,
        on_status=None,
        device=None,
        long_form: bool = False,
        continuous: bool = False,
    ) -> "Assessment": ...

    def speak(self, text: str) -> str | None: ...


class AudioIO(Protocol):
    """Audio local (sin Azure): grabar una prueba de mic y reproducir un WAV.

    Separado de PronunciationScorer (ISP): quien solo reproduce un .wav no
    deberia depender de la superficie de Azure.
    """

    def record_test(
        self, device=None, seconds: float = 3.0
    ) -> tuple[str | None, str | None]: ...

    def play_recording(self, path: str) -> str | None: ...


class PronunciationCoach(Protocol):
    """Consejos de pronunciacion con IA (opcional: puede estar deshabilitado)."""

    @property
    def available(self) -> bool: ...

    def tip(
        self,
        word: str,
        phonemes: list[tuple[str, float]],
        recognized: str,
        word_attempts: int = 1,
        total_attempts: int = 1,
        level: str = "B2",
    ) -> str | None: ...

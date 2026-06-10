"""DTOs del resultado de evaluar una pronunciacion — dominio puro, sin Azure.

Viven aca (y NO en scorer.py) a proposito: scorer.py importa el SDK de Azure,
asi que cualquiera que necesitara estos tipos arrastraba el SDK entero. Al
separarlos, `app.py` y los puertos (ports.py) hablan en estos tipos sin tocar
la infraestructura, y App se vuelve testeable con dobles.
"""

from __future__ import annotations

from dataclasses import dataclass, field


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

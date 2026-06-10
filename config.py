"""Configuracion del juego.

Lee las credenciales de Azure y los parametros del juego desde variables de
entorno o desde un archivo .env local (parser minimo, sin dependencias).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv(path: Path) -> None:
    """Carga un .env simple (KEY=VALUE por linea) al entorno.

    No pisa variables que ya existan en el entorno real: lo que exportás en la
    shell siempre gana. Ignora comentarios y lineas vacias.
    """
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


@dataclass(frozen=True)
class Config:
    speech_key: str
    speech_region: str
    target_language: str
    tts_voice: str
    tts_pitch: str  # tono de la voz: '+10%', '-15%', '0%', 'high', 'low'...
    tts_rate: str  # velocidad: '+0%', '-10%', 'slow', 'fast'...
    pass_threshold: float
    # 2da via para derrotar: si el PROMEDIO de la palabra quedo a no mas de
    # 'near_miss_margin' puntos del umbral Y el reconocedor escucho la palabra
    # correcta -> pasa igual.
    near_miss_margin: float
    # Nivel CEFR del alumno (A1..C2): el ranking de dificultad del LLM se calibra
    # a este nivel (que le cuesta a un B2, no en abstracto).
    cefr_level: str
    # DeepSeek (LLM) es OPCIONAL: si no hay key, el juego usa la heuristica de
    # dificultad y las pistas estaticas. Si hay, suma coach con IA.
    deepseek_key: str
    deepseek_model: str
    deepseek_base_url: str

    @property
    def coach_enabled(self) -> bool:
        return bool(self.deepseek_key)

    @classmethod
    def load(cls) -> "Config":
        _load_dotenv(Path(__file__).resolve().parent / ".env")

        key = os.environ.get("AZURE_SPEECH_KEY", "").strip()
        region = os.environ.get("AZURE_SPEECH_REGION", "").strip()
        if not key or key == "pega-tu-key-aca" or not region:
            raise RuntimeError(
                "Faltan credenciales de Azure.\n"
                "Copiá .env.example a .env y completá AZURE_SPEECH_KEY y "
                "AZURE_SPEECH_REGION.\n"
                "Mirá las instrucciones dentro de .env.example."
            )

        return cls(
            speech_key=key,
            speech_region=region,
            target_language=os.environ.get("TARGET_LANGUAGE", "en-US").strip(),
            tts_voice=os.environ.get("TTS_VOICE", "en-US-AndrewNeural").strip(),
            tts_pitch=os.environ.get("TTS_PITCH", "0%").strip() or "0%",
            tts_rate=os.environ.get("TTS_RATE", "0%").strip() or "0%",
            pass_threshold=float(os.environ.get("PASS_THRESHOLD", "94")),
            near_miss_margin=float(os.environ.get("NEAR_MISS_MARGIN", "5")),
            cefr_level=os.environ.get("CEFR_LEVEL", "B2").strip() or "B2",
            deepseek_key=os.environ.get("DEEPSEEK_API_KEY", "").strip(),
            deepseek_model=os.environ.get("DEEPSEEK_MODEL", "deepseek-chat").strip(),
            deepseek_base_url=os.environ.get(
                "DEEPSEEK_BASE_URL", "https://api.deepseek.com"
            ).strip(),
        )

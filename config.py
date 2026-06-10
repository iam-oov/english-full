"""Configuracion del juego.

Lee las credenciales de Azure y los parametros del juego desde variables de
entorno o desde un archivo .env (parser minimo, sin dependencias). El .env se
busca en varios lugares (ver `_env_search_paths`): un override explicito, el
directorio XDG de la app instalada, y por ultimo junto al codigo fuente (dev).
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


def _config_dir() -> Path:
    """Directorio XDG de la app (`~/.config/pronunciation-tetris` por defecto)."""
    xdg = os.environ.get("XDG_CONFIG_HOME", "").strip()
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "pronunciation-tetris"


def _env_search_paths() -> list[Path]:
    """Lugares donde buscar el .env, en orden de prioridad (primero gana por clave).

    1. `$PRONUNCIATION_TETRIS_ENV`: override explicito (si esta seteado).
    2. XDG: `~/.config/pronunciation-tetris/.env` (donde vive el .env instalado).
    3. Junto al codigo fuente: `<dir de config.py>/.env` (flujo de dev, sin cambios).
    """
    paths: list[Path] = []
    override = os.environ.get("PRONUNCIATION_TETRIS_ENV", "").strip()
    if override:
        paths.append(Path(override))
    paths.append(_config_dir() / ".env")
    paths.append(Path(__file__).resolve().parent / ".env")
    return paths


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
        for env_path in _env_search_paths():
            _load_dotenv(env_path)

        key = os.environ.get("AZURE_SPEECH_KEY", "").strip()
        region = os.environ.get("AZURE_SPEECH_REGION", "").strip()
        if not key or key == "pega-tu-key-aca" or not region:
            raise RuntimeError(
                "Faltan credenciales de Azure.\n"
                "Creá ~/.config/pronunciation-tetris/.env (o, en dev, copiá "
                ".env.example a .env junto al código) y completá AZURE_SPEECH_KEY "
                "y AZURE_SPEECH_REGION.\n"
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

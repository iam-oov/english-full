"""Progresion persistida del juego: XP, nivel y accuracy de por vida.

Stdlib-only A PROPOSITO. Este modulo lo importa `app.py`, y el test de arquitectura
(tests/test_architecture.py) exige que importar `app` NO cargue el SDK de Azure.
Por eso aca no hay nada de azure/requests/scorer: solo json + pathlib + el dir XDG
que ya resuelve `config.py`. La progresion es estado de juego LOCAL, no un puerto de
infraestructura -> vive en su propio modulo, conceptualmente cerca de config, no en
ports.py.

Reparto de responsabilidades:
- `LifetimeStats`: lo PERSISTIDO (XP total, accuracy acumulada, mejor racha). Nivel y
  accuracy son DERIVADOS (properties), no se guardan -> no hay que migrarlos nunca.
- `ProgressStore`: el unico que toca disco (un JSON en el dir XDG). Tolera archivo
  faltante/corrupto devolviendo stats frescas; nunca lanza.
- `InMemoryProgressStore`: doble de test, mismo contrato, cero disco.

Los contadores de UNA corrida (streak/combo/XP de la sesion) NO viven aca: son estado
efimero de `app.App`, se resetean al empezar cada parrafo.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, fields
from pathlib import Path

from config import _config_dir

SCHEMA_VERSION = 1

# XP que otorga derrotar un objetivo (oracion o jefe) por PRIMERA vez. Reintentar
# uno ya derrotado no suma (no se farmea). Vive aca para tener un solo lugar de tuning.
XP_PER_DEFEAT = 40


def level_for_xp(xp: int) -> int:
    """Nivel a partir del XP total. Curva entera y suave: cada nivel cuesta mas.

    `isqrt(xp // 100) + 1` => L1: 0-99, L2: 100-399, L3: 400-899, L4: 900-1599...
    A +40 XP por derrota: L2 ~3 derrotas, L4 ~23. Sin floats, sin config.
    """
    return math.isqrt(max(0, xp) // 100) + 1


@dataclass
class LifetimeStats:
    """Stats persistidas entre sesiones. `level`/`accuracy` se DERIVAN (no se guardan)."""

    total_xp: int = 0
    targets_defeated: int = 0
    accuracy_sum: float = 0.0
    accuracy_count: int = 0
    best_streak: int = 0
    schema_version: int = SCHEMA_VERSION

    @property
    def accuracy(self) -> float:
        """Promedio de accuracy de los objetivos DERROTADOS (0 si todavia no hay)."""
        if self.accuracy_count <= 0:
            return 0.0
        return self.accuracy_sum / self.accuracy_count

    @property
    def level(self) -> int:
        return level_for_xp(self.total_xp)

    def record_defeat(self, accuracy: float, xp: int) -> None:
        """Registra un objetivo derrotado: suma XP y alimenta el promedio de accuracy."""
        self.total_xp += xp
        self.targets_defeated += 1
        self.accuracy_sum += accuracy
        self.accuracy_count += 1


def _stats_from_dict(data: dict) -> LifetimeStats:
    """Construye LifetimeStats quedandose SOLO con claves conocidas.

    Descarta derivadas (`level`/`accuracy`) y claves futuras/desconocidas -> el formato
    es forward-compatible: un JSON de una version mas nueva carga sin romper.
    """
    known = {f.name for f in fields(LifetimeStats)}
    return LifetimeStats(**{k: v for k, v in data.items() if k in known})


class ProgressStore:
    """Persiste `LifetimeStats` en un unico JSON dentro del dir XDG de la app."""

    def __init__(self, path: Path | None = None) -> None:
        self._path = path if path is not None else _config_dir() / "stats.json"

    def load(self) -> LifetimeStats:
        """Lee las stats. Archivo faltante o corrupto -> stats frescas, sin lanzar.

        Es un READ puro: NO crea el archivo si no existe (importante para que los tests
        que construyen un App no escriban a disco).
        """
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return LifetimeStats()
        if not isinstance(data, dict):
            return LifetimeStats()
        try:
            return _stats_from_dict(data)
        except (TypeError, ValueError):
            return LifetimeStats()

    def save(self, stats: LifetimeStats) -> None:
        """Escribe las stats (crea el dir si hace falta). Traga OSError: son cosmeticas."""
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(
                json.dumps(asdict(stats), indent=2), encoding="utf-8"
            )
        except OSError:
            pass


class InMemoryProgressStore:
    """Doble de test: mismo contrato que ProgressStore, guarda en RAM, cero disco."""

    def __init__(self, stats: LifetimeStats | None = None) -> None:
        self._stats = stats if stats is not None else LifetimeStats()
        self.save_count = 0

    def load(self) -> LifetimeStats:
        return self._stats

    def save(self, stats: LifetimeStats) -> None:
        self._stats = stats
        self.save_count += 1

"""Tests de arquitectura: vigilan las fronteras (puertos y adaptadores).

El objetivo del DIP en este proyecto es que `app.py` dependa de ABSTRACCIONES
(los puertos en ports.py), no de los adaptadores concretos. La consecuencia
medible —y la razon por la que el juego no tenia tests— es que importar `app`
NO debe cargar el SDK de Azure. Si este test falla, la cadena de imports volvio
a acoplar la UI con la infraestructura.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_app_module_does_not_import_azure_sdk():
    # Subproceso limpio: import aislado, sin contaminacion de otros tests.
    code = (
        "import sys, app\n"
        "azure = sorted(m for m in sys.modules if m.startswith('azure'))\n"
        "sys.exit('Azure cargado al importar app: ' + ', '.join(azure) if azure else 0)"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (result.stdout + result.stderr).strip()


def test_audio_module_does_not_import_azure_sdk():
    # El audio local (grabar/reproducir) no tiene por que arrastrar el SDK de Azure.
    code = (
        "import sys, audio\n"
        "azure = sorted(m for m in sys.modules if m.startswith('azure'))\n"
        "sys.exit('Azure cargado al importar audio: ' + ', '.join(azure) if azure else 0)"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (result.stdout + result.stderr).strip()

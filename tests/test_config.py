"""Tests de la carga de configuracion y la busqueda del archivo .env.

La app instalada (.deb) guarda las credenciales en `~/.config/pronunciation-tetris/.env`
(XDG), no junto al codigo fuente. `Config.load()` busca el .env en varios lugares
en orden de prioridad; como `_load_dotenv` usa `os.environ.setdefault`, el primer
archivo que define una clave gana. Estos tests fijan ese contrato.
"""

from __future__ import annotations

import pytest

import config
from config import Config, _config_dir, _env_search_paths


def test_config_dir_uses_xdg_config_home(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "x"))
    assert _config_dir() == tmp_path / "x" / "pronunciation-tetris"


def test_config_dir_falls_back_to_home_config(tmp_path, monkeypatch):
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    assert _config_dir() == tmp_path / "home" / ".config" / "pronunciation-tetris"


def test_search_paths_without_override_has_xdg_then_source(tmp_path, monkeypatch):
    monkeypatch.delenv("PRONUNCIATION_TETRIS_ENV", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    paths = _env_search_paths()
    assert len(paths) == 2
    assert paths[0] == tmp_path / "xdg" / "pronunciation-tetris" / ".env"
    assert paths[1].name == ".env"  # source-relative, ultimo (dev)


def test_search_paths_override_is_first(tmp_path, monkeypatch):
    monkeypatch.setenv("PRONUNCIATION_TETRIS_ENV", str(tmp_path / "o.env"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    paths = _env_search_paths()
    assert paths[0] == tmp_path / "o.env"
    assert paths[1] == tmp_path / "xdg" / "pronunciation-tetris" / ".env"


def test_override_env_takes_priority_over_xdg(tmp_path, monkeypatch):
    monkeypatch.delenv("AZURE_SPEECH_KEY", raising=False)
    monkeypatch.delenv("AZURE_SPEECH_REGION", raising=False)

    cfg_dir = tmp_path / "xdg" / "pronunciation-tetris"
    cfg_dir.mkdir(parents=True)
    (cfg_dir / ".env").write_text(
        "AZURE_SPEECH_KEY=from-xdg\nAZURE_SPEECH_REGION=eastus\n", encoding="utf-8"
    )
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))

    override = tmp_path / "override.env"
    override.write_text("AZURE_SPEECH_KEY=from-override\n", encoding="utf-8")
    monkeypatch.setenv("PRONUNCIATION_TETRIS_ENV", str(override))

    cfg = Config.load()
    assert cfg.speech_key == "from-override"  # el override gana la clave
    assert cfg.speech_region == "eastus"  # la region la completa el XDG


def test_xdg_env_loaded_when_present(tmp_path, monkeypatch):
    monkeypatch.delenv("AZURE_SPEECH_KEY", raising=False)
    monkeypatch.delenv("AZURE_SPEECH_REGION", raising=False)
    monkeypatch.delenv("PRONUNCIATION_TETRIS_ENV", raising=False)

    cfg_dir = tmp_path / "xdg" / "pronunciation-tetris"
    cfg_dir.mkdir(parents=True)
    (cfg_dir / ".env").write_text(
        "AZURE_SPEECH_KEY=from-xdg\nAZURE_SPEECH_REGION=westus\n", encoding="utf-8"
    )
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))

    cfg = Config.load()
    assert cfg.speech_key == "from-xdg"
    assert cfg.speech_region == "westus"


def test_missing_credentials_raises(tmp_path, monkeypatch):
    monkeypatch.delenv("AZURE_SPEECH_KEY", raising=False)
    monkeypatch.delenv("AZURE_SPEECH_REGION", raising=False)
    # Ningun .env de la cadena existe -> debe explotar con mensaje, no devolver basura.
    monkeypatch.setattr(config, "_env_search_paths", lambda: [tmp_path / "nope.env"])
    with pytest.raises(RuntimeError):
        Config.load()

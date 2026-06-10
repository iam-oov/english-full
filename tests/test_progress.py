"""Tests puros de la progresion (sin tkinter, sin Azure, sin disco real).

`progress.py` es stdlib-only a proposito (lo importa app.py y NO debe arrastrar el
SDK de Azure); aca verificamos la curva de nivel, el promedio de accuracy de por
vida, y que el ProgressStore sobreviva ida y vuelta a JSON sin romperse ante
archivos faltantes, corruptos o con claves desconocidas/derivadas.
"""

from __future__ import annotations

import pytest

from progress import (
    InMemoryProgressStore,
    LifetimeStats,
    ProgressStore,
    level_for_xp,
)


@pytest.mark.parametrize(
    "xp, expected",
    [(0, 1), (99, 1), (100, 2), (399, 2), (400, 3), (899, 3), (900, 4)],
)
def test_level_curve_boundaries(xp, expected):
    assert level_for_xp(xp) == expected


def test_lifetime_accuracy_is_running_average():
    stats = LifetimeStats()
    stats.record_defeat(accuracy=80.0, xp=40)
    stats.record_defeat(accuracy=90.0, xp=40)
    assert stats.accuracy == 85.0
    assert stats.total_xp == 80
    assert stats.targets_defeated == 2


def test_accuracy_is_zero_when_no_samples():
    assert LifetimeStats().accuracy == 0.0


def test_store_round_trip(tmp_path):
    path = tmp_path / "stats.json"
    stats = LifetimeStats(
        total_xp=920, targets_defeated=23,
        accuracy_sum=1981.0, accuracy_count=23, best_streak=7,
    )
    ProgressStore(path=path).save(stats)
    assert ProgressStore(path=path).load() == stats


def test_store_load_missing_returns_fresh(tmp_path):
    path = tmp_path / "nope.json"
    assert ProgressStore(path=path).load() == LifetimeStats()
    assert not path.exists()  # load NO debe crear el archivo


def test_store_load_corrupt_returns_fresh(tmp_path):
    path = tmp_path / "corrupt.json"
    path.write_text("{ not json", encoding="utf-8")
    assert ProgressStore(path=path).load() == LifetimeStats()


def test_store_ignores_unknown_and_derived_keys(tmp_path):
    path = tmp_path / "future.json"
    path.write_text(
        '{"total_xp": 100, "level": 99, "accuracy": 50.0, "foo": "bar"}',
        encoding="utf-8",
    )
    loaded = ProgressStore(path=path).load()
    assert loaded.total_xp == 100
    assert loaded.level == 2       # derivado del xp, NO del JSON
    assert loaded.accuracy == 0.0  # sin samples reales (accuracy_count = 0)


def test_inmemory_store_counts_saves_and_never_touches_disk():
    store = InMemoryProgressStore()
    assert store.load() == LifetimeStats()
    store.save(LifetimeStats(total_xp=40))
    assert store.save_count == 1
    assert store.load().total_xp == 40

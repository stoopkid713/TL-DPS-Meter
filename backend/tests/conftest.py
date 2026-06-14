"""Shared pytest fixtures for the backend suite.

ADR-009 — tests must be host-independent (never hit the network). The G4 boss tests
exercise ``refresh_game_data.derive_known_bosses_map``, which pulls LIVE from questlog.gg
(``derive_known_bosses_map`` -> ``pull_npcs`` -> ``_paginate`` -> ``_trpc`` -> ``urlopen``).
That made CI flaky: an SSL read timeout on questlog.gg failed run 27502451597 on
2026-06-14 (``TimeoutError: The read operation timed out``), even though later runs passed.

This autouse fixture stubs ``pull_npcs`` with deterministic fixture rows and hard-disables
the raw ``_trpc`` call so no test can silently reach the network. The fixture names are
chosen to satisfy the G4 assertions (archboss vs. generic/curated labels, and exclusions).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Same import path the tests use (pyproject sets pythonpath=[".","tools"], belt-and-suspenders here).
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import refresh_game_data as rgd  # noqa: E402

# Deterministic stand-ins for the live questlog NPC feeds.
#   boss-world -> labeled "archboss"; boss -> curated fine-grain label or generic "boss".
# Names cover every G4 assertion: Tevent/Ascended Tevent/Calanthia/Giant Cordy (archboss),
# Morokai/Adentus/Nerzatum/Velentra/Grand Aelon (boss). Excluded names (Belkros, Goblin
# Fighter, etc.) are deliberately absent so the exclusion assertions hold.
_FAKE_NPCS = {
    "boss-world": ["Tevent", "Ascended Tevent", "Calanthia", "Giant Cordy"],
    "boss": ["Morokai", "Adentus", "Nerzatum", "Velentra", "Grand Aelon"],
}


def _fake_pull_npcs(main_category):
    return [{"name": n} for n in _FAKE_NPCS.get(main_category, [])]


def _blocked_trpc(*_args, **_kwargs):
    raise RuntimeError("network disabled in tests (ADR-009): _trpc was called")


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """Stub the questlog pull layer so the suite is offline + deterministic (ADR-009)."""
    monkeypatch.setattr(rgd, "pull_npcs", _fake_pull_npcs)
    monkeypatch.setattr(rgd, "_trpc", _blocked_trpc)
    yield

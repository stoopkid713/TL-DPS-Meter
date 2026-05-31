"""Unit tests for the game-data refresh tool (G1+G2+G3: pure functions; no live network).

Covers token normalization, the questlog->meter weapon-slug map, the multi-feed
skill->weapon extractor (recipe doc S7), and the G3 canonical/derive functions.
The tRPC pull layer is intentionally NOT exercised here (it hits questlog live) --
it's verified at the gate with `--counts`.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import refresh_game_data as rgd  # noqa: E402


# --- normalize_token -----------------------------------------------------------------------
def test_normalize_strips_icon_markup():
    assert rgd.normalize_token("^<imgf=foo.png> Sword of Judgment") == "Sword of Judgment"


def test_normalize_collapses_whitespace_and_trims():
    assert rgd.normalize_token("  Phoenix   Barrage  ") == "Phoenix Barrage"


def test_normalize_handles_empty_and_none():
    assert rgd.normalize_token("") == ""
    assert rgd.normalize_token(None) == ""


def test_normalize_strips_multiple_markup_runs():
    assert rgd.normalize_token("^<imgf=a> Milky ^<imgf=b> Way") == "Milky Way"


# --- weapon_slug ---------------------------------------------------------------------------
def test_weapon_slug_known_mappings():
    assert rgd.weapon_slug("sword2h") == "greatsword"
    assert rgd.weapon_slug("sword") == "sns"
    assert rgd.weapon_slug("bow") == "longbow"
    assert rgd.weapon_slug("staff") == "staff"
    assert rgd.weapon_slug("wand") == "wand"
    assert rgd.weapon_slug("orb") == "orb"


def test_weapon_slug_case_insensitive():
    assert rgd.weapon_slug("SWORD2H") == "greatsword"
    assert rgd.weapon_slug(" Bow ") == "longbow"


def test_weapon_slug_unknown_is_other():
    assert rgd.weapon_slug("trumpet") == "other"
    assert rgd.weapon_slug(None) == "other"


def test_every_mapped_slug_is_a_real_meter_slot():
    assert set(rgd.WEAPON_MAP.values()) <= rgd.METER_SLUGS


# --- extract_skill_weapons -----------------------------------------------------------------
def test_extract_base_and_specialization_names():
    sets = [
        {"name": "Brutal Fury", "mainCategory": "spear", "specializations": [
            {"name": "Slaughtering Slash"}, {"name": "Phoenix Barrage"}]},
        {"name": "Copy Satellite", "mainCategory": "orb", "specializations": []},
    ]
    out = rgd.extract_skill_weapons(sets)
    assert out["Brutal Fury"] == "spear"
    assert out["Slaughtering Slash"] == "spear"   # spec inherits parent weapon
    assert out["Phoenix Barrage"] == "spear"
    assert out["Copy Satellite"] == "orb"


def test_extract_normalizes_names_from_feeds():
    sets = [{"name": "^<imgf=x> Gale Rush", "mainCategory": "spear", "specializations": []}]
    out = rgd.extract_skill_weapons(sets)
    assert out["Gale Rush"] == "spear"


def test_extract_masteries_attribute_to_their_weapon():
    """Masteries must map to their mainCategory weapon, not a catch-all 'mastery' bucket."""
    specs = [
        {"name": "Dragon Ascent", "mainCategory": "spear"},
        {"name": "Destruction Spear", "mainCategory": "spear"},
        {"name": "Deadly Viper", "mainCategory": "dagger"},
    ]
    out = rgd.extract_skill_weapons([], weapon_specs=specs)
    assert out["Dragon Ascent"] == "spear"
    assert out["Destruction Spear"] == "spear"
    assert out["Deadly Viper"] == "dagger"
    # 'mastery' should NOT appear as a value for any mastery skill
    assert "mastery" not in out.values()


def test_extract_priority_weapon_beats_other():
    # 'other' offered first (unknown mainCategory), then a real weapon -> weapon must win.
    # Masteries now map to real weapon slugs, so the first concrete weapon slug wins on tie.
    sets = [{"name": "Ambiguous", "mainCategory": "nonsense", "specializations": []}]   # -> other
    specs = [{"name": "Ambiguous", "mainCategory": "spear"}]                            # -> spear (mastery now maps real)
    out = rgd.extract_skill_weapons(sets, weapon_specs=specs)
    assert out["Ambiguous"] == "spear"   # weapon beats other; first concrete weapon wins on tie


def test_extract_priority_two_real_weapons_first_wins():
    # When two feeds both assign a real weapon slug, the first-seen slug wins (feeds run in order).
    sets = [{"name": "Ambiguous", "mainCategory": "spear", "specializations": []}]   # -> spear
    traits = [{"name": "Ambiguous", "mainCategory": "dagger"}]                        # -> dagger (loses; spear already recorded at priority 2)
    out = rgd.extract_skill_weapons(sets, skill_traits=traits)
    assert out["Ambiguous"] == "spear"


def test_extract_lower_priority_does_not_clobber_weapon():
    sets = [{"name": "Shadow Strike", "mainCategory": "dagger", "specializations": []}]
    specs = [{"name": "Shadow Strike", "mainCategory": "dagger"}]  # same weapon -> no conflict
    out = rgd.extract_skill_weapons(sets, weapon_specs=specs)
    assert out["Shadow Strike"] == "dagger"


def test_extract_weapon_passives_feed():
    sets = [{"name": "Corrupting Hit", "mainCategory": "wand", "specializations": []}]
    passives = [{"name": "Enraged Tevent's Hunger", "weapon": "wand"}]
    out = rgd.extract_skill_weapons(sets, weapon_passives=passives)
    assert out["Enraged Tevent's Hunger"] == "wand"   # moves off the 'other' bucket


# --- extract_weapon_passives ---------------------------------------------------------------
def test_extract_weapon_passives_keeps_non_null_only():
    items = [
        {"id": "wand_aa_t2_polymorph_003", "subCategory": "wand"},
        {"id": "plain_sword_001", "subCategory": "sword"},
    ]
    details = {
        "wand_aa_t2_polymorph_003": {"passives": {"name": "Enraged Tevent's Hunger", "text": "..."}},
        "plain_sword_001": {"passives": None},  # common weapon: no passive -> dropped
    }
    out = rgd.extract_weapon_passives(items, details)
    assert out == [{"name": "Enraged Tevent's Hunger", "weapon": "wand"}]


def test_extract_weapon_passives_maps_item_weapon_type():
    items = [{"id": "bow_x", "subCategory": "bow"}]
    details = {"bow_x": {"passives": {"name": "Skywatch Salvo"}}}
    out = rgd.extract_weapon_passives(items, details)
    assert out == [{"name": "Skywatch Salvo", "weapon": "longbow"}]


# --- reconcile_skills (G2) -----------------------------------------------------------------
def test_reconcile_exact_match_counts_and_no_diff():
    d = rgd.reconcile_skills({"Shadow Strike": "dagger"}, {"Shadow Strike": "dagger"})
    assert d["matched"] == 1
    assert d["retagged"] == []
    assert d["orphaned"] == []
    assert d["new"] == []


def test_reconcile_retag_when_feed_disagrees():
    # feed #5 attributes the wand proc that weapon_config currently mis-tags 'other'
    d = rgd.reconcile_skills(
        {"Enraged Tevent's Hunger": "wand"}, {"Enraged Tevent's Hunger": "other"})
    assert d["retagged"] == [{"name": "Enraged Tevent's Hunger", "from": "other", "to": "wand"}]
    assert d["matched"] == 0
    assert d["new"] == []


def test_reconcile_folds_prefix_variants_not_counted_new():
    # combat log emits spec names; meter keys the base "Manaball" -> variants fold in, not new
    extracted = {"Manaball Eruption": "wand", "Manaball Salvo": "wand"}
    d = rgd.reconcile_skills(extracted, {"Manaball": "wand"})
    assert d["matched"] == 1
    assert d["new"] == []
    assert d["retagged"] == []


def test_reconcile_prefix_variant_disagreement_goes_to_review_not_retag():
    # a variant (not exact) match that disagrees is ambiguous -> review, never a confident retag
    d = rgd.reconcile_skills({"Manaball Eruption": "orb"}, {"Manaball": "wand"})
    assert d["retagged"] == []
    assert len(d["review"]) == 1
    r = d["review"][0]
    assert r["name"] == "Manaball" and r["from"] == "wand" and r["feed"] == ["orb"]
    assert r["via"] == "variant" and r["tokens"] == ["Manaball Eruption"]


def test_reconcile_conflicting_variants_go_to_review():
    # Manaball Eruption=staff vs Manaball Salvo=mastery -> conflicting evidence -> review
    d = rgd.reconcile_skills(
        {"Manaball Eruption": "staff", "Manaball Salvo": "mastery"}, {"Manaball": "wand"})
    assert d["retagged"] == []
    assert len(d["review"]) == 1
    assert d["review"][0]["feed"] == ["staff", "mastery"]  # concrete weapon sorts before fallback


def test_reconcile_exact_match_to_only_a_fallback_bucket_is_review():
    # the only feed token of this name is a mastery -> not a confident weapon retag
    d = rgd.reconcile_skills({"Venomous Edge": "mastery"}, {"Venomous Edge": "dagger"})
    assert d["retagged"] == []
    assert len(d["review"]) == 1
    assert d["review"][0]["feed"] == ["mastery"] and d["review"][0]["via"] == "exact"


def test_reconcile_does_not_fold_distinct_same_length_skills():
    # "Brutal Fury" must NOT fold into "Brutal Incision" (equal-length, not a prefix)
    extracted = {"Brutal Incision": "spear"}
    d = rgd.reconcile_skills(extracted, {"Brutal Fury": "spear"})
    assert d["matched"] == 0
    assert d["orphaned"][0]["name"] == "Brutal Fury"
    assert {"name": "Brutal Incision", "weapon": "spear"} in d["new"]


def test_reconcile_orphaned_meter_key_no_feed_match():
    d = rgd.reconcile_skills({"Gale Rush": "spear"}, {"Totally Removed Skill": "mastery"})
    assert len(d["orphaned"]) == 1
    assert d["orphaned"][0]["name"] == "Totally Removed Skill"
    assert d["orphaned"][0]["weapon"] == "mastery"
    assert d["matched"] == 0
    assert {"name": "Gale Rush", "weapon": "spear"} in d["new"]


def test_reconcile_new_tokens_grouped_by_weapon():
    extracted = {"Power Shot": "longbow", "Rain of Arrows": "longbow", "Heavy Cleave": "greatsword"}
    d = rgd.reconcile_skills(extracted, {})
    assert {n["weapon"] for n in d["new"]} == {"longbow", "greatsword"}
    assert len(d["new"]) == 3
    # sorted by (weapon, name)
    assert d["new"][0]["weapon"] == "greatsword"


def test_reconcile_normalizes_icon_markup_in_meter_key():
    d = rgd.reconcile_skills(
        {"Sword of Judgment": "other"}, {"^<imgf=IMG_X> Sword of Judgment": "other"})
    assert d["matched"] == 1
    assert d["new"] == []


# --- reconcile_bosses / flatten_known_targets (G2) -----------------------------------------
def test_flatten_known_targets_ignores_non_list_values():
    data = {"archboss": ["Tevent"], "adds": ["Goblin", "Orc"], "last_updated": "2026-04-09"}
    assert sorted(rgd.flatten_known_targets(data)) == ["Goblin", "Orc", "Tevent"]


def test_reconcile_bosses_flags_new_only():
    pulled = {"boss": [{"name": "New Field Boss"}, {"name": "Morokai"}]}
    out = rgd.reconcile_bosses(pulled, ["Morokai", "Adentus"])
    assert out == {"boss": ["New Field Boss"]}


def test_reconcile_bosses_dedupes_and_normalizes():
    pulled = {"boss-world": [{"name": "Tevent"}, {"name": "tevent"}, {"name": "Ascended Tevent"}]}
    out = rgd.reconcile_bosses(pulled, ["Tevent"])
    assert out == {"boss-world": ["Ascended Tevent"]}  # base + case-dupe filtered; ascended is new


def test_reconcile_bosses_empty_when_all_known():
    assert rgd.reconcile_bosses({"boss": [{"name": "Morokai"}]}, ["Morokai"]) == {}


# --- G3: build_canonical -------------------------------------------------------------------
def test_build_canonical_schema_keys():
    extracted = {"Brutal Fury": "spear", "Guillotine Blade": "greatsword"}
    overlay = {"Legacy Skill": "other"}
    can = rgd.build_canonical(extracted, overlay=overlay, patch="3.18.0")
    assert can["version"] == 1
    assert can["patch"] == "3.18.0"
    assert "last_updated" in can
    assert can["source"] == "https://questlog.gg/throne-and-liberty"
    assert can["entries"] == {"Brutal Fury": "spear", "Guillotine Blade": "greatsword"}
    assert can["overlay"] == {"Legacy Skill": "other"}


def test_build_canonical_entries_sorted():
    extracted = {"Zephyr's Nock": "longbow", "Arrow Vortex": "longbow"}
    can = rgd.build_canonical(extracted, overlay={})
    keys = list(can["entries"].keys())
    assert keys == sorted(keys)


def test_build_canonical_overlay_sorted():
    extracted = {}
    overlay = {"Zorro Slash": "other", "Ancient Strike": "spear"}
    can = rgd.build_canonical(extracted, overlay=overlay)
    keys = list(can["overlay"].keys())
    assert keys == sorted(keys)


def test_build_canonical_uses_default_overlay_when_none():
    can = rgd.build_canonical({}, overlay=None)
    # DEFAULT_OVERLAY is non-empty
    assert len(can["overlay"]) > 0
    assert can["overlay"] == dict(sorted(rgd.DEFAULT_OVERLAY.items()))


def test_build_canonical_passives_reflected_in_generated_from():
    can_with = rgd.build_canonical({}, overlay={}, with_passives=True)
    can_without = rgd.build_canonical({}, overlay={}, with_passives=False)
    assert "weapon passives" in can_with["generated_from"]
    assert "weapon passives" not in can_without["generated_from"]


def test_build_canonical_last_updated_is_utc_iso():
    can = rgd.build_canonical({}, overlay={})
    ts = can["last_updated"]
    # Basic shape: "YYYY-MM-DDTHH:MM:SSZ"
    assert ts.endswith("Z")
    assert "T" in ts
    assert len(ts) >= 20


# --- G3: derive_skill_assignments ----------------------------------------------------------
def test_derive_skill_assignments_merges_entries_and_overlay():
    can = {
        "entries": {"Brutal Fury": "spear", "Power Shot": "longbow"},
        "overlay": {"Basic Shot": "crossbow"},
    }
    merged = rgd.derive_skill_assignments(can)
    assert merged["Brutal Fury"] == "spear"
    assert merged["Power Shot"] == "longbow"
    assert merged["Basic Shot"] == "crossbow"


def test_derive_skill_assignments_overlay_wins_on_conflict():
    # If a skill appears in both entries (feed-derived) and overlay (curated), overlay wins.
    can = {
        "entries": {"Shadow Strike": "dagger"},
        "overlay": {"Shadow Strike": "other"},   # curated override
    }
    merged = rgd.derive_skill_assignments(can)
    assert merged["Shadow Strike"] == "other"


def test_derive_skill_assignments_result_sorted():
    can = {
        "entries": {"Zephyr's Nock": "longbow", "Arrow Vortex": "longbow"},
        "overlay": {"Basic Shot": "crossbow"},
    }
    merged = rgd.derive_skill_assignments(can)
    keys = list(merged.keys())
    assert keys == sorted(keys)


def test_derive_skill_assignments_empty_inputs():
    assert rgd.derive_skill_assignments({"entries": {}, "overlay": {}}) == {}
    assert rgd.derive_skill_assignments({}) == {}


def test_derive_skill_assignments_fills_previously_empty_slugs():
    # Regression: greatsword/longbow/staff must all appear after a real extraction.
    extracted = {
        "Guillotine Blade": "greatsword",
        "Brutal Arrow": "longbow",
        "Chain Lightning": "staff",
        "Shadow Strike": "dagger",
    }
    can = rgd.build_canonical(extracted, overlay={})
    merged = rgd.derive_skill_assignments(can)
    slugs = set(merged.values())
    assert "greatsword" in slugs
    assert "longbow" in slugs
    assert "staff" in slugs


# --- G3: write_skills_canonical / write_weapon_config / derive_weapon_config ---------------
def test_write_and_read_skills_canonical_roundtrip():
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "skills_canonical.json"
        can = rgd.build_canonical({"Brutal Fury": "spear"}, overlay={"X": "other"}, patch="3.18.0")
        rgd.write_skills_canonical(can, path)
        loaded = json.loads(path.read_text(encoding="utf-8"))
    assert loaded["version"] == 1
    assert loaded["patch"] == "3.18.0"
    assert loaded["entries"]["Brutal Fury"] == "spear"
    assert loaded["overlay"]["X"] == "other"


def test_write_weapon_config_preserves_other_keys():
    with tempfile.TemporaryDirectory() as td:
        wc_path = Path(td) / "weapon_config.json"
        # Seed an existing config with an extra key
        wc_path.write_text(json.dumps({
            "skillAssignments": {"Old Skill": "other"},
            "extra_key": "preserved",
            "last_updated": "old",
        }), encoding="utf-8")
        assignments = {"New Skill": "greatsword"}
        cfg = rgd.derive_weapon_config(assignments, wc_path)
        rgd.write_weapon_config(cfg, wc_path)
        loaded = json.loads(wc_path.read_text(encoding="utf-8"))
    assert loaded["skillAssignments"] == {"New Skill": "greatsword"}
    assert loaded["extra_key"] == "preserved"
    assert loaded["last_updated"] != "old"


def test_derive_weapon_config_missing_existing_file():
    with tempfile.TemporaryDirectory() as td:
        missing_path = Path(td) / "nonexistent.json"
        assignments = {"Brutal Fury": "spear"}
        cfg = rgd.derive_weapon_config(assignments, missing_path)
    assert cfg["skillAssignments"] == {"Brutal Fury": "spear"}
    assert "last_updated" in cfg


# --- G3: _load_feeds_from_cache ------------------------------------------------------------
def test_load_feeds_from_cache_raises_on_missing_file():
    import pytest
    with tempfile.TemporaryDirectory() as td:
        with pytest.raises(FileNotFoundError):
            rgd._load_feeds_from_cache(Path(td), with_passives=False)


def test_load_feeds_from_cache_loads_all_required_feeds():
    with tempfile.TemporaryDirectory() as td:
        cache = Path(td)
        (cache / "skill_sets.json").write_text(json.dumps([{"name": "X", "mainCategory": "spear",
                                                            "specializations": []}]), encoding="utf-8")
        (cache / "skill_traits.json").write_text(json.dumps([]), encoding="utf-8")
        (cache / "weapon_specializations.json").write_text(json.dumps([]), encoding="utf-8")
        sets, traits, specs, passives = rgd._load_feeds_from_cache(cache, with_passives=False)
    assert len(sets) == 1
    assert sets[0]["name"] == "X"
    assert traits == []
    assert specs == []
    assert passives is None


def test_load_feeds_from_cache_passives_optional():
    with tempfile.TemporaryDirectory() as td:
        cache = Path(td)
        (cache / "skill_sets.json").write_text("[]", encoding="utf-8")
        (cache / "skill_traits.json").write_text("[]", encoding="utf-8")
        (cache / "weapon_specializations.json").write_text("[]", encoding="utf-8")
        # weapon_passives.json is absent: should not raise, should warn and return None
        sets, traits, specs, passives = rgd._load_feeds_from_cache(cache, with_passives=True)
    assert passives is None  # file absent -> graceful degradation


# --- G3: _skill_counts_by_slug -------------------------------------------------------------
def test_skill_counts_by_slug_basic():
    assignments = {"A": "spear", "B": "spear", "C": "greatsword"}
    counts = rgd._skill_counts_by_slug(assignments)
    assert counts == {"spear": 2, "greatsword": 1}


def test_skill_counts_by_slug_empty():
    assert rgd._skill_counts_by_slug({}) == {}


# --- G4: derive_known_bosses_map -----------------------------------------------------------
def test_derive_known_bosses_includes_boss_categories():
    data = {
        "archboss": ["Tevent", "Ascended Tevent"],
        "field_boss": ["Morokai", "Adentus"],
        "raid_boss": ["Calanthia"],
        "dungeon_boss": ["Belkros"],
    }
    result = rgd.derive_known_bosses_map(data)
    assert result["tevent"] == "archboss"
    assert result["ascended tevent"] == "archboss"
    assert result["morokai"] == "field_boss"
    assert result["calanthia"] == "raid_boss"
    assert result["belkros"] == "dungeon_boss"


def test_derive_known_bosses_excludes_adds_and_other():
    data = {
        "archboss": ["Tevent"],
        "adds": ["Goblin Fighter", "Orc Soldier"],
        "other": ["Practice Dummy"],
    }
    result = rgd.derive_known_bosses_map(data)
    assert "goblin fighter" not in result
    assert "orc soldier" not in result
    assert "practice dummy" not in result
    assert "tevent" in result


def test_derive_known_bosses_normalizes_keys():
    data = {"field_boss": ["Grand Aelon", "  Morokai  "]}
    result = rgd.derive_known_bosses_map(data)
    assert "grand aelon" in result
    assert "morokai" in result


def test_derive_known_bosses_result_sorted():
    data = {
        "archboss": ["Tevent", "Giant Cordy"],
        "field_boss": ["Adentus"],
    }
    result = rgd.derive_known_bosses_map(data)
    keys = list(result.keys())
    assert keys == sorted(keys)


def test_derive_known_bosses_empty_input():
    assert rgd.derive_known_bosses_map({}) == {}
    assert rgd.derive_known_bosses_map(None) == {}


def test_derive_known_bosses_ignores_non_list_values():
    data = {
        "archboss": ["Tevent"],
        "last_updated": "2026-04-09",  # non-list; not a boss category either
    }
    result = rgd.derive_known_bosses_map(data)
    assert result == {"tevent": "archboss"}


# --- G4: build_known_bosses_js_lines -------------------------------------------------------
def test_build_known_bosses_js_lines_basic():
    boss_map = {"morokai": "field_boss", "tevent": "archboss"}
    lines = rgd.build_known_bosses_js_lines(boss_map)
    assert '"morokai": "field_boss",' in lines
    assert '"tevent": "archboss",' in lines


def test_build_known_bosses_js_lines_sorted_input():
    # Given a sorted map (as derive_known_bosses_map always returns), output should be sorted
    boss_map = {"adentus": "field_boss", "tevent": "archboss"}
    lines = rgd.build_known_bosses_js_lines(boss_map)
    idx_adentus = lines.index("adentus")
    idx_tevent = lines.index("tevent")
    assert idx_adentus < idx_tevent


def test_build_known_bosses_js_lines_empty():
    assert rgd.build_known_bosses_js_lines({}) == ""


def test_build_known_bosses_js_lines_each_line_indented():
    boss_map = {"tevent": "archboss"}
    lines = rgd.build_known_bosses_js_lines(boss_map)
    for line in lines.splitlines():
        assert line.startswith("  "), f"Line not indented: {repr(line)}"


# --- G4: rewrite_known_bosses_sentinel -----------------------------------------------------
_FIXTURE_WITH_SENTINELS = """\
const KNOWN_BOSSES = {
  // @gen:known_bosses:start
  "tevent": "archboss",
  // @gen:known_bosses:end
};
"""

_FIXTURE_WITHOUT_SENTINELS = """\
const KNOWN_BOSSES = {
  tevent: "archboss",
  // add more as needed...
};
"""

_FIXTURE_EMPTY_BLOCK = """\
const KNOWN_BOSSES = {
  // @gen:known_bosses:start
  // @gen:known_bosses:end
};
"""


def test_rewrite_sentinel_replaces_content_between_markers():
    new_map = {"morokai": "field_boss", "tevent": "archboss"}
    new_source, changed = rgd.rewrite_known_bosses_sentinel(_FIXTURE_WITH_SENTINELS, new_map)
    assert changed
    assert '"morokai": "field_boss",' in new_source
    assert '"tevent": "archboss",' in new_source
    # Sentinels themselves must still be present
    assert "// @gen:known_bosses:start" in new_source
    assert "// @gen:known_bosses:end" in new_source


def test_rewrite_sentinel_preserves_surrounding_code():
    new_map = {"tevent": "archboss"}
    new_source, _ = rgd.rewrite_known_bosses_sentinel(_FIXTURE_WITH_SENTINELS, new_map)
    assert "const KNOWN_BOSSES = {" in new_source
    assert "};" in new_source


def test_rewrite_sentinel_noop_when_sentinels_absent():
    source_out, changed = rgd.rewrite_known_bosses_sentinel(
        _FIXTURE_WITHOUT_SENTINELS, {"tevent": "archboss"})
    assert not changed
    assert source_out == _FIXTURE_WITHOUT_SENTINELS


def test_rewrite_sentinel_noop_when_content_already_matches():
    # Build source with sentinels whose content already matches what we'd generate
    boss_map = {"tevent": "archboss"}
    js_lines = rgd.build_known_bosses_js_lines(boss_map)
    source = (
        "const KNOWN_BOSSES = {\n"
        "  // @gen:known_bosses:start\n"
        + js_lines + "\n"
        "  // @gen:known_bosses:end\n"
        "};\n"
    )
    _, changed = rgd.rewrite_known_bosses_sentinel(source, boss_map)
    assert not changed


def test_rewrite_sentinel_handles_empty_boss_map():
    new_source, changed = rgd.rewrite_known_bosses_sentinel(_FIXTURE_WITH_SENTINELS, {})
    # Content between sentinels removed; sentinels still present
    assert "// @gen:known_bosses:start" in new_source
    assert "// @gen:known_bosses:end" in new_source


def test_rewrite_sentinel_full_roundtrip_fixture():
    """End-to-end: derive boss map from a minimal target_assignments dict, render, rewrite fixture."""
    data = {
        "archboss": ["Tevent"],
        "field_boss": ["Morokai"],
        "adds": ["Goblin Fighter"],
    }
    boss_map = rgd.derive_known_bosses_map(data)
    new_source, changed = rgd.rewrite_known_bosses_sentinel(_FIXTURE_EMPTY_BLOCK, boss_map)
    assert changed
    assert '"morokai": "field_boss",' in new_source
    assert '"tevent": "archboss",' in new_source
    assert "goblin fighter" not in new_source

"""Game-data refresh — keep skill->weapon / boss->category / weapon-spec current per T&L patch.

Driven off questlog.gg's own tRPC API (no scraping), consolidated to ONE canonical source per
domain, with the meter's derived files (weapon_config.json skillAssignments, the party worker's
KNOWN_BOSSES, dungeons.json) GENERATED so the layers can never drift.

Full design + the reverse-engineered API map: TL-DPS-Meter-oracle/docs/WORKSTREAM-GAME-DATA-REFRESH.md

The full workflow is pull -> extract -> reconcile -> diff -> review-gate -> regenerate -> verify,
built in gated segments. THIS FILE currently implements **G1 + G2 + G3 + G4**:
  * G1: the questlog tRPC pull layer (GET, no auth, raw `input`), the questlog-mainCategory ->
    meter-weapon-slug map (the 11 existing UI cards), combat-log token normalization + the
    multi-feed skill->weapon extractor (recipe doc S7). Masteries (feed #4) map to their
    mainCategory weapon, not a catch-all 'mastery' bucket.
  * G2: fuzzy reconcile of the extracted map vs the meter's skillAssignments + a boss-name diff
    vs default_target_assignments.json, emitted as a human-readable patch diff (`--report`).
  * G3: regenerate skills_canonical.json from feeds + curated overlay, then DERIVE
    weapon_config.json skillAssignments from canonical so the layers can never drift.
  * G4: derive KNOWN_BOSSES JS object from default_target_assignments.json and rewrite the
    sentinel block in workers/party/src/index.js (no-op if sentinels absent); also regenerate
    dungeons.json from the questlog dungeons feed (or leave untouched if offline).

CLI:
  py backend/tools/refresh_game_data.py --counts
      live-probe every feed and print record counts (the cheapest gate check).
  py backend/tools/refresh_game_data.py --dump [DIR] [--passives]
      pull every feed live and write the raw JSON + the extracted skill->weapon map to DIR
      (default backend/tools/_refresh_cache/, gitignored). --passives also pulls each weapon's
      item detail for feed #5 (slow: ~hundreds of getItem calls).
  py backend/tools/refresh_game_data.py --report [--passives]
      pull every feed live, reconcile against canonical (weapon_config.json skillAssignments +
      default_target_assignments.json), and print the human-readable patch diff (read-only).
  py backend/tools/refresh_game_data.py --regenerate [--cache DIR] [--passives] [--dry-run]
      G3: pull feeds (or load from cache), write skills_canonical.json, then derive
      weapon_config.json skillAssignments. Stamps last_updated + patch.
      --cache DIR   load raw feeds from DIR instead of pulling live (fast; default: _refresh_cache/).
      --passives    also fold in weapon-item passives (feed #5; slow when pulling live).
      --dry-run     show what would change, write nothing.

Run with the venv python (stdlib-only; no third-party deps):
  backend/.venv/Scripts/python.exe backend/tools/refresh_game_data.py --counts
"""
from __future__ import annotations

import argparse
import datetime
import difflib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# --------------------------------------------------------------------------------------------
# questlog tRPC pull layer
# --------------------------------------------------------------------------------------------
# Nuxt/Nitro SPA backed by tRPC over Meilisearch. All calls are GET, no auth, game-prefixed
# path, with a RAW `input` query param (NO superjson {"json":...} wrapper):
#   https://questlog.gg/throne-and-liberty/api/trpc/<router>.<proc>?input=<url-encoded JSON>
#   -> {"result":{"data": ... }}
BASE = "https://questlog.gg/throne-and-liberty/api/trpc"
UA = "Mozilla/5.0"
LANG = "en"
_TIMEOUT = 30
_RETRIES = 3
_RETRY_WAIT = 2.0  # seconds, linear backoff


def _trpc(proc: str, inp: dict):
    """GET one tRPC procedure and return ``result.data`` (raw shape varies per procedure)."""
    query = urllib.parse.urlencode({"input": json.dumps(inp, separators=(",", ":"))})
    url = f"{BASE}/{proc}?{query}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    last_err = None
    for attempt in range(_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
                payload = json.load(resp)
            return payload["result"]["data"]
        except (urllib.error.URLError, KeyError, json.JSONDecodeError) as err:  # noqa: PERF203
            last_err = err
            if attempt < _RETRIES - 1:
                time.sleep(_RETRY_WAIT * (attempt + 1))
    raise RuntimeError(f"tRPC {proc} failed after {_RETRIES} tries: {last_err}")


def _paginate(proc: str, base_input: dict) -> list:
    """Pull a paginated database.* procedure ({pageData, pageCount}) across all pages."""
    rows: list = []
    first = _trpc(proc, {**base_input, "page": 1})
    page_count = int(first.get("pageCount", 1) or 1)
    rows.extend(first.get("pageData", []) or [])
    for page in range(2, page_count + 1):
        data = _trpc(proc, {**base_input, "page": page})
        rows.extend(data.get("pageData", []) or [])
    return rows


# --- the six feeds (S2 of the workstream doc) ----------------------------------------------
def pull_skill_sets() -> list:
    """Feed #1+2: 180 base skill-sets (each carries `mainCategory`=weapon + `specializations`)."""
    return _trpc("skillBuilder.getSkillSets", {"language": LANG})


def pull_skill_traits() -> list:
    """Feed #3: 356 skill EFFECTS (`mainCategory`=weapon); names are "<Base> - <Trait>"."""
    return _trpc("skillBuilder.getSkillTraits", {"language": LANG})


def pull_weapon_specializations() -> list:
    """Feed #4: 490 MASTERIES (`mainCategory`=weapon) -> mapped to mainCategory weapon slug."""
    return _trpc("weaponSpecialization.getWeaponSpecializations", {"language": LANG})


def pull_npcs(main_category: str) -> list:
    """Bosses by category. `page` + `type` are REQUIRED (the `type` value itself is ignored);
    `mainCategory` (string) is THE real filter. Unfiltered is Meili-capped, so always filter."""
    return _paginate(
        "database.getNpcs",
        {"language": LANG, "type": "boss", "mainCategory": main_category},
    )


def pull_dungeons() -> list:
    return _paginate("database.getDungeons", {"language": LANG})


def pull_weapon_items() -> list:
    """List rows for weapons (metadata only; skill/damage live in the item DETAIL)."""
    return _paginate("database.getItems", {"language": LANG, "type": "item", "mainCategory": "weapons"})


def pull_item(item_id: str) -> dict:
    """Item detail: `.passives.name` = the combat-log weapon-skill token (feed #5)."""
    return _trpc("database.getItem", {"language": LANG, "id": item_id})


def pull_weapon_passives_live(items: list, progress: bool = True) -> list:
    """Feed #5 live pull: fetch each weapon's item detail and extract its non-null passive
    token. Shared by ``--dump --passives`` and ``--report --passives`` (slow: one getItem
    per weapon -> ~hundreds of calls). Returns [{"name", "weapon"}] (see extract_weapon_passives)."""
    total = len(items or [])
    if progress:
        print(f"  pulling {total} weapon item details (feed #5)...")
    details: dict = {}
    for i, it in enumerate(items or [], 1):
        iid = str(it.get("id") or "")
        if not iid:
            continue
        try:
            details[iid] = pull_item(iid)
        except RuntimeError as err:
            print(f"    [warn] getItem {iid}: {err}")
        if progress and i % 50 == 0:
            print(f"    {i}/{total}")
    return extract_weapon_passives(items, details)


# --------------------------------------------------------------------------------------------
# weapon-label map: questlog `mainCategory` -> meter weapon slug (the 11 existing UI cards)
# --------------------------------------------------------------------------------------------
# Resolved 2026-05-31: index.html already defines all 11 `data-weapon` card slugs; greatsword/
# longbow/staff simply have 0 skills today. So questlog maps onto EXISTING slugs (no UI change):
WEAPON_MAP = {
    "sword2h": "greatsword",
    "sword": "sns",
    "dagger": "dagger",
    "spear": "spear",
    "crossbow": "crossbow",
    "bow": "longbow",
    "staff": "staff",
    "wand": "wand",
    "orb": "orb",
}
# The 11 meter slots (10 weapons + Mastery + Other). Used to validate derived output.
METER_SLUGS = set(WEAPON_MAP.values()) | {"mastery", "other"}

# Slug priority when feeds disagree on the same skill name: a real weapon beats `other`
# (a concrete weapon attribution is always preferred over the fallback bucket).
# `mastery` is no longer a feed-output slug — masteries now map to their mainCategory weapon.
# Keep the priority entry for `mastery` in case the overlay still carries it; weapon still wins.
_SLUG_PRIORITY = {slug: 2 for slug in WEAPON_MAP.values()}
_SLUG_PRIORITY["mastery"] = 1
_SLUG_PRIORITY["other"] = 0


def weapon_slug(main_category) -> str:
    """Map a questlog `mainCategory` to a meter weapon slug; unknown -> 'other'."""
    return WEAPON_MAP.get(str(main_category or "").strip().lower(), "other")


# --------------------------------------------------------------------------------------------
# token normalization + the multi-feed skill->weapon extractor (recipe doc S7)
# --------------------------------------------------------------------------------------------
_ICON_MARKUP = re.compile(r"\^<[^>]*>")  # combat-log icon markup, e.g. "^<imgf=...>"
_WS = re.compile(r"\s+")


def normalize_token(name) -> str:
    """Normalize a skill/effect name to its combat-log token form.

    Strips icon markup (``^<imgf=...> Sword of Judgment`` -> ``Sword of Judgment``) and
    collapses whitespace. Casing/spelling are preserved (combat-log tokens are case-stable).
    """
    if not name:
        return ""
    stripped = _ICON_MARKUP.sub(" ", str(name))
    return _WS.sub(" ", stripped).strip()


def _offer(out: dict, name, slug: str) -> None:
    """Record name->slug into `out`, keeping the higher-priority slug on conflict."""
    token = normalize_token(name)
    if not token:
        return
    current = out.get(token)
    if current is None or _SLUG_PRIORITY.get(slug, 0) > _SLUG_PRIORITY.get(current, 0):
        out[token] = slug


def extract_skill_weapons(
    skill_sets: list,
    skill_traits: list | None = None,
    weapon_specs: list | None = None,
    weapon_passives: list | None = None,
) -> dict:
    """Build the {combat-log token -> weapon slug} map from the feeds (recipe doc S7).

    Sources, in order:
      1. ``getSkillSets[].name``                 (base skill-sets)            -> mainCategory weapon
      2. ``getSkillSets[].specializations[].name`` (the combat log usually emits the SPEC name)
      3. ``getSkillTraits[].name``               (skill effects)             -> mainCategory weapon
      4. ``getWeaponSpecializations[].name``     (masteries)                 -> mainCategory weapon
      5. weapon-item passives ``{name, weapon}`` (non-null only; see pull_item) -> item weapon

    Each name is normalized; on conflict the higher-priority slug wins (weapon > mastery > other).
    """
    out: dict = {}
    for rec in skill_sets or []:
        slug = weapon_slug(rec.get("mainCategory"))
        _offer(out, rec.get("name"), slug)
        for spec in rec.get("specializations") or []:
            _offer(out, spec.get("name"), slug)
    for rec in skill_traits or []:
        _offer(out, rec.get("name"), weapon_slug(rec.get("mainCategory")))
    for rec in weapon_specs or []:
        _offer(out, rec.get("name"), weapon_slug(rec.get("mainCategory")))
    for rec in weapon_passives or []:
        # rec = {"name": <passive.name>, "weapon": <slug already mapped>}
        _offer(out, rec.get("name"), rec.get("weapon") or "other")
    return out


def extract_weapon_passives(items: list, details: dict) -> list:
    """Feed #5: from weapon item rows + their fetched details, yield non-null passive tokens.

    `items` = pull_weapon_items() rows (carry subCategory/mainCategory = weapon type);
    `details` = {item_id: pull_item(item_id)}. Only weapons with a passive contribute, which
    auto-filters to the ~dozens of unique/archboss weapons (common weapons have no passive).
    Returns [{"name": <passive name>, "weapon": <meter slug>}].
    """
    out: list = []
    by_id = {str(it.get("id")): it for it in (items or [])}
    for item_id, detail in (details or {}).items():
        passive = (detail or {}).get("passives") or {}
        pname = passive.get("name") if isinstance(passive, dict) else None
        if not pname:
            continue
        meta = by_id.get(str(item_id), {}) or detail or {}
        slug = weapon_slug(meta.get("subCategory") or meta.get("mainCategory"))
        out.append({"name": pname, "weapon": slug})
    return out


# --------------------------------------------------------------------------------------------
# reconcile + diff (G2) -- read-only: compares pulled feeds vs canonical, never writes
# --------------------------------------------------------------------------------------------
def _norm_key(name) -> str:
    """Normalize a name for matching: strip icon markup, collapse whitespace, casefold."""
    return normalize_token(name).casefold()


def _is_variant(a_words: list, b_words: list) -> bool:
    """True if one whole-word list is a STRICT leading prefix of the other.

    Folds combat-log specialization tokens onto their base skill key
    (e.g. meter "Manaball" <- questlog "Manaball Eruption"/"Manaball Salvo") -- a case
    difflib's ratio alone misses, because a short base and a longer spec share too few
    characters to clear the cutoff. Equal-length lists are never variants (that's the
    exact-match tier), so distinct same-length skills (Brutal Fury vs Brutal Incision)
    are NOT folded.
    """
    if not a_words or not b_words or len(a_words) == len(b_words):
        return False
    short, long = sorted((a_words, b_words), key=len)
    return long[: len(short)] == short


_FALLBACK_SLUGS = ("mastery", "other")


def reconcile_skills(extracted: dict, current: dict, cutoff: float = 0.84) -> dict:
    """Reconcile the feed-extracted {token->slug} map against the meter's current
    skillAssignments {name->slug}. Pure (no network). Returns a structured diff:

      matched  : int                                meter key found, a feed slug agrees
      retagged : [{name, from, to}]                 HIGH-confidence mis-tag: EXACT-name feed
                                                    match, one concrete weapon, disagrees
      review   : [{name, from, feed:[..], via,      AMBIGUOUS: feed disagrees but evidence is
                   tokens:[..]}]                      a variant/fuzzy match, conflicting weapons,
                                                      or only a mastery/other fallback bucket
      orphaned : [{name, weapon, near:[token..]}]   meter key no feed carries (renamed/removed)
      new      : [{name, weapon}]                   feed tokens no meter key matched (G3 adds)

    Matching is tiered per meter key: exact-normalized -> whole-word prefix/containment
    (variant fold; the Manaball <- Manaball Eruption case) -> difflib close-match (>= cutoff).
    Icon markup + casing are normalized on both sides. Matched feed tokens are consumed so they
    are NOT also counted as `new`. A weapon disagreement is only called a confident `retag` when
    the meter key matched a feed token EXACTLY and the feed offers exactly one concrete weapon;
    every other disagreement is surfaced under `review` with its evidence for the human gate.
    """
    feed = []
    for tok, slug in extracted.items():
        nk = _norm_key(tok)
        feed.append((tok, nk, nk.split(), slug))
    feed_norms = [f[1] for f in feed]
    norm_to_token: dict = {}
    for tok, nk, _w, _s in feed:
        norm_to_token.setdefault(nk, tok)

    consumed: set = set()
    matched = 0
    retagged: list = []
    review: list = []
    orphaned: list = []

    for name, mslug in sorted(current.items()):
        nk = _norm_key(name)
        words = nk.split()
        exact = [i for i, (_t, tnk, _tw, _s) in enumerate(feed) if tnk == nk]
        variant = [i for i, (_t, tnk, tw, _s) in enumerate(feed)
                   if tnk != nk and _is_variant(words, tw)]
        if exact:
            idxs, via = exact + variant, "exact"
        elif variant:
            idxs, via = variant, "variant"
        else:
            cand = difflib.get_close_matches(nk, feed_norms, n=1, cutoff=cutoff)
            idxs = [i for i, f in enumerate(feed) if f[1] == cand[0]] if cand else []
            via = "fuzzy"
        if not idxs:
            near = difflib.get_close_matches(nk, feed_norms, n=3, cutoff=0.6)
            orphaned.append({
                "name": name,
                "weapon": mslug,
                "near": [norm_to_token[k] for k in near],
            })
            continue
        consumed.update(idxs)
        feed_slugs = sorted({feed[i][3] for i in idxs},
                            key=lambda s: -_SLUG_PRIORITY.get(s, 0))
        if mslug in feed_slugs:
            matched += 1
            continue
        concrete = [s for s in feed_slugs if s not in _FALLBACK_SLUGS]
        if via == "exact" and feed_slugs == concrete and len(concrete) == 1:
            retagged.append({"name": name, "from": mslug, "to": feed_slugs[0]})
        else:
            review.append({
                "name": name,
                "from": mslug,
                "feed": feed_slugs,
                "via": via,
                "tokens": sorted(feed[i][0] for i in idxs),
            })

    new = sorted(
        ({"name": feed[i][0], "weapon": feed[i][3]}
         for i in range(len(feed)) if i not in consumed),
        key=lambda d: (d["weapon"], d["name"].casefold()),
    )
    return {"matched": matched, "retagged": retagged, "review": review,
            "orphaned": orphaned, "new": new}


def flatten_known_targets(assignments: dict) -> list:
    """Flatten every category list in default_target_assignments.json into one name list
    (non-list values like `last_updated` are ignored)."""
    names: list = []
    for value in (assignments or {}).values():
        if isinstance(value, list):
            names.extend(value)
    return names


def reconcile_bosses(pulled_by_cat: dict, known_names: list) -> dict:
    """Diff pulled NPC names (by questlog mainCategory) against the names already in
    default_target_assignments.json. Pure (no network). Per the locked HYBRID strategy this
    flags NEW names ONLY -- the curated file stays the category authority -- and does NOT
    auto-assign a meter category (categorizing is the human review-gate step). Names are
    compared normalized (case/whitespace) and deduped; the verbatim questlog `name` is
    returned. Returns {questlog_category: [new name, ...]} (empty cats omitted)."""
    known = {_norm_key(n) for n in (known_names or [])}
    new_by_cat: dict = {}
    for cat, npcs in (pulled_by_cat or {}).items():
        seen: set = set()
        fresh: list = []
        for npc in npcs or []:
            name = npc.get("name") if isinstance(npc, dict) else str(npc)
            if not name:
                continue
            nk = _norm_key(name)
            if nk in known or nk in seen:
                continue
            seen.add(nk)
            fresh.append(name)
        if fresh:
            new_by_cat[cat] = sorted(fresh, key=str.casefold)
    return new_by_cat


# --------------------------------------------------------------------------------------------
# G3 — regenerate skills_canonical.json + derive weapon_config.json skillAssignments
# --------------------------------------------------------------------------------------------
# skills_canonical.json schema:
#   {
#     "version": 1,
#     "patch": "<T&L patch version string, e.g. 3.18.0>",
#     "last_updated": "<ISO-8601 UTC>",
#     "generated_from": "questlog.gg tRPC feeds (getSkillSets + getSkillTraits + "
#                       "getWeaponSpecializations [+ weapon passives])",
#     "source": "https://questlog.gg/throne-and-liberty",
#     "entries": { "<skill name>": "<weapon slug>", ... },  <- questlog-derived
#     "overlay": { "<skill name>": "<weapon slug>", ... }   <- curated, hand-maintained residual
#   }
#
# weapon_config.json skillAssignments is the union of entries + overlay (overlay wins on conflict),
# sorted alphabetically, with last_updated restamped to now.
#
# The curated overlay covers the genuinely-orphaned meter keys that no questlog feed carries
# (renamed/removed skills, combat-log-only tokens, or skills that appear in the logs but not the
# questlog skill-builder). It is the ONLY part that requires human curation after a patch; the
# questlog feeds handle the rest automatically.

# Default curated overlay — populated from the 2026-05-31 reconcile report's orphaned list.
# Keys that the feeds DO carry (retagged, matched, or new) are NOT here — they come from entries.
# This residual is intentionally small; it grows only when a combat-log token is genuinely absent
# from all four questlog feeds (rare).
DEFAULT_OVERLAY: dict = {
    # Orphaned meter keys not carried by any feed (as of 2026-05-31 report):
    # Icon-tagged skill token (meter had it with icon markup; canonical stores clean form)
    "^<imgf=IMG_PartyMatching_MainAttacker> Sword of Judgment": "other",
    # Renamed/removed skills -- keep as `other` until confirmed reassigned or removed
    "Basic Shot": "crossbow",         # near: Rapid Shot — likely renamed
    "Copy Satellite": "orb",          # near: Summon Satellite — likely renamed
    "Counterattack Spell": "wand",    # no near match; retained as wand
    "Dimensional Bomb": "orb",        # near: Time Bomb
    "Mutilation": "dagger",           # near: Time Dilation (false positive)
    "Poison Dagger": "dagger",        # near: Hemotoxic Dagger — likely renamed
    "Shield Smash Schema": "other",   # no near match
    "Spiral Slash": "spear",          # near: Spiral Assault — likely renamed
}

SKILLS_CANONICAL_PATH_NAME = "skills_canonical.json"


def build_canonical(
    extracted: dict,
    overlay: dict | None = None,
    patch: str = "",
    with_passives: bool = False,
) -> dict:
    """Build the skills_canonical.json structure from the extracted feed map + curated overlay.

    `extracted` = output of extract_skill_weapons (all four feeds merged).
    `overlay`   = curated residual dict {name: slug}; defaults to DEFAULT_OVERLAY.
    `patch`     = T&L patch version string (e.g. "3.18.0"); empty string if unknown.

    Returns the full canonical dict (not yet written to disk).
    """
    if overlay is None:
        overlay = dict(DEFAULT_OVERLAY)
    feeds_desc = (
        "questlog.gg tRPC feeds (getSkillSets + getSkillTraits + getWeaponSpecializations"
        + (" + weapon passives" if with_passives else "")
        + ")"
    )
    return {
        "version": 1,
        "patch": patch or "",
        "last_updated": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S") + "Z",
        "generated_from": feeds_desc,
        "source": "https://questlog.gg/throne-and-liberty",
        "entries": dict(sorted(extracted.items())),
        "overlay": dict(sorted(overlay.items())),
    }


def derive_skill_assignments(canonical: dict) -> dict:
    """Derive the {name: slug} skillAssignments dict from a canonical structure.

    Merges entries + overlay; overlay wins on conflict (it's the curated authority for residuals).
    Returns a new dict sorted alphabetically by skill name.
    """
    merged: dict = {}
    merged.update(canonical.get("entries") or {})
    merged.update(canonical.get("overlay") or {})   # overlay wins
    return dict(sorted(merged.items()))


def write_skills_canonical(canonical: dict, path: Path) -> None:
    """Write skills_canonical.json to disk."""
    path.write_text(json.dumps(canonical, indent=2, ensure_ascii=False), encoding="utf-8")


def derive_weapon_config(skill_assignments: dict, existing_path: Path) -> dict:
    """Derive the full weapon_config.json dict by replacing skillAssignments in the existing
    file, restamping last_updated to now. Preserves any other top-level keys.

    `skill_assignments` = output of derive_skill_assignments.
    `existing_path`     = current weapon_config.json path (may not exist; that's OK).
    """
    try:
        existing = _load_json(existing_path)
    except (FileNotFoundError, json.JSONDecodeError):
        existing = {}
    updated = dict(existing)
    updated["skillAssignments"] = skill_assignments
    updated["last_updated"] = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")
    return updated


def write_weapon_config(weapon_cfg: dict, path: Path) -> None:
    """Write weapon_config.json to disk."""
    path.write_text(json.dumps(weapon_cfg, indent=2, ensure_ascii=False), encoding="utf-8")


# --------------------------------------------------------------------------------------------
# G4 — derive KNOWN_BOSSES + rewrite index.js sentinel block + regenerate dungeons.json
# --------------------------------------------------------------------------------------------
# The sentinel-rewrite targets these EXACT markers inside workers/party/src/index.js:
#   // @gen:known_bosses:start
#   ...generated JS object lines...
#   // @gen:known_bosses:end
#
# If either sentinel is absent the function is a no-op (the lane that owns index.js may not
# have wired the sentinels yet; we never touch the file in that case).
#
# Which categories from default_target_assignments.json feed KNOWN_BOSSES?
# Only the "boss" categories — not "adds" or "other" (those are trash).
KNOWN_BOSSES_CATEGORIES = {"archboss", "field_boss", "raid_boss", "dungeon_boss"}

_SENTINEL_START = "// @gen:known_bosses:start"
_SENTINEL_END = "// @gen:known_bosses:end"


def derive_known_bosses_map(target_assignments: dict) -> dict:
    """Derive the {normalized_name: category} map for KNOWN_BOSSES in index.js.

    Only entries whose top-level key is in KNOWN_BOSSES_CATEGORIES are included
    (i.e. archboss/field_boss/raid_boss/dungeon_boss — NOT adds/other).
    Normalization matches the worker's `norm()` fn: trim + lowercase.

    Returns a plain dict {normalized_name: category_string} sorted by key.
    """
    out: dict = {}
    for category, names in (target_assignments or {}).items():
        if category not in KNOWN_BOSSES_CATEGORIES:
            continue
        if not isinstance(names, list):
            continue
        for name in names:
            if not name:
                continue
            key = str(name).strip().lower()
            if key:
                # Last-write wins on collision (shouldn't happen, but be deterministic)
                out[key] = category
    return dict(sorted(out.items()))


def build_known_bosses_js_lines(boss_map: dict) -> str:
    """Render the boss_map as JS object-literal lines, one per entry, trailing comma on each.

    The output is meant to be inserted BETWEEN the sentinel comments so that the block
    (including sentinels) looks like:

        // @gen:known_bosses:start
          "tevent": "archboss",
          "ascended tevent": "archboss",
          ...
        // @gen:known_bosses:end

    Entries are sorted (derive_known_bosses_map guarantees this). Each line is indented
    with two spaces to match the surrounding object literal style in index.js.
    """
    if not boss_map:
        return ""
    lines = [f'  "{k}": "{v}",' for k, v in boss_map.items()]
    return "\n".join(lines)


def rewrite_known_bosses_sentinel(source: str, boss_map: dict) -> tuple[str, bool]:
    """Rewrite the KNOWN_BOSSES sentinel block inside `source` (string content of index.js).

    Finds the lines containing _SENTINEL_START and _SENTINEL_END (exact substring match,
    preserving the line's leading whitespace), replaces everything BETWEEN them with the
    generated JS lines.  Lines that ARE the sentinels themselves are kept verbatim.

    Returns:
        (new_source, changed) where `changed` is True if the content differs from `source`.
        If either sentinel is absent, returns (source, False) — guaranteed no-op.
    """
    lines = source.splitlines(keepends=True)
    start_idx: int | None = None
    end_idx: int | None = None
    for i, line in enumerate(lines):
        if _SENTINEL_START in line:
            start_idx = i
        elif _SENTINEL_END in line and start_idx is not None:
            end_idx = i
            break

    if start_idx is None or end_idx is None:
        # Sentinels absent — guaranteed no-op
        return source, False

    generated = build_known_bosses_js_lines(boss_map)
    # Preserve the newline character that ended the start-sentinel line
    start_line = lines[start_idx]
    end_line = lines[end_idx]

    new_lines = lines[: start_idx + 1]
    if generated:
        # Ensure generated block ends with a newline before the closing sentinel
        new_lines.append(generated + "\n")
    new_lines.append(end_line)
    if end_idx + 1 < len(lines):
        new_lines.extend(lines[end_idx + 1 :])

    new_source = "".join(new_lines)
    return new_source, new_source != source


def rewrite_index_js_known_bosses(index_js_path: Path, boss_map: dict, dry_run: bool = False) -> bool:
    """Read index.js, rewrite the KNOWN_BOSSES sentinel block, and write back if changed.

    Returns True if a write was performed (or would be, under dry_run).
    Is a no-op (returns False) if sentinels are absent — safe to call unconditionally.
    """
    if not index_js_path.exists():
        print(f"  [warn] index.js not found at {index_js_path} — KNOWN_BOSSES rewrite skipped")
        return False

    source = index_js_path.read_text(encoding="utf-8")
    new_source, changed = rewrite_known_bosses_sentinel(source, boss_map)

    if not changed:
        if _SENTINEL_START not in source:
            print("  KNOWN_BOSSES sentinels absent in index.js — no-op (another lane will add them)")
        else:
            print("  KNOWN_BOSSES block already up-to-date in index.js — no changes")
        return False

    if dry_run:
        print(f"  [dry-run] Would rewrite KNOWN_BOSSES block in {index_js_path}")
        return True

    index_js_path.write_text(new_source, encoding="utf-8")
    print(f"  Rewrote KNOWN_BOSSES block in {index_js_path} ({len(boss_map)} entries)")
    return True


def regenerate_dungeons_json(dungeons_path: Path, dry_run: bool = False) -> bool:
    """Pull the questlog dungeons feed and regenerate dungeons.json.

    The existing dungeons.json groups dungeon names by type string (e.g. "Co-op Dungeon",
    "Raid", "Field Boss"). The questlog feed carries a `type` field on each dungeon row.

    Returns True if a write was performed (or would be, under dry_run).
    On network failure, prints a warning and returns False (leaves existing file untouched).
    """
    try:
        print("  Pulling questlog dungeons feed...")
        rows = pull_dungeons()
        print(f"  Got {len(rows)} dungeon rows from questlog")
    except RuntimeError as err:
        print(f"  [warn] Dungeons feed unreachable: {err}")
        print("  Leaving existing dungeons.json untouched.")
        return False

    # Group by type
    grouped: dict = {}
    for row in rows or []:
        dtype = str(row.get("type") or "").strip()
        name = str(row.get("name") or "").strip()
        if not dtype or not name:
            continue
        grouped.setdefault(dtype, [])
        if name not in grouped[dtype]:
            grouped[dtype].append(name)

    # Sort each group; sort groups by key
    out = {k: sorted(v) for k, v in sorted(grouped.items())}

    if dry_run:
        print(f"  [dry-run] Would write {dungeons_path} ({sum(len(v) for v in out.values())} dungeons)")
        return True

    dungeons_path.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  Wrote {dungeons_path} ({sum(len(v) for v in out.values())} dungeons, "
          f"{len(out)} types)")
    return True


# --------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------
NPC_BOSS_CATEGORIES = ("boss-world", "boss", "solo-elite")
DEFAULT_CACHE = Path(__file__).resolve().parent / "_refresh_cache"
# Canonical files live at the repo root (backend/tools/refresh_game_data.py -> parents[2]).
ROOT = Path(__file__).resolve().parents[2]
WEAPON_CONFIG_PATH = ROOT / "weapon_config.json"
SKILLS_CANONICAL_PATH = ROOT / SKILLS_CANONICAL_PATH_NAME
TARGET_ASSIGNMENTS_PATH = ROOT / "default_target_assignments.json"
DUNGEONS_JSON_PATH = ROOT / "dungeons.json"
INDEX_JS_PATH = ROOT / "workers" / "party" / "src" / "index.js"


def _load_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _load_feeds_from_cache(cache_dir: Path, with_passives: bool) -> tuple:
    """Load raw feed JSON from a prior --dump run instead of pulling live.

    Returns (skill_sets, skill_traits, weapon_specs, weapon_passives_or_None).
    Raises FileNotFoundError if any required feed file is missing.
    """
    def _read(name: str):
        return _load_json(cache_dir / f"{name}.json")

    sets = _read("skill_sets")
    traits = _read("skill_traits")
    specs = _read("weapon_specializations")
    passives: list | None = None
    if with_passives:
        passives_path = cache_dir / "weapon_passives.json"
        if passives_path.exists():
            passives = _load_json(passives_path)
        else:
            print(f"  [warn] --passives requested but {passives_path} not found in cache; "
                  "feed #5 skipped. Re-run --dump --passives to populate it.")
    return sets, traits, specs, passives


def _counts() -> int:
    print("Pulling questlog feeds (live)...")
    sets = pull_skill_sets()
    traits = pull_skill_traits()
    specs = pull_weapon_specializations()
    print(f"  getSkillSets ............. {len(sets):>5}  (expect ~180)")
    print(f"  getSkillTraits .......... {len(traits):>5}  (expect ~356)")
    print(f"  getWeaponSpecializations  {len(specs):>5}  (expect ~490)")
    for cat in NPC_BOSS_CATEGORIES:
        npcs = pull_npcs(cat)
        names = len({n.get("name") for n in npcs})
        print(f"  getNpcs[{cat:<11}] ... {len(npcs):>5} rows / {names} distinct names")
    dungeons = pull_dungeons()
    print(f"  getDungeons ............. {len(dungeons):>5}")
    items = pull_weapon_items()
    print(f"  getItems[weapons] ....... {len(items):>5}")
    skill_map = extract_skill_weapons(sets, traits, specs)
    by_slug: dict = {}
    for slug in skill_map.values():
        by_slug[slug] = by_slug.get(slug, 0) + 1
    print(f"  extracted skill->weapon . {len(skill_map):>5} tokens")
    print("    by slug: " + ", ".join(f"{k}={v}" for k, v in sorted(by_slug.items())))
    return 0


def _dump(out_dir: Path, with_passives: bool) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Dumping raw feeds -> {out_dir}")

    def _save(name: str, data) -> None:
        path = out_dir / f"{name}.json"
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        n = len(data) if isinstance(data, (list, dict)) else "?"
        print(f"  {name:<26} {n}")

    sets = pull_skill_sets()
    traits = pull_skill_traits()
    specs = pull_weapon_specializations()
    _save("skill_sets", sets)
    _save("skill_traits", traits)
    _save("weapon_specializations", specs)
    npcs_by_cat = {cat: pull_npcs(cat) for cat in NPC_BOSS_CATEGORIES}
    _save("npcs_by_category", npcs_by_cat)
    _save("dungeons", pull_dungeons())
    items = pull_weapon_items()
    _save("weapon_items", items)

    passives: list = []
    if with_passives:
        passives = pull_weapon_passives_live(items)
        _save("weapon_passives", passives)

    skill_map = extract_skill_weapons(sets, traits, specs, passives or None)
    _save("skill_weapon_map", skill_map)
    print("Done. (read-only: no canonical or derived files were touched.)")
    return 0


def _render_skill_diff(diff: dict) -> None:
    print("\n=== SKILL -> WEAPON RECONCILE (vs weapon_config.json skillAssignments) ===")
    print(f"  meter keys matched (weapon agrees)   : {diff['matched']}")
    print(f"  retagged  (exact match, confident)   : {len(diff['retagged'])}")
    print(f"  review    (ambiguous match)          : {len(diff['review'])}")
    print(f"  orphaned  (no feed carries it)       : {len(diff['orphaned'])}")
    print(f"  new feed tokens (G3 would add)       : {len(diff['new'])}")

    if diff["retagged"]:
        print("\n  -- RETAG: exact-name match, feed weapon differs (high-confidence G3 fixes) --")
        for r in sorted(diff["retagged"], key=lambda d: d["name"].casefold()):
            print(f"     {r['name']:<42} {r['from']} -> {r['to']}")

    if diff["review"]:
        print("\n  -- REVIEW: ambiguous (variant/fuzzy match, conflicting, or fallback-only) --")
        for r in sorted(diff["review"], key=lambda d: d["name"].casefold()):
            ev = ", ".join(r["tokens"][:4]) + (" ..." if len(r["tokens"]) > 4 else "")
            print(f"     {r['name']:<42} {r['from']} -> {'/'.join(r['feed'])}  [{r['via']}: {ev}]")

    if diff["orphaned"]:
        print("\n  -- ORPHANED meter keys (renamed/removed? -> curated overlay) --")
        for o in sorted(diff["orphaned"], key=lambda d: d["name"].casefold()):
            hint = f"   ~ {', '.join(o['near'])}" if o["near"] else ""
            print(f"     {o['name']:<42} [{o['weapon']}]{hint}")

    if diff["new"]:
        by_slug: dict = {}
        for n in diff["new"]:
            by_slug.setdefault(n["weapon"], []).append(n["name"])
        print("\n  -- NEW feed tokens by weapon (questlog-suggested; G3 populates these) --")
        for slug in sorted(by_slug):
            names = by_slug[slug]
            print(f"     {slug} ({len(names)}):")
            for nm in names:
                print(f"        + {nm}")


def _render_boss_diff(diff: dict) -> None:
    print("\n=== NEW BOSSES (vs default_target_assignments.json) ===")
    total = sum(len(v) for v in diff.values())
    if not total:
        print("  none -- every pulled boss name is already categorized.")
        return
    print(f"  {total} new boss name(s) to categorize (hybrid: assign a meter category by hand):")
    for cat in sorted(diff):
        names = diff[cat]
        print(f"\n  questlog[{cat}] -- {len(names)} new:")
        for nm in names:
            print(f"     + {nm}")


def _report(with_passives: bool) -> int:
    print("Pulling questlog feeds (live)...")
    sets = pull_skill_sets()
    traits = pull_skill_traits()
    specs = pull_weapon_specializations()
    npcs_by_cat = {cat: pull_npcs(cat) for cat in NPC_BOSS_CATEGORIES}
    items = pull_weapon_items()
    passives = pull_weapon_passives_live(items) if with_passives else None
    if not with_passives:
        print("  (feed #5 weapon passives SKIPPED -- pass --passives to fold them in; without it,\n"
              "   unique-weapon procs like \"Enraged Tevent's Hunger\" show as ORPHANED, not retagged.)")

    extracted = extract_skill_weapons(sets, traits, specs, passives)
    current = _load_json(WEAPON_CONFIG_PATH).get("skillAssignments", {})
    skill_diff = reconcile_skills(extracted, current)

    known = flatten_known_targets(_load_json(TARGET_ASSIGNMENTS_PATH))
    boss_diff = reconcile_bosses(npcs_by_cat, known)

    _render_skill_diff(skill_diff)
    _render_boss_diff(boss_diff)
    print("\n(read-only: no canonical or derived files were touched. G3/G4 regenerate from this diff.)")
    return 0


def _skill_counts_by_slug(assignments: dict) -> dict:
    """Return {slug: count} from a skillAssignments dict."""
    counts: dict = {}
    for slug in assignments.values():
        counts[slug] = counts.get(slug, 0) + 1
    return counts


def _regenerate(cache_dir: Path | None, with_passives: bool, dry_run: bool) -> int:
    """G3: pull or load feeds, write skills_canonical.json, derive weapon_config.json.

    When `cache_dir` is given, loads raw feeds from that directory instead of pulling live.
    When `dry_run` is True, prints what would change but writes nothing.
    """
    # --- load feeds ---
    if cache_dir is not None:
        print(f"Loading feeds from cache: {cache_dir}")
        try:
            sets, traits, specs, passives = _load_feeds_from_cache(cache_dir, with_passives)
        except FileNotFoundError as err:
            print(f"ERROR: cache missing a required file: {err}", file=sys.stderr)
            return 1
        print(f"  skill_sets: {len(sets)}, skill_traits: {len(traits)}, "
              f"weapon_specs: {len(specs)}"
              + (f", weapon_passives: {len(passives)}" if passives else " (no passives)"))
    else:
        print("Pulling questlog feeds (live)...")
        sets = pull_skill_sets()
        traits = pull_skill_traits()
        specs = pull_weapon_specializations()
        passives = None
        if with_passives:
            items = pull_weapon_items()
            passives = pull_weapon_passives_live(items)
        print(f"  skill_sets: {len(sets)}, skill_traits: {len(traits)}, "
              f"weapon_specs: {len(specs)}"
              + (f", passives: {len(passives)}" if passives else " (no passives)"))

    # --- extract ---
    extracted = extract_skill_weapons(sets, traits, specs, passives)
    print(f"  extracted {len(extracted)} skill->weapon tokens")

    # --- build canonical (overlay = DEFAULT_OVERLAY) ---
    canonical = build_canonical(extracted, overlay=None, with_passives=bool(passives))

    # --- show before/after skillAssignment counts ---
    try:
        before_cfg = _load_json(WEAPON_CONFIG_PATH)
        before_assignments = before_cfg.get("skillAssignments", {})
    except (FileNotFoundError, json.JSONDecodeError):
        before_assignments = {}

    new_assignments = derive_skill_assignments(canonical)

    before_by_slug = _skill_counts_by_slug(before_assignments)
    after_by_slug = _skill_counts_by_slug(new_assignments)

    print("\n=== skillAssignments BEFORE -> AFTER ===")
    all_slugs = sorted(set(before_by_slug) | set(after_by_slug))
    for slug in all_slugs:
        b = before_by_slug.get(slug, 0)
        a = after_by_slug.get(slug, 0)
        delta = f"+{a - b}" if a > b else (f"{a - b}" if a != b else "=")
        flag = " <-- WAS EMPTY" if b == 0 and a > 0 else ""
        print(f"  {slug:<12} {b:>4} -> {a:>4}  ({delta}){flag}")
    total_before = len(before_assignments)
    total_after = len(new_assignments)
    print(f"  {'TOTAL':<12} {total_before:>4} -> {total_after:>4}  "
          f"({'+' if total_after >= total_before else ''}{total_after - total_before})")

    if dry_run:
        print("\n[dry-run] No files written.")
        print(f"  Would write: {SKILLS_CANONICAL_PATH}")
        print(f"  Would write: {WEAPON_CONFIG_PATH}")
        # G4 dry-run output is handled inside rewrite_index_js_known_bosses /
        # regenerate_dungeons_json — fall through to G4 block which checks dry_run itself.
        # Early return here would skip G4 dry-run reporting, so we continue instead.
        # (The G4 functions print "[dry-run] Would write ..." and return without writing.)
        try:
            target_assignments_dry = _load_json(TARGET_ASSIGNMENTS_PATH)
        except (FileNotFoundError, json.JSONDecodeError):
            target_assignments_dry = {}
        boss_map_dry = derive_known_bosses_map(target_assignments_dry)
        print(f"  KNOWN_BOSSES: {len(boss_map_dry)} entries from "
              f"{TARGET_ASSIGNMENTS_PATH.name}")
        rewrite_index_js_known_bosses(INDEX_JS_PATH, boss_map_dry, dry_run=True)
        regenerate_dungeons_json(DUNGEONS_JSON_PATH, dry_run=True)
        return 0

    # --- write canonical ---
    write_skills_canonical(canonical, SKILLS_CANONICAL_PATH)
    print(f"\nWrote {SKILLS_CANONICAL_PATH}  "
          f"({len(canonical['entries'])} entries, {len(canonical['overlay'])} overlay)")

    # --- derive + write weapon_config ---
    weapon_cfg = derive_weapon_config(new_assignments, WEAPON_CONFIG_PATH)
    write_weapon_config(weapon_cfg, WEAPON_CONFIG_PATH)
    print(f"Wrote {WEAPON_CONFIG_PATH}  ({len(new_assignments)} skillAssignments)")

    # --- G4: KNOWN_BOSSES sentinel rewrite ---
    print("\n=== G4: KNOWN_BOSSES + dungeons.json ===")
    try:
        target_assignments = _load_json(TARGET_ASSIGNMENTS_PATH)
    except (FileNotFoundError, json.JSONDecodeError) as err:
        print(f"  [warn] Could not load {TARGET_ASSIGNMENTS_PATH}: {err}")
        target_assignments = {}

    boss_map = derive_known_bosses_map(target_assignments)
    print(f"  Derived {len(boss_map)} KNOWN_BOSSES entries from {TARGET_ASSIGNMENTS_PATH.name}")
    rewrite_index_js_known_bosses(INDEX_JS_PATH, boss_map, dry_run=dry_run)

    # --- G4: regenerate dungeons.json ---
    regenerate_dungeons_json(DUNGEONS_JSON_PATH, dry_run=dry_run)

    print("\nDone. G3 + G4 complete. Run pytest to verify.")
    return 0


def main(argv=None) -> int:
    # questlog names carry non-ASCII glyphs (e.g. U+25B2); Windows' default cp1252 stdout
    # crashes on them when output is redirected. Force UTF-8 so the diff renders intact.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    parser = argparse.ArgumentParser(description="Game-data refresh (G1+G2+G3+G4)")
    grp = parser.add_mutually_exclusive_group(required=True)
    grp.add_argument("--counts", action="store_true", help="live-probe every feed and print counts")
    grp.add_argument("--dump", nargs="?", const=str(DEFAULT_CACHE), metavar="DIR",
                     help="pull every feed live and write raw JSON + the extracted map to DIR")
    grp.add_argument("--report", action="store_true",
                     help="pull live, reconcile vs canonical, print the patch diff (read-only)")
    grp.add_argument("--regenerate", action="store_true",
                     help="G3+G4: write skills_canonical.json + derive weapon_config.json skillAssignments, "
                          "rewrite index.js KNOWN_BOSSES sentinel, regenerate dungeons.json")
    parser.add_argument("--passives", action="store_true",
                        help="with --dump/--report/--regenerate: also pull each weapon's item detail "
                             "(feed #5; slow when live; uses cached weapon_passives.json if --cache)")
    parser.add_argument("--cache", nargs="?", const=str(DEFAULT_CACHE), metavar="DIR",
                        help="with --regenerate: load raw feeds from this cache dir instead of live pull "
                             f"(default: {DEFAULT_CACHE})")
    parser.add_argument("--dry-run", action="store_true",
                        help="with --regenerate: show what would change, write nothing")
    args = parser.parse_args(argv)
    try:
        if args.counts:
            return _counts()
        if args.report:
            return _report(args.passives)
        if args.regenerate:
            cache_dir = Path(args.cache) if args.cache is not None else None
            return _regenerate(cache_dir, args.passives, args.dry_run)
        return _dump(Path(args.dump), args.passives)
    except RuntimeError as err:
        print(f"ERROR: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

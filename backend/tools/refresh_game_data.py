"""Game-data refresh — keep skill->weapon / boss->category / weapon-spec current per T&L patch.

Driven off questlog.gg's own tRPC API (no scraping), consolidated to ONE canonical source per
domain, with the meter's derived files (weapon_config.json skillAssignments, the party worker's
KNOWN_BOSSES, dungeons.json) GENERATED so the layers can never drift.

Full design + the reverse-engineered API map: TL-DPS-Meter-oracle/docs/WORKSTREAM-GAME-DATA-REFRESH.md

The full workflow is pull -> extract -> reconcile -> diff -> review-gate -> regenerate -> verify,
built in gated segments. THIS FILE currently implements **G1 + G2 (pull/extract + reconcile/diff,
read-only)**:
  * G1: the questlog tRPC pull layer (GET, no auth, raw `input`), the questlog-mainCategory ->
    meter-weapon-slug map (the 11 existing UI cards), combat-log token normalization + the
    multi-feed skill->weapon extractor (recipe doc S7).
  * G2: fuzzy reconcile of the extracted map vs the meter's skillAssignments + a boss-name diff
    vs default_target_assignments.json, emitted as a human-readable patch diff (`--report`).
Later segments regenerate skills (G3) and derive bosses/dungeons (G4).

CLI (read-only; never touches canonical or derived files):
  py backend/tools/refresh_game_data.py --counts
      live-probe every feed and print record counts (the cheapest gate check).
  py backend/tools/refresh_game_data.py --dump [DIR] [--passives]
      pull every feed live and write the raw JSON + the extracted skill->weapon map to DIR
      (default backend/tools/_refresh_cache/, gitignored). --passives also pulls each weapon's
      item detail for feed #5 (slow: ~hundreds of getItem calls).
  py backend/tools/refresh_game_data.py --report [--passives]
      pull every feed live, reconcile against canonical (weapon_config.json skillAssignments +
      default_target_assignments.json), and print the human-readable patch diff (read-only).

Run with the venv python (stdlib-only; no third-party deps):
  backend/.venv/Scripts/python.exe backend/tools/refresh_game_data.py --counts
"""
from __future__ import annotations

import argparse
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
    """Feed #4: 490 MASTERIES (`mainCategory`=weapon) -> the meter's `mastery` card."""
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

# Slug priority when feeds disagree on the same skill name: a real weapon beats `mastery`
# beats `other` (a concrete weapon attribution is always preferred over a fallback bucket).
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
      4. ``getWeaponSpecializations[].name``     (masteries)                 -> 'mastery'
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
        _offer(out, rec.get("name"), "mastery")
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
# CLI (read-only)
# --------------------------------------------------------------------------------------------
NPC_BOSS_CATEGORIES = ("boss-world", "boss", "solo-elite")
DEFAULT_CACHE = Path(__file__).resolve().parent / "_refresh_cache"
# Canonical files live at the repo root (backend/tools/refresh_game_data.py -> parents[2]).
ROOT = Path(__file__).resolve().parents[2]
WEAPON_CONFIG_PATH = ROOT / "weapon_config.json"
TARGET_ASSIGNMENTS_PATH = ROOT / "default_target_assignments.json"


def _load_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


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


def main(argv=None) -> int:
    # questlog names carry non-ASCII glyphs (e.g. U+25B2); Windows' default cp1252 stdout
    # crashes on them when output is redirected. Force UTF-8 so the diff renders intact.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    parser = argparse.ArgumentParser(description="Game-data refresh (G1: pull + extract, read-only)")
    grp = parser.add_mutually_exclusive_group(required=True)
    grp.add_argument("--counts", action="store_true", help="live-probe every feed and print counts")
    grp.add_argument("--dump", nargs="?", const=str(DEFAULT_CACHE), metavar="DIR",
                     help="pull every feed live and write raw JSON + the extracted map to DIR")
    grp.add_argument("--report", action="store_true",
                     help="pull live, reconcile vs canonical, print the patch diff (read-only)")
    parser.add_argument("--passives", action="store_true",
                        help="with --dump/--report: also pull each weapon's item detail (feed #5; slow)")
    args = parser.parse_args(argv)
    try:
        if args.counts:
            return _counts()
        if args.report:
            return _report(args.passives)
        return _dump(Path(args.dump), args.passives)
    except RuntimeError as err:
        print(f"ERROR: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

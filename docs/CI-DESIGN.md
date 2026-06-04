# CI Design — run the backend test suite on every push & PR

> **Status:** Draft design, ready to implement locally.
> **Goal:** A GitHub Actions workflow that runs `backend/`'s pytest suite
> automatically on every push and pull request, so a regression turns the
> check red in ~1 minute instead of reaching a user.
>
> This is a *plan you execute*, not a wired-up workflow — nothing here runs
> until you add the workflow file in step 4 and push it.

---

## 1. What we already have (and the one gap)

| Layer | Status | Notes |
|---|---|---|
| Semantic versioning + CHANGELOG | ✅ strong | `MAJOR.MINOR.PATCH`, user-language entries |
| Test suite | ✅ strong | 26 files, ~333 tests; many are named after real bugs |
| Release automation | ✅ | `.github/workflows/discord-release.yml` |
| Weekly game-data refresh | ✅ | `.github/workflows/refresh-gamedata.yml` (live questlog API) |
| **Test-running CI on push/PR** | ❌ **gap** | *Nothing runs the suite automatically. This doc closes that.* |

Right now the only safety net is remembering to run `uv run pytest` by hand
before pushing. This design makes it automatic.

---

## 2. Verified findings (measured 2026-06-04, headless Linux)

Running the suite via `uv` on a clean machine:

```
292 passed, 29 skipped, 2 xfailed   ← in ~14s, once the 9 below are excluded
9 failed                            ← all environment-specific, NOT real bugs
```

The 9 failures are **not regressions** — they depend on things that only exist
on your Windows dev machine. They must be excluded from push/PR CI (a fast,
deterministic gate) and are better left to a manual/local full run.

### 2a. The 9 environment-specific tests

**Cluster A — 6 live-network tests** (`backend/tests/test_refresh_game_data.py`)
`derive_known_bosses_map()` / `rewrite_known_bosses_sentinel()` pull live from
`questlog.gg`. No network (or a 403) ⇒ empty boss map ⇒ assertions fail. These
belong to the *weekly refresh* path, which already has its own workflow.

- `test_derive_known_bosses_includes_boss_categories`
- `test_derive_known_bosses_excludes_adds_and_other`
- `test_derive_known_bosses_normalizes_keys`
- `test_derive_known_bosses_empty_input`
- `test_derive_known_bosses_ignores_non_list_values`
- `test_rewrite_sentinel_full_roundtrip_fixture`

> Note: `test_derive_known_bosses_result_sorted` and the other
> `rewrite_sentinel_*` tests *also* call the live functions but happen to pass
> with an empty result (`[] == sorted([])`, empty-map no-op). If you go the
> **marker** route (§3, option B), tag the whole live-network group, not just
> the 6 that fail today — semantic grouping is "hits the network," not "fails
> right now."

**Cluster B — 3 Windows-only tests** (`backend/tests/test_log_status_banner.py`,
class `TestLastCombatAgeS`)
These compute `last_combat_age_s`, which is `None` unless `_log_dir()` resolves
to a real directory. The default is `%LOCALAPPDATA%\TL\Saved\CombatLogs`
(`DEFAULT_LOG_SUBDIR = r"TL\Saved\CombatLogs"`, **backslashes**) — only a real
path on Windows with the game's log folder present.

- `test_last_combat_age_s_float_after_ingest`
- `test_last_combat_age_s_increases_over_time`
- `test_last_combat_age_s_resets_on_new_ingest`

> The sibling tests in the same class that assert `None` (no ingest / no log
> dir) pass fine — it's only the three expecting a real age that need the dir.
> A *better long-term fix* is to make these tests set `config["log_path"]` to a
> `tmp_path` they create, removing the machine dependency entirely. Out of scope
> for the CI task, but worth a follow-up issue.

---

## 3. How to exclude them — pick one

### Option A — skip list in the workflow (recommended for a first CI)
Zero changes to test files; everything lives in one readable workflow file.
The pytest invocation becomes:

```bash
uv run --frozen pytest \
  --deselect tests/test_log_status_banner.py::TestLastCombatAgeS::test_last_combat_age_s_float_after_ingest \
  --deselect tests/test_log_status_banner.py::TestLastCombatAgeS::test_last_combat_age_s_increases_over_time \
  --deselect tests/test_log_status_banner.py::TestLastCombatAgeS::test_last_combat_age_s_resets_on_new_ingest \
  --deselect tests/test_refresh_game_data.py::test_derive_known_bosses_includes_boss_categories \
  --deselect tests/test_refresh_game_data.py::test_derive_known_bosses_excludes_adds_and_other \
  --deselect tests/test_refresh_game_data.py::test_derive_known_bosses_normalizes_keys \
  --deselect tests/test_refresh_game_data.py::test_derive_known_bosses_empty_input \
  --deselect tests/test_refresh_game_data.py::test_derive_known_bosses_ignores_non_list_values \
  --deselect tests/test_refresh_game_data.py::test_rewrite_sentinel_full_roundtrip_fixture
```

- **Pro:** single file, fully commented, no risk to test semantics.
- **Con:** node-id list can rot if a test is renamed (it would start running
  again and fail — a visible, debuggable signal, not a silent one).

### Option B — pytest markers (more "proper", self-documenting)
1. Register markers in `backend/pyproject.toml`:
   ```toml
   [tool.pytest.ini_options]
   markers = [
     "requires_network: hits the live questlog.gg API; excluded from push/PR CI",
     "requires_logdir: needs a real Windows combat-log directory on disk",
   ]
   ```
2. Add `import pytest` to `test_refresh_game_data.py` (it currently doesn't
   import it) and decorate the live-network tests with
   `@pytest.mark.requires_network`; decorate the 3 banner tests with
   `@pytest.mark.requires_logdir`.
3. CI runs: `uv run --frozen pytest -m "not requires_network and not requires_logdir"`.

- **Pro:** intent lives at each test; robust to renames; `pytest -m` reads clearly.
- **Con:** edits 2 test files + pyproject. A local full `uv run pytest` still
  includes them (good — they pass on your Windows machine).

---

## 4. The workflow file (Option A form — copy to `.github/workflows/ci.yml`)

```yaml
name: CI

# Run the backend test suite on every push and pull request so regressions
# surface in ~1 minute. Fast + deterministic: the 9 environment-specific tests
# (live questlog.gg API + Windows-only log-dir) are deselected here and left to
# a local/manual full run. See docs/CI-DESIGN.md for the full rationale.
on:
  push:
    branches: ["**"]
  pull_request:

jobs:
  backend-tests:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@v4

      - name: Install uv
        uses: astral-sh/setup-uv@v6
        with:
          enable-cache: true

      - name: Sync locked dependencies
        run: uv sync --frozen

      - name: Run tests (deterministic subset)
        run: |
          uv run --frozen pytest \
            --deselect tests/test_log_status_banner.py::TestLastCombatAgeS::test_last_combat_age_s_float_after_ingest \
            --deselect tests/test_log_status_banner.py::TestLastCombatAgeS::test_last_combat_age_s_increases_over_time \
            --deselect tests/test_log_status_banner.py::TestLastCombatAgeS::test_last_combat_age_s_resets_on_new_ingest \
            --deselect tests/test_refresh_game_data.py::test_derive_known_bosses_includes_boss_categories \
            --deselect tests/test_refresh_game_data.py::test_derive_known_bosses_excludes_adds_and_other \
            --deselect tests/test_refresh_game_data.py::test_derive_known_bosses_normalizes_keys \
            --deselect tests/test_refresh_game_data.py::test_derive_known_bosses_empty_input \
            --deselect tests/test_refresh_game_data.py::test_derive_known_bosses_ignores_non_list_values \
            --deselect tests/test_refresh_game_data.py::test_rewrite_sentinel_full_roundtrip_fixture
```

Notes:
- `working-directory: backend` matches how the suite is configured
  (`pyproject.toml` sets `testpaths = ["tests"]`, `pythonpath = [".", "tools"]`).
- `uv sync --frozen` installs from `backend/uv.lock` exactly — reproducible, and
  `pywebview` installs cleanly headless because `webview` is a lazy import
  (`main.py` imports it inside the run function, not at module top).
- `enable-cache: true` makes repeat runs fast.

---

## 5. Implement it locally (the checklist you'll run)

```bash
# from the repo root, on a feature branch
mkdir -p .github/workflows
# create .github/workflows/ci.yml with the YAML above

# sanity-check the exact command CI will run, locally first:
cd backend
uv run --frozen pytest \
  --deselect tests/test_log_status_banner.py::TestLastCombatAgeS::test_last_combat_age_s_float_after_ingest \
  ... (the rest of the deselects) ...
# expect: "292 passed, 29 skipped, ... " and exit code 0

git add .github/workflows/ci.yml
git commit -m "ci: run backend test suite on push and PR"
git push -u origin <your-branch>
# open a PR — the new "CI / backend-tests" check appears on it
```

Once it's green on a PR, you can make it a **required check** in
GitHub → repo Settings → Branches → branch protection, so nothing merges red.

---

## 6. Possible follow-ups (separate, optional)

- **De-flake Cluster B** so the 3 banner tests don't need a machine log dir
  (set `config["log_path"]` to a created `tmp_path` in the test). Then they run
  in CI too.
- **Marker migration:** move from Option A's deselect list to Option B markers
  once the suite grows — easier to maintain at scale.
- **Worker tests:** `workers/party/` has no automated tests yet; a future job
  could add a Node/wrangler test step alongside the Python one.
- **Lint/format gate:** add a fast `ruff`/`black --check` step if you want style
  enforced on PRs.

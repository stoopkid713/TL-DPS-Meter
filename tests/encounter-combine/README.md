# Encounter-combine test harness

The measuring stick for encounter recognition (the "glue the chopped-up pieces of one boss
fight back into one fight" work). It loads a **recorded raid run**, runs the recognizer, and
scores the result against a hand-written **answer key** — the known-correct grouping.

## Run it

```bash
node tests/encounter-combine/grade.mjs              # grade every run against its answer key
node tests/encounter-combine/grade.mjs zuy5-difficult   # grade one run
node tests/encounter-combine/rules.test.mjs         # the tiny per-behavior rule-tests
```

Exit 0 = all green. Exit 1 = at least one run grouped wrong.

## The recorded runs live OUTSIDE the repo

The captured exports are large, local-only files (not committed). The grader looks for them
under `TLDPS_CAPTURE_DIR` (default: `C:/Users/Admin/Desktop/TL-DPS Debug`). A run whose export
isn't found is **skipped**, not failed — so this is safe to run on any machine / in CI. Only
the small **answer keys** and the code are in the repo.

```bash
TLDPS_CAPTURE_DIR=/somewhere/else node tests/encounter-combine/grade.mjs
```

## Files

| File | What it is |
|---|---|
| `lib/extract.mjs` | export json → flat segment list (joins boss-name + submitters) |
| `lib/recognizer.mjs` | `groupSegments()` — the gluing. **Phase 0 = STUB (no combine)** + the boss-family map |
| `answer-keys/*.json` | the known-correct grouping per run (the "right answers") |
| `grade.mjs` | loads a run → groups it → scores vs the answer key → PASS/FAIL |

## Answer keys

- **`zuy5-difficult`** — VIDEO-VERIFIED (HP-pixel reader + screen recording). The gold key.
- **`zuy5-normal`**, **`axep`** — INFERRED from boss structure + replay, **no video**. Marked
  `video_verified: false`; the grader grades them leniently (±1 fight, union ≥ expected).

## Status

- **Phase 0 (baseline):** the stub recognizer graded all three runs **RED** (Dragaryle as
  6/11/6 separate fights, blanks left) — proving the test catches the real problem.
- **Phase 1 (done):** `groupSegments` now does the real name+gap combine (boss-family map +
  idle-gap ceiling, blanks dropped, ambiguous same-boss wipe glued-and-flagged). The grader is
  **GREEN on all three runs** and `rules.test.mjs` is 8/8. This is all offline — it touches
  nothing the app or server ships.
- **Next (Phase 2):** wire this same `groupSegments` into the app + worker the safe way
  (store raw pieces, glue at display time).

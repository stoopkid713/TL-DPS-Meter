"""Module-level constants for the TL-DPS-Meter backend (rebuild).

Values are sourced from the old backend disassembly (`server.disasm.txt`) and the
constants reference (`docs/reference/constants.md`). Anything reverse-engineered
from `server.disasm.txt` is marked with its origin so later phases can re-verify.
"""

# --- WebSocket / server (used from Phase 3 onward) -------------------------
HOST = "localhost"          # disasm: HOST
PORT = 8765                 # disasm: PORT; matches frontend WS_URL (index.html:11683)

# --- Combat log grammar ----------------------------------------------------
LOG_VERSION_PREFIX = "CombatLogVersion"   # header line, e.g. "CombatLogVersion,4" -> skipped
LOG_TYPE_DAMAGE = "DamageDone"            # only damage rows are aggregated
MIN_DAMAGE_FIELDS = 10                    # <10 comma fields -> unparseable, skip

# Field indices in a damage row (see SCHEMAS.md "Combat log grammar").
IDX_TIMESTAMP = 0   # "YYYYMMDD-HH:MM:SS:mmm"
IDX_LOG_TYPE = 1    # "DamageDone"
IDX_SKILL = 2       # may contain spaces (but never commas)
IDX_SKILL_ID = 3    # numeric, unused
IDX_DAMAGE = 4      # int
IDX_CRIT = 5        # "1"/"0"
IDX_HEAVY = 6       # "1"/"0"
IDX_HIT_TYPE = 7    # kMaxDamageByCriticalDecision / kNormalHit / kMinDamageByNormal
IDX_CASTER = 8      # player filter
IDX_TARGET = 9      # parts[9:] re-joined on "," (target names may contain commas)

# Hit-type string values (disasm const pool).
HIT_TYPE_CRIT = "kMaxDamageByCriticalDecision"
HIT_TYPE_NORMAL = "kNormalHit"
HIT_TYPE_MIN = "kMinDamageByNormal"

# --- Stats / aggregation ---------------------------------------------------
TOP_HITS_LIMIT = 10              # disasm: slice(None, 10, None) on damage-sorted hits
SIXTY_SECOND_WINDOW = 60.0      # first_60s window length (seconds), boundary inclusive

# gap_stats thresholds (disasm L12300-12480, gap-loop):
GAP_DEAD_THRESHOLD = 1.0    # gaps longer than this contribute (gap - 1.0) to total_dead_time
GAP_MAJOR_THRESHOLD = 2.0   # gaps with duration > this are "major" (counted)
# LIVE broadcast gap_stats `gaps` list keeps records > 1.5s (disasm L12493) — note this
# is looser than GAP_MAJOR_THRESHOLD, which still governs num_major_gaps in the live path.
GAP_LIVE_LIST_THRESHOLD = 1.5

# Rounding (disasm: round(...) calls in the stat-block / gap builders).
ROUND_RATE = 1          # crit_rate / heavy_rate / crit_heavy_rate / percent  -> 1 dp
ROUND_DPS = 1           # dps -> 1 dp
ROUND_DURATION = 1      # duration -> 1 dp
ROUND_GAP_DURATION = 2  # individual gap duration + longest_gap + avg_time_between_hits -> 2 dp
ROUND_DEAD_TIME = 1     # total_dead_time -> 1 dp
ROUND_REL_TIME = 1      # relative_time -> 1 dp

# --- Defaults (config.json) ------------------------------------------------
DEFAULT_HOTKEY = "ctrl+tab"
DEFAULT_BROADCAST_INTERVAL = 0.5
# %LOCALAPPDATA%\TL\Saved\CombatLogs — resolved at runtime in the watcher (Phase 4).
DEFAULT_LOG_SUBDIR = r"TL\Saved\CombatLogs"

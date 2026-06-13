# STOOP board — saved views + Insights (one-time UI setup)

> GitHub's API can't create board **views** or **Insights charts** (no `gh` command, no GraphQL
> mutation), so these are a one-time ~5-minute setup in the web UI. The
> [`board-pulse.mjs`](board-pulse.mjs) script covers the text readout; this adds the *visual* cuts.
>
> Board: https://github.com/users/stoopkid713/projects/1

## How views work (orientation)

- **Views** are the tabs at the top-left of the project. The default one is "View 1" (Board layout,
  grouped by Status). Add a new view with the **`+ New view`** button at the end of the tab row.
- Each view's settings: click the **▾ arrow on the view tab** → you get **Rename**, **Layout**
  (Table / Board / Roadmap), **Group by**, **Sort by**, **Slice by**, **Fields**.
- The **filter bar** is the input at the very top. Useful syntax:
  `priority:Now,Next` (OR), `-priority:Parked` (exclude), `label:"area:worker"` (quote the colon),
  `status:"In Progress"`, `is:open`.

## View 1 — rename the default to "📋 Board"

1. Click the ▾ on the existing "View 1" tab → **Rename** → `📋 Board`.
2. Leave it as Layout = **Board**, Group by = **Status**. (This is the full Kanban.)

## View 2 — "🎯 What Now" (the daily glance)

1. **`+ New view`** → it opens a copy. Click its ▾ → **Rename** → `🎯 What Now`.
2. Layout = **Board**, **Group by = Priority**.
3. In the filter bar type:  `-priority:Parked -priority:Later`  (shows only **Now** + **Next**).
   *(If you'd rather see by column, use Group by = Status and filter `status:"Next Up","In Progress"`.)*
4. This is your "open the board, see what to do" view — keep it as the **first** tab so it's the default.

## View 3 — "🗺️ By Area" (which subsystem)

1. **`+ New view`** → ▾ → Rename → `🗺️ By Area`.
2. Layout = **Table**, **Group by = Labels** (or Slice by → Labels).
3. Filter: `is:open`. Now you can see all open work grouped by worker / backend / frontend / overlay / etc.

## View 4 — "📊 By Priority" (table)

1. **`+ New view`** → ▾ → Rename → `📊 By Priority`.
2. Layout = **Table**, **Group by = Priority**, Sort by = Status.
3. Filter: `is:open`. A compact ranked list of everything open.

## Insights — two charts

1. Open **Insights**: the **📈 chart icon** top-right of the project (or the project **⋯** menu → Insights).
2. **`New chart`** → name it `Open by Priority`:
   - Filter: `is:open`
   - Layout: **Column** (bar)
   - **X-axis = Priority**, Group by = (none). Save.
3. **`New chart`** → `Open by Area`:
   - Filter: `is:open`
   - Layout: **Column**
   - **X-axis = Labels**. Save.
4. (Optional) a third chart X-axis = **Status** to watch the Backlog → Done flow over time as you close items.

## After setup

Reorder the tabs by dragging so **🎯 What Now** is first (your default landing view). The
`board-pulse.mjs` script and the `tldps` skill's RESUME give the same information in text whenever
you want it from the terminal.

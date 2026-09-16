# Calendar view — plan
Written 2026-09-16, against `js/views/calendar.js` and the CALENDAR block of
`css/views.css`, as of the ovulation-marker / predicted-strip change earlier today.

Method: line-level re-read of both files, then run. Playwright seeded 6 periods
(5 flow days each, starts 30 Mar → 27 Aug 2026, tags on the first two days, one
headache day, one BBT reading), screenshotted September / October / August at
1920 dark, 1440 light and 400 dark, and read the model's output for the same
data: window 24–29 Sep, next start 26 Sep, peak 10–11 Sep, elevated 7–9 and
12–14 Sep, estimated ovulation 12 Sep. Render cost measured at 2.15 ms, so
nothing below is a performance problem.

**Implemented 2026-09-16, approved as written with the one-cycle forecast.** Results are in STATUS.md.

---

## Part A — findings, ranked

### A1 · BUG (high): the predicted window reads one week early
The 3px strips sit on the cell's top or bottom edge, which is also the line
between rows. The predicted-window strip on 24–27 Sep draws on the top edge, so
on screen it underlines the row above, 17–20 Sep. The elevated-fertility strip
on 14 Sep sits on the bottom edge and reads as the top of 21 Sep. Someone reading
the grid would say the period is due around 17–22 Sep; the model says 24–29.
This is the top-strip rendering added earlier today — it made the window
visible, but misplaced by eye.
**Fix:** move every marker inside the cell and off its edges: a background tint
for fertility, an inset outline for the predicted window. Anything drawn on a
shared edge can be read as belonging to the neighbouring row, so no edge-anchored
fix is correct.

### A2 · BUG (high): past cycles show no fertile window or ovulation at all
`Epok.Model.fertility()` only covers the open cycle (bands run 27 Aug → 28 Sep).
August — a finished cycle with a known next start — shows five flow dots and
nothing else. Past months look empty, which is most of what "doesn't show fertile
windows or ovulation" means.
**Fix:** a read-only `Epok.Model.history(cycles, opts)` that returns, per
finished cycle, its ovulation (confirmed by `detectOvulation()` over that cycle
if BBT/LH was logged, otherwise the next start minus the luteal mean) and the
fertile range around it. Estimates for past cycles are the better ones, because
the next start is known rather than predicted. They still get the ESTIMATE
marking unless confirmed.

### A3 · BUG (medium): the period is the least visible thing on the page
A period day is a 6px dot (`.cal-dot--flow`), the same size as the "tags logged"
dot. Heavy and spotting look identical. BBT, LH, pill and note get no mark at
all: 13 Sep holds a BBT reading and renders as a blank cell.
**Fix:** period days get a filled cell tint in 4 steps by flow level. One small
neutral dot means "something else logged", and the detail panel (A5) says what.

### A4 · INCONSISTENCY (medium): blank padding cells are the loudest blocks
`.cal-day.is-empty { background: transparent }` shows the grid's `--line` colour
through it. The 1–6 empty cells before and after the month render as solid
slabs, darker than any real day, in every screenshot and both modes.
**Fix:** `background: var(--bg)` on `.is-empty`. One declaration.

### A5 · DESIGN RISK (medium): tapping a day to look at it switches the whole app's logging date
`goToDay()` calls `E.setViewDate(key)` and jumps to Today. Measured: tapping
11 Aug, then returning to Calendar, leaves the app logging 11 Aug under a
"not today (36 days ago)" banner. The banner guards against a wrong-day log, but
the calendar has no way to *see* a day without entering backfill mode. It is
also the only way to learn why a day is tinted.
**Fix:** a tap selects the day and opens a detail panel: date, cycle day, flow,
tags, BBT/LH/pill/note, fertility band with its probability, and whether it
falls in the predicted window. The panel has a **LOG THIS DAY** button that does
today's handoff. At 1280px and wider the panel is a right rail beside the grid —
that also fills the ~560px of empty space under the grid at 1920. Narrower than
that, it sits under the grid.

### A6 · BUG (medium): future months are silently empty
The forecast ends at the next predicted start (plus 2 days). October renders an
empty grid with the full legend still showing, including PREDICTED WINDOW and
OVULATION, neither of which appears in that month.
**Fix:** legend entries only for what is drawn in the month on screen. When the
month is past the forecast, one line under the grid: "No forecast after
29 Sep — epok predicts one cycle ahead." See the open decision below.

### A7 · BUG (medium): the grid is invisible to a screen reader
Every day is a `<button>` whose only text is its number (`aria-label` measured
null). Colour carries all the meaning: fertility, the window, ovulation. Not
tested with an actual screen reader; this is what the DOM exposes.
**Fix:** an `aria-label` per day built from the same data as the detail panel,
e.g. "26 September 2026, cycle day 31, predicted period window, flow none".

### A8 · COSMETIC (low): the ovulation day is not the peak day, with no explanation
Ovulation is estimated for 12 Sep, and 12 Sep is only "elevated"; peak is
10–11 Sep. That is correct — the conception profile peaks 1–2 days before
ovulation — but on the grid it looks like the app contradicting itself.
**Fix:** the detail panel says it in one line, and the ovulation marker becomes
the text `OV` (or `OV?` when estimated) instead of a 6px ring that is hard to
see at 1440.

### A9 · COSMETIC (low): the frame and navigation look unfinished
The card border, card padding and grid border make a double frame. PREV and
NEXT sit 1120px apart at 1920. There is no TODAY button once you have paged
away. The legend wraps to 3 uneven rows at 400px. No cycle-day numbers on
cells, so you cannot read phase at a glance.
**Fix:** drop the grid's own border inside the card. Group `‹ TODAY ›` on one
side with the month title. Put the legend inside the card footer. Add a
`CD n` micro label per cell, shown on day 1 of each cycle and on today, not on
every cell, to avoid clutter.

---

## Part B — the build

Each step can ship on its own; verify after each.

1. **Tokens + contrast.** Add `--period-1..4`, `--fertile-bg`, `--fertile-peak-bg`
   for all 4 palettes × 2 modes in `css/themes.css`. Add `("--fg", each)` to
   `TEXT_ON_SURFACE` in `tools/verify.py` so the 4.5:1 check covers them. This
   comes first because A1 and A3 both put text on tinted backgrounds.
2. **Cell anatomy (A1, A3, A4, A8).** Period fill, fertility tint, inset dashed
   outline for the predicted window, `OV`/`OV?` label, a neutral "other data"
   dot, `.is-empty` on `--bg`. Remove the edge strips.
3. **History (A2).** `Epok.Model.history()` in `js/model.js`, plus a self-check
   in `tools/score.js` that the confirmed ovulation on a seeded BBT cohort
   matches `detectOvulation()`. The calendar draws it for every finished cycle.
4. **Select + detail panel (A5, A7).** The tap selects without calling
   `setViewDate`. The panel, the LOG THIS DAY handoff, per-day `aria-label`.
   Right rail at ≥1280px.
5. **Legend, nav, frame (A6, A9).** Per-month legend, the "no forecast after"
   line, TODAY button, single frame, CD labels.
6. **Harness section `calendar`** in `tools/verify.py`: the cells tagged as
   predicted equal `predict().window` exactly; no marker element touches a cell
   edge; tap leaves `Epok.viewDate()` unchanged; LOG THIS DAY changes it; every
   day has an aria-label; grid + rail width equals min(1120, available) at 1920;
   zero overflow at 400; both modes, 4 palettes.

## Open decision (yours)

**How far ahead should the calendar forecast?** Two readings, genuinely
different work:

| Option | What you see | Cost |
|---|---|---|
| One cycle (current model, recommended) | Next window and fertile days only; later months say so | None beyond step 5 |
| Three cycles | Windows for the next 3 periods, each visibly wider (the uncertainty compounds) | New projection in `model.js`, plus a score.js bar for 2- and 3-ahead error before it ships |

I recommend one cycle: a 3-ahead window on irregular data is wide enough to be
noise, and the model has no measured error for it yet.

## Out of scope

- A week view or a year heatmap — Insights already carries the long view.
- Logging directly in the calendar. Today stays the only logging surface; the
  detail panel hands off to it.
- Any change to the prediction or fertility maths. Step 3 reads existing model
  functions; it does not change a number Today or Insights shows.
- Drag-to-select ranges, swipe month navigation.

# epok — contracts

Written 2026-09-16. **Frozen at Gate 1.** Every signature and shape below is a
promise between windows. Changing one requires a `CONTRACT:` line in
`STATUS.md` and an acknowledgement from the owning window before either side
moves.

Read this in full before writing a line. Never guess a signature — if it isn't
here, it doesn't exist yet, and inventing it is how integration breaks.

---

## Conventions

- `"use strict"`, one IIFE per file, one `window.Epok` namespace with a
  sub-object per module. No globals beyond `Epok`.
- Every file over ~200 lines opens with a `WELLNESS HUB · CORE`-style banner:
  module name, a `·`-bulleted list of what lives in it, then the public
  namespace it attaches.
- **Date keys are strings, `"YYYY-MM-DD"`, local time, derived only through
  `Epok.ymd()`.** Never `Date.toISOString()`. Never UTC.
- Constants live at the top of their file, named, with the reasoning attached.
- Comments explain the decision, not the syntax.
- No `alert()`, no `confirm()`, ever. Inline messages and undo.

---

## Load order

`index.html` loads these in exactly this order. A module may call anything
loaded before it, never after.

```
css/brutal.css
css/themes.css
css/views.css
css/print.css        (media="print")

js/core.js           A   namespace, dates, router, UI, banners, undo
js/storage.js        A   schema, migration, state, export/import
js/crypto.js         A   PIN, AES-GCM, lock screen
js/tags.data.js      C   tag vocabulary (data only, no logic)
js/contraception.data.js  A   method rules table (data only, no logic)
js/model.js          B   Bayesian engine, change-point, luteal
js/backtest.js       B   leave-one-out scoring
js/import-clue.js    C   tolerant CSV parser
js/reminders.js      A   notification scheduling, secure-context handling
js/views/today.js    C
js/views/calendar.js C
js/views/insights.js C
js/views/settings.js C
js/views/report.js   C
js/app.js            A   boot: migrate, mount, route
```

`js/model.js` and `js/backtest.js` must run **unmodified under Node** as well as
in the browser — `tools/score.js` requires them. Guard the namespace attach:

```js
if (typeof module !== "undefined" && module.exports) module.exports = Model;
else (window.Epok = window.Epok || {}).Model = Model;
```

---

## Storage schema

One key: `epok.state.v1`. Write-through previous state at `epok.state.prev`.

`SCHEMA_VERSION = 4` (v2: `profile.reminders`; v3: `cycle.source`, `meta.rejectedStarts`, `day.checkin`; v4: `events`, `cycle.excluded`, `day.severity`, `day.impact`, `day.bbtMeta`). Bumping it ships its migration in the same change.

```js
{
  v: 4,
  profile: {
    created:        "2026-09-16",   // ymd, set once
    ageBand:        null,           // null|"u20"|"20s"|"30s"|"40s"|"50plus"
    conditions:     [],             // ids from CONDITIONS below
    goal:           null,           // null|"track"|"avoid"|"conceive"|"symptoms"
    contraception:  null,           // null|id from CONTRACEPTION below
    contraceptionStart: null,       // ymd — anchors 21+7 / injection cycles
    contraceptionExpiry: null,      // ymd — IUD/implant only
    dayBoundaryHour: 4,             // 0..6. Every date key derives from this.
    theme:          "quasar",       // quasar|arasaka|chernobyl|monolith
    mode:           "dark",         // dark|light|system
    fertilityVisible: true,
    hiddenTags:     [],             // display-only; never deletes logged data
    remindersOn:    false,
    quietHours:     [22, 8]         // [startHour, endHour], local
  },

  days: {
    // Sparse. A day with nothing logged has no key.
    "2026-09-14": {
      flow:  null,      // null|"spotting"|"light"|"medium"|"heavy"
      tags:  [],        // tag ids, order-insensitive
      bbt:   null,      // number, °C, 2dp. Storage is always metric.
      lh:    null,      // null|"negative"|"positive"
      pill:  null,      // null|"taken"|"missed"|"placebo"
      note:  "",
      severity: {},     // v4. { tagId: 1..3 } the user's own rating; only for tags that are on
      impact: null,     // v4. null|"none"|"some"|"a-lot"
      bbtMeta: null,    // v4. { time: "HH:MM"|null, disturbed: null|"illness"|"alcohol"|"poor-sleep"|"travel"|"early-alarm"|"other" }
                        //     a disturbed reading stays in the log and is ignored by detectOvulation()
      checkin: false    // v3. true = "I looked, nothing to log" — an empty tag list then means NONE, not unknown
    }
  },

  cycles: [
    // Derived from days, persisted so a prediction can be reproduced.
    // Sorted ascending by start. Only the last entry may have end === null.
    {
      start:  "2026-08-18",   // ymd, period start — the only date the model consumes
      end:    "2026-08-23",   // ymd|null, last bleeding day
      length: 29,             // int|null — days to next start; null while current
      ovulation: null,        // ymd|null
      ovulationSource: null,  // null|"bbt"|"lh"|"both"
      excluded: false,        // v4. true = shown everywhere, never fitted
      source: "manual"        // v3. "manual" = marked/moved by the user; "flow" = inferred from the flow log.
                              // Only "flow" starts are ever moved or removed by the app.
    }
  ],

  customTags: [
    { id: "custom-1", label: "PHYSIO", category: "pain" }
  ],

  events: [
    // v4. Dated spans. `to: null` = ongoing; `from: null` = unknown start (covers everything before `to`).
    // pregnancy | postpartum -> cycles overlapping them leave the fit; an open one pauses predict()/fertility()
    // contraception (closed, ovulation-suppressing method) -> overlapping cycles leave the fit
    // contraception (open) = the CURRENT method, kept in step with profile.contraception; read from opts.contraception
    // breastfeeding | medication | other -> recorded and shown; breastfeeding adds a caveat to the forecast
    { id: "ev-…", type: "pregnancy", method: null, from: "2026-05-01", to: null, note: "" }
  ],

  predictions: [
    // Written by storage.writeNow() when a cycle first has a forecast and whenever it changes
    // (one per cycle per day). Settled when the next start is logged. `void` = its anchor start was moved/removed. This is how the app measures
    // its own error: compared against what the next cycle actually did.
    { madeOn: "2026-09-14", anchor: "2026-08-18", nextStart: "2026-10-02", window: ["2026-09-30", "2026-10-04"],
      mode: "cycle-length", n: 9, modelVersion: 2, inputRev: "9:2026-08-18:9",
      actual: null, errorDays: null, inWindow: null }   // errorDays = forecast minus actual
  ],

  meta: { lastOpened: "2026-09-16", onboarded: false,
          rejectedStarts: [] }   // v3. ymd starts the user removed that the flow log would re-infer
}
```

### Fixed vocabularies

```js
CONDITIONS      = ["pcos", "endometriosis", "thyroid", "perimenopause"]
FLOW            = ["spotting", "light", "medium", "heavy"]
TAG_CATEGORIES  = ["flow", "pain", "mood", "energy", "sleep",
                   "skin", "digestion", "fluid", "activity"]
CONTRACEPTION   = ["none", "combined-21-7", "combined-24-4", "continuous",
                   "pop", "patch", "ring", "injection", "iud", "implant"]
```

---

## `Epok` — core (Window A)

```js
// Dates. Every date key in the app comes from here.
Epok.ymd(date)                  -> "YYYY-MM-DD"   applies dayBoundaryHour
Epok.today()                    -> ymd            the logging day, boundary-aware
Epok.calendarToday()            -> ymd            wall-clock day, boundary ignored
Epok.shiftDay(key, n)           -> ymd
Epok.daysBetween(a, b)          -> int            b - a, in days
Epok.prettyDate(key)            -> "14 Sep 2026"
Epok.relDay(key)                -> "today"|"yesterday"|"3 days ago"|"in 4 days"

// The logging date. Not today => persistent banner, automatically.
Epok.viewDate()                 -> ymd
Epok.setViewDate(key)           -> void

// Router.
Epok.registerView(id, { title, render, refresh })   // render() -> HTMLElement
Epok.show(id)                   -> void
Epok.refresh()                  -> void            // re-render the active view

// UI primitives. No modals. No confirm().
Epok.el(tag, attrs, children)   -> HTMLElement
Epok.toast(message)             -> void
Epok.banner(id, message, { tone })  -> void        // tone: "info"|"warn"|"danger"
Epok.clearBanner(id)            -> void
Epok.undo(label, restoreFn)     -> void            // shows an undo affordance

// Theme.
Epok.setTheme(name)             -> void            // quasar|arasaka|chernobyl|monolith
Epok.setMode(mode)              -> void            // dark|light|system

Epok.SCHEMA_VERSION             -> 1
Epok.SECURE                     -> bool            // window.isSecureContext
```

## `Epok.Store` — storage (Window A)

```js
Epok.Store.get()                -> state           // live object, do not mutate
Epok.Store.day(key)             -> dayObject       // blank object if unlogged
Epok.Store.editDay(key, patch)  -> void            // merges, saves, refreshes
Epok.Store.cycles()             -> [cycle]         // ascending by start
Epok.Store.currentCycleDay()    -> int|null        // 1-indexed day of cycle

// Period starts are the model's only input, so they get their own path.
// setPeriodStart returns what the change does to the prediction BEFORE it
// commits, so the view can state the consequence inline. Call commit() to apply.
Epok.Store.previewPeriodStart(key)  -> { from: ymd|null, to: ymd,
                                         predictionBefore: ymd|null,
                                         predictionAfter: ymd|null }
Epok.Store.setPeriodStart(key)      -> void        // commits; registers an undo
Epok.Store.clearPeriodStart(key)    -> void

Epok.Store.setProfile(patch)    -> void

// The one place the model's inputs are built: { conditions, ageBand, days,
// asOf: today, contraception: { id, label, start } | null }. Views pass this
// to Model.predict / fertility / history and Backtest.run; do not rebuild it.
Epok.Store.modelOpts()          -> opts
// Spotting alone never starts a cycle. Reconciles inferred ("flow") starts both
// ways — moves one when a backfilled day begins the streak earlier, removes one
// when its flow is cleared — and never touches a "manual" start.
Epok.Store.deriveCyclesFromFlow() -> [ymd]   // starts created

// v4
Epok.Store.addEvent({ type, method?, from?, to?, note? }) -> { ok, error, id }
Epok.Store.endEvent(id, to)     -> { ok, error }
Epok.Store.removeEvent(id)      -> { ok, error }
Epok.Store.setCycleExcluded(start, bool) -> { ok, error }
Epok.Store.moveStart(from, to)  -> { ok, error }   // any date; refuses one within the merge window of ANOTHER start
// Changing profile.contraception closes the open method event (or records the old method as a closed one).
Epok.Store._applyRemote([{ k, v|null }])   // sync only; goes through the normalisers and save()
Epok.Store._onSaved                         // set by Epok.Sync while sync is on

// Ids are stable forever ("custom-<slug>"); labels are stored uppercase.
// Refuses empty, over MAX_TAG_LABEL (24), unknown category, or a label that
// already exists in that category (built-in or custom). Registers an undo.
Epok.Store.addCustomTag(label, category) -> { ok, error, id }
// Refused while any logged day carries the tag — hide it via
// profile.hiddenTags instead. Both refresh the view themselves.
Epok.Store.removeCustomTag(id)           -> { ok, error }
Epok.Store.save()               -> void            // debounced; writes prev first
Epok.Store.exportJSON()         -> Blob            // encrypted if the PIN is on
Epok.Store.exportCSV()          -> Blob            // always plaintext
Epok.Store.importJSON(text)     -> { ok, error }   // migrates on the way in
```

## `Epok.Lock` — encryption (Window A)

```js
Epok.Lock.isEnabled()           -> bool
Epok.Lock.enable(pin)           -> Promise<{ ok, backup: Blob }>
                                   // Rejects unless the caller downloads the
                                   // returned backup. No backup, no encryption.
Epok.Lock.unlock(pin)           -> Promise<{ ok, error }>
Epok.Lock.disable(pin)          -> Promise<{ ok, error }>
Epok.Lock.isLocked()            -> bool
```

## `Epok.Model` — prediction engine (Window B)

Pure functions. No DOM, no `localStorage`, no `Epok.*` calls. Everything the
model needs arrives as arguments, which is what lets `tools/score.js` run it
under Node.

```js
Epok.Model.predict(cycles, opts) -> Prediction
// cycles: [cycle] as stored, ascending.
// opts: { conditions:[], ageBand, days, asOf, contraception, events }
//   `days`  the days map — needed only for BBT/LH in luteal mode. Past cycles'
//           ovulation is DERIVED from it when cycle.ovulation is empty.
//   `asOf`  the date the forecast is made on. Nothing logged after it is read.
//           Omitted: the newest logged day stands in.
//   `contraception` { id, label, start } — an ovulation-suppressing method
//           (combined pill, patch, ring, injection, implant, continuous) pauses
//           the forecast from `start` (no start = paused outright).
//   `events` state.events. Pregnancy/postpartum/closed-method spans drop overlapping cycles
//           from the fit; an open pregnancy or postpartum span pauses (paused: "event").

Prediction = {
  mode:      "population" | "cycle-length" | "luteal",
  nextStart: ymd | null,          // null when the model refuses to predict
  window:    [ymd, ymd] | null,   // central credible interval
  curve:     [{ date: ymd, p: 0.0-1.0 }],   // per-day start probability, sums ~1
  n:         int,                 // cycles actually used in the fit
  refused:   bool,                // true when n < 3 — the view says why
  prior:     { mean: 29.3, sd: 5.0, source: "population"|"pcos"|"perimenopause"|... },
  regime:    { changed: bool, since: ymd | null, dropped: int },
  mae:       number | null,       // measured median abs error, from backtest
  asOf:      ymd | null,
  expired:   bool,                // asOf is past the window's end and no start is logged
  paused:    "contraception" | "event" | null,   // refused for a method or open span, not for lack of cycles
  reason:    string               // one plain sentence the card renders verbatim
}

Epok.Model.fertility(cycles, opts) -> {
  bands:     [{ date: ymd, band: "low"|"elevated"|"peak", p: 0.0-1.0 }],
  ovulation: { date: ymd, source: "bbt"|"lh"|"both"|"estimated" } | null,
  confirmed: bool,                // true only for LH+BBT agreeing or a recorded date; one signal is "detected"
  conflict:  { lh: ymd, bbt: ymd } | null,   // signals disagree: neither used
  paused:    "contraception"?,    // present (bands: []) while a suppressing method is in use
  reason:    string
}
// Never returns a "window closed" claim. See PLAN A6.

// Additive, 2026-09-16 (PLAN-calendar.md A2). Finished cycles only; the open
// cycle stays fertility()'s. No cycle-count floor: nothing here is a forecast.
Epok.Model.history(cycles, opts) -> [{
  start: ymd, end: ymd,           // end is the day before the next start
  ovulation: { date: ymd, source: "bbt"|"lh"|"both"|"recorded"|"estimated" },
  confirmed: bool,                // LH+BBT agreed (or recorded); a single signal is detected, not confirmed
  conflict: { lh: ymd, bbt: ymd } | null,
  bands: [{ date: ymd, band: "low"|"elevated"|"peak", p: 0.0-1.0 }]   // inside [start, end]
}]

Epok.Model.detectOvulation(days, cycleStart, cycleEnd) -> {
  date: ymd | null,               // null when source === "conflict"
  source: "bbt"|"lh"|"both"|"conflict",
  rule: "3-over-6"|"lh-positive"|"disagree",
  lh: ymd | null, bbt: ymd | null // each signal's own date, kept apart
} | null
// "both" needs the two dates within 3 days; further apart is a conflict.

Epok.Model.withOvulation(cycles, days) -> cycles   // closed cycles with a derived ovulation filled in

Epok.Model.lutealStats(cycles) -> { mean, sd, n } | null
```

## `Epok.Backtest` — proof (Window B)

```js
Epok.Backtest.run(cycles) -> {
  mae:     number,        // median absolute error, days
  n:       int,           // predictions scored
  perCycle: [{ start: ymd, predicted: ymd, actual: ymd, errorDays: int, window: [ymd, ymd] }]
}
```

`node tools/score.js` prints a table: cohort × MAE × n. That table is the proof
B4/B5/B20 are done. A described result is a guess.

## `Epok.Tags` — vocabulary (Window C)

Data only. No logic in this file.

```js
Epok.Tags.CATEGORIES -> [{ id, label }]          // label is UPPERCASE, short
Epok.Tags.ALL        -> [{ id, label, category }] // ~30 entries
Epok.Tags.byCategory(id) -> [tag]                 // includes customTags
Epok.Tags.visible()      -> [tag]                 // minus profile.hiddenTags
```

Tag ids are kebab-case, stable forever, and never reused for a different
meaning. Renaming a label is free; changing an id is a migration.

## `Epok.Import` — Clue CSV (Window C)

```js
Epok.Import.parse(text) -> {
  headers:  [string],
  mapping:  { dateColumn, flowColumn, tagColumns: [] },   // best guess
  rows:     int,
  preview:  [dayObject],   // first 5, as they would be stored
  warnings: [string]
}
Epok.Import.apply(text, mapping) -> { added: int, skipped: int, error: null|string }
```

The mapping is shown on screen and correctable before `apply` runs. The format
is **unverified** until a real Clue export has been through it — say so in the UI
and the README.

## `Epok.Reminders` (Window A)

```js
Epok.Reminders.available() -> { ok: bool, reason: string }
// ok:false on file://, with reason naming ./serve.sh — the view renders it inline.
Epok.Reminders.request()   -> Promise<bool>
Epok.Reminders.schedule()  -> void      // reads profile, reschedules everything
Epok.Reminders.due()       -> [{ id, label, at }]   // for the in-app list
```

---

## Visual direction

Swiss/terminal brutalist. Frozen so three windows build the same thing.

| | |
|---|---|
| Type | Mono throughout. `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace` |
| Scale | Extreme contrast: micro-labels 11px uppercase with 0.12em tracking; data numbers 48–72px |
| Geometry | Zero border radius. Zero box-shadow. 1px hairline rules, never 2px+ |
| Colour | Ground plus exactly one accent doing all the work. No gradients |
| Density | Data-dense. An instrument, not a brochure |
| Motion | Near-none. State changes are instant; only the undo affordance animates |
| Case | Labels uppercase, content sentence case. Never uppercase a symptom name a user typed |

### Tokens

Defined once in `css/brutal.css`, valued per palette in `css/themes.css`. Views
use only these — never a raw hex.

```
--bg  --surface  --surface-2  --line  --line-strong
--fg  --fg-dim  --fg-faint
--accent  --on-accent  --accent-dim
--warn  --danger  --estimate      /* --estimate is the gold "this is derived" tag */
```

Light twins are derived from each dark palette, then contrast-checked: AA 4.5:1
for body text, 3:1 for large. `tools/verify.py` asserts this for all 8. A
palette that fails does not ship.

### Layout

Left rail on desktop, bottom bar under 720px. Content is capped **and centred**
in the space beside the rail:

```css
.shell { display: grid; grid-template-columns: 220px 1fr; }
.main  { display: grid; justify-content: center; }   /* the centring, not just the cap */
.main > * { width: min(1120px, 100%); }
```

Checked at 1920px, 1440px and 400px. No stranded background on the right, ever.
Where a view has room to spare it gets a real right-rail module — never just a
wider cap.

## `Epok.Sync` — opt-in sync (js/sync.js)

Off unless configured. Config lives in its own key `epok.sync.v1` (url, token, salt,
change bookkeeping) — never in state, never in an export. The passphrase is never stored.

```js
Epok.Sync.available()            -> bool            // needs WebCrypto
Epok.Sync.setup({ url, token, passphrase }) -> Promise<{ pulled, pushed, conflicts, raced }>
Epok.Sync.unlock(passphrase)     -> Promise<summary> // once per session; verified against a stored check
Epok.Sync.syncNow()              -> Promise<summary> // rejects with { kind: network|auth|reset|mass-delete|locked|off|… }
Epok.Sync.setEnabled(bool)       -> void             // edits are still tracked while paused
Epok.Sync.deleteRemote()         -> Promise<rows>    // removes the uploaded copy, forgets config here
Epok.Sync.forget()               -> void             // this device only
Epok.Sync.status()               -> { configured, enabled, unlocked, url, lastSync, lastError, conflicts, pending, syncing }
```

Wire: `POST {url}/v2/pipeline`, `Authorization: Bearer <token>`, Hrana-over-HTTP `execute` requests.
Table `epok_records(id, kind, hash, payload, updated_at, deleted)` and `epok_meta(k, v)`.
Records: one per logged day (`day:YYYY-MM-DD`) and one per list (`blob:cycles|events|profile|customTags|predictions|rejected`).
`id` and `hash` are HMAC-SHA-256 under a key derived from the passphrase; `payload` is AES-GCM of `{ k, v }`.
**Unverified against a real Turso endpoint** — see README § Optional sync.

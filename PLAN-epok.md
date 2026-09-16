# epok — plan

Written 2026-09-16, against an empty `epok/` folder.

Method: the shape was established by a ten-round structured interview (every
decision below was chosen explicitly, none inferred), plus a read of the
existing codebase for reusable parts — `Helth/js/core.js` date helpers,
`Helth/js/storage.js` schema pattern, `Themes/*.txt` palettes, and
`Boli laga bc/deploy/` for the publish arrangement. Tooling was verified by
running it: Playwright (Python) imports, Node is v26.8.2.

**Nothing below is implemented — this is the plan.**

---

## What it is

A client-side menstrual tracker with Clue's functional coverage, a Bayesian
prediction engine that states its own measured error, and a Swiss/terminal
brutalist interface. Vanilla HTML/CSS/JS, no build step, opens from `file://`.

**The one thing it must never get wrong: lose or misdate a logged day.** Months
of someone's health history live in `localStorage`, the schema will change, and
a 1am log has to land on the right date. The guard is built before any feature —
see B1.

---

## Part A — constraints and risks, ranked

There is no existing code to audit, so this section ranks the things most likely
to break the app, each with the guard that answers it.

### A1 · DESIGN RISK (high): a schema change silently deletes real history

`localStorage` holds every logged day. A change to a key shape, a date-key
derivation, or a tag id destroys data with no error and no undo. `Helth` already
demonstrates the failure class, and `Boli laga bc`'s
`filterValidAddedCourses()` is the same bug in another domain: courses whose
section key changed were dropped without a word.

**Guard:** `SCHEMA_VERSION` is an integer in the stored object, every bump ships
its migration in the same change, and `Epok.Store.save()` writes the previous
serialized state to `epok.state.prev` before overwriting. A migration that
throws restores from `prev` and shows a persistent banner rather than proceeding.
Smallest correct fix because it costs one extra `setItem` per save and turns
every schema mistake into a recoverable one.

### A2 · DESIGN RISK (high): a misdated period start shifts every prediction

Period start is the only date the model consumes. A log at 00:20 landing on the
wrong calendar day is a one-day error — the same magnitude as the model's entire
typical error.

**Guard:** every date key in the app derives from one function,
`Epok.ymd(date)`, which applies the configurable day boundary (default 04:00,
settable 0–6). Lifted from `Helth/js/core.js` rather than rewritten. Plus the
persistent "you are logging <date>, not today" banner whenever `viewDate()`
differs from `today()`.

### A3 · BUG CLASS (high): a forgotten PIN is unrecoverable data loss

Encryption is opt-in. AES-GCM with a PBKDF2-derived key means a forgotten PIN
destroys the entire history, permanently, with the app working exactly as
designed.

**Guard:** enabling the PIN downloads an encrypted backup file first — not
optional, not a suggestion, the setup does not complete without it — and the
setup screen states in plain words that nobody can recover a forgotten PIN.

### A4 · MODEL GAP (high): a confident prediction that is wrong

A Bayesian posterior over cycle length is confidently wrong for roughly six
cycles after a genuine regime change (stress, illness, PCOS onset,
perimenopause), because the old cycles keep dragging the fit.

**Guard:** change-point detection. If the last 3 cycles differ from the prior
regime beyond a threshold, the superseded regime is dropped from the fit and the
prediction card says so. Scored against the `regime-shift` synthetic cohort —
if the detector doesn't fire there, it doesn't ship.

### A5 · DESIGN RISK (medium): spurious correlations presented as findings

30 tags × cycle phases at p<0.05 yields roughly 1.5 false findings per user by
chance alone. An app that tells a stranger their headaches correlate with
ovulation, wrongly, is the exact failure the through-line exists to prevent.

**Guard:** correlations surface only past ≥3 cycles of data for that tag AND a
multiple-comparison-corrected threshold, and render as raw counts — "cramps on 8
of your last 9 period days (9 cycles)" — never a p-value, never the word
"correlated".

### A6 · DESIGN RISK (medium): fertility estimate read as contraception

Calendar-method fertility estimation has a documented real-world failure rate
around 23%. A shaded "fertile window" reads as certainty.

**Guard:** no hard window. Per-day probability bands from the same posterior,
and the words "this is an estimate, not contraception" inside the fertility card
itself, not in a footer. The card never claims a fertile window has *closed*,
even when ovulation is confirmed — that specific claim is the one people act on.

### A7 · INCONSISTENCY (medium): a 1920px layout with a stranded right edge

A fixed left rail with a `max-width` cap and no centring leaves a canyon of
background on the right. This exact bug shipped in Study Tracker
(`main.main{max-width:1120px}`, 564px of dead space at 1920px).

**Guard:** content is capped **and** centred in the space beside the rail, and
every view is checked at 1920px, 1440px and 400px. Where a view has room to
spare, it gets a real right-rail module, not a wider cap.

### A8 · MODEL GAP (medium): Clue's CSV export format is unverified

There is no sample export anywhere on disk and the format cannot be confirmed
offline. Guessing at column names and calling the importer done would be exactly
the "described, not run" failure.

**Guard:** the importer is tolerant by construction — it reads the header row,
shows the detected column mapping on screen, and lets the user correct it before
anything is written. It stays labelled **unverified** in the README until a real
Clue export has been run through it.

### A9 · NOISE (low): 8 palettes × 2 themes is 16 contrast surfaces

All 20 files in `Themes/` are pure-black dark palettes (`isDark true`,
`background 000000`). The light twins are derived, not designed, and derivation
is where contrast quietly fails.

**Guard:** a contrast check in `tools/verify.py` that asserts AA (4.5:1 body,
3:1 large) for every text-on-surface pairing in all 8 palettes, both modes.

---

## Part B — the build

Four milestones. Each is independently usable — you can stop after any one and
have a finished app.

### M1 — the tracker and the engine

1. **B1 · Foundation.** `index.html` shell, `Epok` namespace, router, date
   helpers with the configurable boundary, `localStorage` at `epok.state.v1`
   with `SCHEMA_VERSION` and the `prev` write-through, the not-today banner,
   toast and undo. Both themes, 8 palettes, brutalist type scale.
2. **B2 · Skeleton runs empty.** Four views registered and navigable, empty
   states, one fake row, storage read/write proven, theme switch proven.
   *Nothing else starts until this runs with zero console errors.*
3. **B3 · Logging.** One-tap flow chips on Today; any calendar day loggable;
   editing a recorded period start states the consequence inline before it
   commits, with undo.
4. **B4 · The model.** Bayesian posterior with population prior (29.3d, sd 5.0)
   shrinking as real cycles accumulate; change-point detection; per-day
   probability curve.
5. **B5 · The proof.** Synthetic cohort generator (regular 28±2, PCOS-irregular
   24–45, regime-shift 28→34 at cycle 8, perimenopausal lengthening with skips)
   plus leave-one-out backtest. Median absolute error per cohort printed by
   `node tools/score.js` and quoted in the README.
6. **B6 · Prediction card.** Window, mode, sample size and measured error, all
   in the same card. Refuses to predict below 3 cycles and says why.
7. **B7 · Encryption.** Optional 6-digit PIN, AES-GCM + PBKDF2, lock on open
   only, forced encrypted backup at setup.
8. **B8 · Portability.** JSON backup (encrypted if the PIN is on) and plaintext
   CSV, with the tradeoff stated at the button.

### M2 — tags, insights, import

9. **B9 · Tag vocabulary.** ~30 tags across 9 categories, Clue's domains with
   this app's wording. User-extensible; hiding is a display setting and never a
   delete.
10. **B10 · Tag logging.** Full grid one level below Today, inline, not a modal.
    Every tap writes immediately; no save button.
11. **B11 · Insights.** Cycle length history and trend, period length,
    variability, regularity, the model's own measured error, symptom heatmap by
    cycle day.
12. **B12 · Gated correlations.** Raw counts past the threshold, nothing before.
13. **B13 · Clue import.** Tolerant CSV parser with a visible, correctable
    column mapping. Manual "add a past cycle" form alongside.

### M3 — reminders, contraception, phone

14. **B14 · Secure-context handling.** Feature-detect; on `file://` an inline
    banner explains that reminders need `./serve.sh` and shows the command.
    Nothing silently missing.
15. **B15 · Service worker + manifest.** Offline cache, installable, icons.
16. **B16 · Reminders.** Predicted start, PMS window, daily pill check, quiet
    hours. Suggested as ticked checkboxes with their reasoning attached, never
    switched on silently.
17. **B17 · Contraception.** 21+7, 24+4, continuous, POP (3-hour window, its own
    sharper reminder), patch weekly, ring monthly, injection 12-weekly,
    IUD/implant as an expiry date only. All rules in one data table.
    **No missed-dose medical guidance** — the app reports what was logged and
    when, and nothing more.
18. **B18 · Deploy.** `epok/deploy/` as a separate gitignored repo holding a
    byte-identical copy, pushed to Cloudflare Pages — the `Boli laga bc/deploy`
    arrangement. What becomes public is the code; the log never leaves the
    browser.

### M4 — symptothermal and the doctor report

19. **B19 · BBT and LH input.** Temperature entry with a chart, LH result
    logging, the detected shift marked.
20. **B20 · Luteal prediction.** A confirmed ovulation (3-over-6 temperature
    rule or positive LH) switches the engine to luteal mode for that cycle:
    next start = ovulation + the user's own measured luteal length, with its own
    posterior. The card names the mode — "luteal (ovulation confirmed Sep 12),
    ±1 day from 7 cycles" versus "cycle-length, ±3 days from 9 cycles". Scored
    against the cohorts the same way B5 is.
21. **B21 · Doctor report.** One page, print stylesheet, no PDF library. Last 12
    cycles as a table, summary stats with variability, top symptoms by frequency
    and the phase they cluster in, ovulation dates where logged. Header states
    the date range and "self-reported".

---

## Out of scope

Deliberately excluded, so the plan stays finishable:

- **Any sync or multi-device.** One device, one browser. No accounts, no backend.
- **Apple Health and Flo import.** Clue only. Three parsers for formats that
  cannot be tested without sample files is a week spent on guesses.
- **Pregnancy and postpartum modes.** A different app with different maths.
- **A partner or shared view.** Audience is a single user.
- **Charts beyond the calendar heatmap and the cycle-length trend.**
- **Full Sensiplan symptothermal rules including cervical fluid.** The
  double-check protocol with the single-digit failure rate is something people
  take courses in; a misimplemented rule is the most dangerous thing this app
  could contain. B20 uses temperature and LH for *prediction*, never to assert
  contraceptive safety.
- **Missed-dose medical guidance.** See B17.
- **A framework, a bundler, or any npm dependency in the app.** Node is used
  only by `tools/`.

---

## Parallel windows

Three windows work this plan at once, in the same folder, with no git branching.

### Leases

A window never edits a file it does not own. If it needs a change in someone
else's file, it appends the request to `STATUS.md` and the owner makes it.

| Window | Model | Owns |
|---|---|---|
| **A · foundation** | Opus 5 | `index.html`, `js/core.js`, `js/storage.js`, `js/crypto.js`, `js/reminders.js`, `js/contraception.data.js`, `css/brutal.css`, `css/themes.css`, `service-worker.js`, `manifest.webmanifest`, `serve.sh`, `tools/verify.py`, `icons/` |
| **B · engine** | Opus 5 | `js/model.js`, `js/backtest.js`, `tools/cohorts.js`, `tools/score.js` |
| **C · views** | Sonnet 5 | `js/views/*.js`, `js/tags.data.js`, `js/import-clue.js`, `css/views.css`, `css/print.css` |

Shared, append-only, never rewritten: `STATUS.md`.
Frozen after Gate 1, changed only by agreement recorded in `STATUS.md`:
`CONTRACTS.md`.

**Why this split.** A owns everything that can destroy data; B owns the only
genuinely hard problem and touches no DOM at all, so it is independent from hour
one; C is mechanical once the contracts are frozen, which is why it runs on
Sonnet 5 rather than Opus.

### Order of work

```
A: B1 ──► B2 (skeleton) ──► B3 ──► B7 ──► B8 ──► B14 ─► B15 ─► B16 ─► B17 ─► B18
B: B4 ──► B5 ──────────────► B6* ──────────────────────────────────► B20
C:        (waits for B2) ──► B9 ─► B10 ─► B11 ─► B12 ─► B13 ──────► B19 ─► B21
```

`B6*` is the prediction card's *data contract* from B; the card's markup is C's,
built against `Epok.Model.predict()`'s documented return shape. B can build and
score the entire engine before any view exists — `node tools/score.js` needs no
browser.

Only C blocks on anything, and only once: the skeleton (B2).

### Protocol

1. Read `PLAN-epok.md` and `CONTRACTS.md` in full before touching a file.
2. Work one numbered item at a time, in your window's order above.
3. Run it before claiming it. Browser work: `tools/verify.py`. Engine work:
   `node tools/score.js`. Quote the numbers.
4. Append one line to `STATUS.md` per finished item:
   `2026-09-16 14:20 · B · B4 done · MAE regular 0.9d, pcos 3.1d, shift 1.4d, peri 4.8d`
5. Need something from another window's file? Append a `NEEDS:` line to
   `STATUS.md` and keep working on something else. Never edit it yourself.
6. Contract change? Append a `CONTRACT:` line proposing it and stop that thread
   until the owning window acknowledges in `STATUS.md`.
7. Do not commit or push. Talon commits at milestone boundaries.

### Boot prompts

Paste one of these as the first message in a fresh window opened in
`/home/talon/Claude/epok`.

**Window B — set the model to Opus 5:**

> You are Window B (engine) on the epok project. Read `PLAN-epok.md`,
> `CONTRACTS.md` and `STATUS.md` in full before doing anything. You own exactly
> these files and may not edit any other: `js/model.js`, `js/backtest.js`,
> `tools/cohorts.js`, `tools/score.js`. Work items B4, B5 then B20 in order.
> Your deliverable is a Bayesian cycle-length model with change-point detection
> and luteal-mode prediction, implementing the `Epok.Model` interface in
> `CONTRACTS.md` exactly — signatures and return shapes are frozen. Prove it with
> `node tools/score.js` against all four synthetic cohorts and quote the median
> absolute error per cohort; a described result is a guess. Append one line to
> `STATUS.md` per finished item. Do not commit.

**Window C — set the model to Sonnet 5:**

> You are Window C (views) on the epok project. Read `PLAN-epok.md`,
> `CONTRACTS.md` and `STATUS.md` in full before doing anything. You own exactly
> these files and may not edit any other: `js/views/*.js`, `js/tags.data.js`,
> `js/import-clue.js`, `css/views.css`, `css/print.css`. Wait until `STATUS.md`
> records `B2 done` before you start; then work B9 through B13, then B19 and
> B21. Build against the frozen `Epok.*` interfaces in `CONTRACTS.md` — never
> guess a signature, and never edit a file you don't own (append a `NEEDS:` line
> to `STATUS.md` instead). The visual direction is Swiss/terminal brutalist:
> mono throughout, extreme type-scale contrast, 1px hairlines, zero border
> radius, zero shadow, uppercase micro-labels with letter-spacing. Check every
> view at 1920px, 1440px and 400px, in both themes and all 8 palettes — content
> is capped **and centred** beside the rail, never left stranded. Append one
> line to `STATUS.md` per finished item. Do not commit.

This window continues as **Window A**.

---

## Verification

Gate 2: nothing is reported working until it has been run and the output quoted.

Standing checklist, every change:

- [ ] Page loads with zero console errors — fresh profile and seeded profile
- [ ] Seed `localStorage` with the previous schema and reload; data survives
- [ ] Both themes, all 8 palettes
- [ ] 1920px, 1440px, 400px — no stranded background, no horizontal scroll
- [ ] Empty state, one-cycle state, and a 24-cycle realistic-volume state
- [ ] No `alert()` or `confirm()` on any path
- [ ] Every estimated number renders with its window and its sample size
- [ ] Backup round-trips; CSV still parses; encrypted backup decrypts
- [ ] `node tools/score.js` — MAE per cohort has not regressed

---

## Reused, not rebuilt

| Need | Source |
|---|---|
| Local-date keys, configurable day boundary, backfill banner | `Helth/js/core.js` (`today`, `ymd`, `shiftDay`, `daysBetween`, `viewDate`, `updateBackfillBar`) |
| Storage namespace + schema version + migration | `Helth/js/storage.js` |
| Router / view registration | `Helth/js/core.js` |
| Toasts, undo, focus overlay | `Helth/js/core.js` |
| Notification permission + reminder scheduler, quiet hours | `Helth/js/core.js` |
| Offline PWA (`service-worker.js` + manifest + icons) | `Helth/` |
| Theme tokens, light + dark | `Helth/css/themes.css`, palettes from `Themes/` |
| Backup / restore / CSV export | `Helth/` settings view (pattern) |
| Heatmap, sparklines | `Helth/js/insights.js` |
| Deploy as a byte-identical gitignored copy | `Boli laga bc/deploy/` |
| Playwright verification harness | `.claude/agents/code-reviewer.md` |

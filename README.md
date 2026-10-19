# epok

A client-side menstrual tracker with a Bayesian prediction engine that states
its own measured error, and a Swiss/terminal brutalist interface. Vanilla
HTML/CSS/JS, no build step, no backend, no accounts. It opens straight from
`file://` and stays fully usable that way — logging, prediction, encryption,
export — everything except push reminders, which need a real origin (see
Setup). Your log lives in this browser's `localStorage` and leaves it only if
you export it yourself or switch on **opt-in, end-to-end-encrypted sync** to a
database you own (off by default — see *Optional sync*).

**The one thing it must never get wrong: lose or misdate a logged day.**
Months of history live in `localStorage`, the schema will change over time,
and a log entered at 1am has to land on the right calendar date. Every date
key in the app derives from one function (`Epok.ymd()`), every schema bump
ships its migration in the same change, and a failed migration falls back to
the previous save with a banner rather than failing silently. See
`PLAN-epok.md § Part A` for the full list of risks this was built against.

## Setup

Open `index.html` directly — double-click it, or drag it into a browser.
Logging, the prediction engine, the calendar, encryption, backup/restore and
CSV export all work from `file://` with nothing else running.

Reminders and the installable offline app need an actual HTTP origin, because
`file://` cannot hold notification permission or register a service worker
(Chromium reports `file://` as secure, but blocks both anyway — measured, not
assumed, see `js/reminders.js`):

```sh
./serve.sh                    # epok → http://localhost:8731
```

To check the build:

```sh
python3 tools/verify.py           # full harness — boot, migration, dates,
                                   # period starts, lock, portability, offline,
                                   # reminders, navigation, dialogs, contrast,
                                   # layout, shell, custom tags
python3 tools/verify.py layout    # or just one section
node tools/score.js               # the prediction engine's own proof — see below
```

## Features

| View | What's there |
|---|---|
| **Today** | One-tap flow chips, period-start action (states the predicted-date change before it commits), the prediction card (paused with its reason during pregnancy, postpartum or an ovulation-suppressing method; marked EXPIRED once its window has passed), BBT/LH quick entry with time and a "disturbed" flag, the full tag grid with your own 1–3 severity, effect-on-day, a check-in chip, and one-tap events |
| **Calendar** | **Month** or **3 months** (previous, current, next side by side; the page widens for it). Period days shaded by flow, fertile days and ovulation for every cycle, the predicted window as a dashed outline. Arrow keys move the selected day, PageUp/PageDown change month, `T` today, `1`/`3` the view, `L` logs the day, `?` lists them; a date box jumps anywhere; flow and check-in can be logged from the detail panel without leaving |
| **Timeline** | Every cycle with where its start came from, length, bleeding, what was charted, and flags (long, short, inside a span). Move a start, leave a cycle out of the fit, add a missed start, or remove one — each states its consequence first and can be undone |
| **Insights** | Overview, **forecast history** (each forecast epok actually showed, with the date it was made, why it changed, and the real start once it arrives), cycle-length trend, temperature chart, symptom heatmap, gated pattern detection with your own severity ratings |
| **Settings** | Profile (all skippable), contraception method and its reminder rules, **events** (pregnancy, postpartum, breastfeeding, past methods, medication), PIN encryption, per-reminder checkboxes, palette/mode/day-boundary, tag hiding and custom tags, JSON/CSV export and import, Clue CSV import, **optional sync** |
| **Report** | One printable page for a clinician, over a range you pick (3 / 6 / 12 months, everything, or two dates): summary, how complete the log is, cycles, prolonged-bleeding episodes, events, symptoms with self-rated severity and the basis for each phase — headed "self-reported" |

Underneath: AES-GCM encryption with a forced backup before it turns on,
offline install via a service worker, and a contraception rules table (21+7,
24+4, continuous, POP, patch, ring, injection, IUD/implant) that gives no
missed-dose guidance — see the engine section below for the model itself.

<!-- BEGIN engine · Window B -->
## The prediction engine

`js/model.js` predicts the next period start from logged period starts and, when
you chart them, basal body temperature and LH tests. `js/backtest.js` scores that
prediction against your own history. Both are pure functions — no DOM, no
storage — and run unchanged in the browser and under Node.

### Run the proof

```sh
node tools/score.js               # 60 seeds per cohort, about 1.5 s
node tools/score.js --seeds 300   # the run the numbers below come from
node tools/score.js --verbose     # adds per-cycle rows for one seed
```

It exits non-zero if any cohort's error, the change-point detector, or any of the
contract-shape assertions has regressed past its recorded bar.

### What it prints

| Output | What it means |
|---|---|
| `CYCLE-LEN` | Error when the model sees period starts only |
| `LUTEAL` | Error when the BBT/LH chart is supplied, luteal phase generated at sd 1.3 days |
| `LUT.STRESS` | The same, at luteal sd 2.5 — a person whose luteal phase is *not* stable |
| `APP-SHAPED` | The `LUTEAL` charts with `cycle.ovulation` left empty, as the app stores it — past ovulation has to be *detected*. This is the column that says what a real log gets |
| `window calibration` | How often the true start landed inside the printed 80% window, its width, signed bias, 90th-percentile error, and a recent-median baseline |
| `live mode chosen` | Which mode the model picks on a full 20-cycle chart |
| `change-point detector` | Detection rate, what it saves, and how often it fires wrongly |
| `contract surface` | Refusal path, curve mass, window bracketing, ovulation and fertility shapes |

### Measured error

`node tools/score.js --seeds 300`, re-run 2026-10-03 after the fixes in `REVIEW-algorithm-2026-10-03.md`. Each run is 20 synthetic cycles
scored leave-one-out, giving 16 predictions per run. Median absolute error in
days, with the mean in brackets:

| Cohort | Period starts only | With chart | With chart, unstable luteal | App-shaped (mean only) |
|---|---|---|---|---|
| regular (28 ± 2) | 1.50 (1.68) | 1.00 (1.17) | 1.50 (1.78) | 1.17 |
| pcos (bimodal, 24–45) | 5.00 (5.29) | 1.00 (2.34) | 2.00 (3.10) | 2.34 |
| regime-shift (28 → 34 at cycle 8) | 2.00 (2.38) | 1.00 (1.17) | 2.00 (2.15) | 1.17 |
| perimenopause (28 → 40, ~15% skipped) | 5.00 (8.22) | 1.00 (4.69) | 2.00 (5.58) | 4.69 |

**The app-shaped column was wrong for three weeks and nobody could see it.** The
generator hands the model each past cycle's true ovulation date; the app never
does — chart entries do not write `cycle.ovulation`. Run with the field empty,
luteal mode activated in 0 of 1,200 charted histories and the error was the
period-starts-only figure (PCOS 5.29, perimenopause 8.21 against 2.34 and 4.69).
Past ovulation is now derived from each closed cycle's own BBT/LH, and the
app-shaped column matches `LUTEAL`. That equality is the fix being measured, and
it also says how much of `LUTEAL` is the engine's detection and how much the
generator's: none, once detection works.

**These are synthetic cohorts, and the generator was written by the same window
as the model.** They show the engine uses the structure it is given and loses
accuracy honestly when that structure is removed. They do not show the error
holds on a real body. The app never quotes these figures to a user — the
prediction card shows `Prediction.mae`, the median error of the model on *that
user's own* logged history, which is null until five cycles exist.

**Perimenopause without a chart is poor, and stays poor.** A mean error of 8.21
days is what skipped cycles do: an anovulatory cycle nearly doubles the length,
and nothing in the period-start history says one is coming.

### The things most cycle predictors get wrong

**A prediction without its error is a guess wearing a date.** Every prediction
carries an 80% central window, the number of cycles it used, and its measured
median error. 80% is chosen over 95% on purpose: on the PCOS cohort the 80% window is
already 15.3 days wide on average, and the 95% window is 23.1 — over three weeks
covering most of a cycle, which tells nobody anything.

**Below three complete cycles, the model refuses.** With one or two cycles it
would be repeating the population average back to you and dressing it as a
personal prediction. `refused: true` and `nextStart: null`, with a sentence
naming the floor.

**Old cycles fade, and a real change gets dropped.** Observations are weighted
with a half-life of 6 cycles. Separately, if the last 3 cycles differ from
everything before by both 2.5 standard errors and a flat 3 days, the older block
is dropped and the card names the date the new pattern started. On the
regime-shift cohort this fires on 86% of runs three cycles after the shift — the
first point at which three post-shift cycles exist — and cuts mean error over
the next six cycles from 4.20 to 3.48 days. False fires: 0.4% of 3,900 checks on
the regular cohort.

**A boundary stays where it was set.** The first detector re-ran its test on the
whole record every time, so the boundary slid forward one cycle per new
observation, and once the record was twice the window it stopped firing and every
dropped cycle came back: eight 28-day cycles then 34-day ones fit 34 days at 15
cycles and 32 at 16, on another identical 34. The detector now replays the record
in order, and a boundary survives only if the cycles after it still differ from
the ones before — held to 1.0 extra standard error once more than three cycles sit
behind it. **That stability has a price, measured:** detection three cycles after
a shift fell from 93% to 86%, and PCOS false fires rose from 2.3% to 5.3% of 3,900
checks, because a noisy run that survives validation now stays in force instead of
vanishing on the next call. The PCOS bar was moved from 3.5% to 6% to match; the
old figure was low because the detector forgot.

**Irregular is not the same as changed.** If you have declared PCOS or
perimenopause, the detector needs 3.5 standard errors instead of 2.5, because
irregularity is expected. Measured over 300 seeds on the stateless detector, that cut false fires on the
PCOS cohort from 9.1% of 3,900 checks to 2.3%, with mean error 5.29 → 5.25 days (5.3% on the replaying detector, above). Telling someone with PCOS
that their cycles "changed" when they are simply irregular is a false finding.

**One measurement is not certainty.** The first version put a floor under the
spread, which let a single measured luteal length claim ±1 day. Spread is now
pooled toward a typical within-person figure — 3.0 days for cycle length, 2.0
for the luteal phase — worth two cycles of evidence. A short record reads as
honestly vague; a long one is barely moved.

**A confirmed ovulation does not automatically win.** The luteal phase is usually
the stable half of the cycle, so ovulation plus your own luteal length is often
the sharper prediction. But not always: on the regular cohort with a luteal phase
that varies (sd 2.5), picking whichever spread was narrower chose luteal mode on
49% of predictions and was 0.54 days worse each time it did. Luteal mode now has to produce a predictive spread at least 15%
narrower than the cycle-length fit, and ties go to cycle length because every
cycle contributes a length while only charted cycles contribute a luteal
measurement. That cut luteal choices from 49% to 27% and the cohort's mean error
from 1.94 to 1.82 days (those two figures predate the as-of fix and were not
re-measured). **It is still worse than ignoring the chart** — `LUT.STRESS` is
1.78 against 1.68 for period starts only. The margin narrows the loss, it does not
remove it, because the model cannot always tell a stable luteal phase from a lucky
run of one.

**Fertility is a set of per-day bands, never a window, and never "closed".**
Uncertainty about the ovulation day is spread across a day-relative conception
profile, so an uncertain estimate produces flatter bands rather than a confident
wrong one. The card's own text says it is not contraception and that a low band
is not a zero. `tools/score.js` fails the build if the fertility text ever
contains "closed", "over", "safe" or "no longer fertile".

### Ovulation detection

| Rule | Fires when | Ovulation placed on |
|---|---|---|
| LH positive | First positive test in the cycle | The day after the positive |
| BBT 3-over-6 | Three consecutive readings above the highest of the previous six, the third at least 0.2 °C above | The day before the first high reading |
| Both | Both rules fire **within 3 days of each other** | The LH-derived day, source `both` — the only combined result called *confirmed* |
| Conflict | Both fire, more than 3 days apart | No date. Both are reported (`lh`, `bbt`), neither is used, and the card says the signals disagree |

The BBT rule needs at least four readings in the six-day baseline and returns
`null` rather than guessing when the chart is sparse. The 0.2 °C threshold is
compared in integer hundredths: 36.6 → 36.8 is `0.19999999999999574` in floating
point and used to be missed, while 36.5 → 36.7 was caught.

**One signal is "detected", not "confirmed".** A single LH strip or a single
temperature shift spreads the ovulation date across neighbouring days (±1 for LH,
±2 for temperature; weights are unsourced and wide on purpose) and the calendar
draws it as an estimate. ASRM describes urinary LH as indirect evidence that can
be falsely positive, and a temperature rise only shows ovulation after the fact. **Neither rule is used to
say contraception is safe.** Detection feeds prediction only; full
symptothermal rules with cervical fluid are out of scope (PLAN-epok.md).

### What a forecast is allowed to see

**A forecast reads only what was logged by its own date.** `predict` takes
`opts.asOf`; the backtest sets it to the day before each period arrived. Before,
an LH result dated inside the *next* cycle changed an earlier forecast from 25 Apr
to 18 May and its recorded error from 1 day to 24, so the headline "±N days
measured error" could depend on data from after the outcome. The same bound
replaced the fixed 45-day scan of the open cycle, which both missed a late surge
in a long cycle and let that leak.

**An expired forecast says so.** When `asOf` is past the window's end and no
period is logged, `expired` is true, the card is headed EXPIRED FORECAST, the
calendar stops drawing the window, and reminders skip it. The model does not
re-condition the curve on "no bleeding yet" — an empty log does not prove none.

**An ovulation-suppressing method pauses the natural-cycle forecast.** Combined
pill, patch, ring, injection, implant and continuous pill: bleeding on them is a
scheduled or withdrawal bleed, so `predict` refuses (`paused: "contraception"`)
and `fertility` returns no bands, with the reason on screen. Not paused: the
progestogen-only pill (suppression is inconsistent) and IUDs (the method table
does not yet separate hormonal from copper). **Known gap:** the table keeps only
the current method, so cycles logged while on a method are counted again once it is
set to NONE.

### Window calibration

`node tools/score.js --seeds 300`, app-shaped runs, nominal 80% window:

| Cohort | Starts inside the window | Mean width | Signed bias | 90th-pct abs error | Recent-median baseline (mean abs) |
|---|---|---|---|---|---|
| regular | 87.7% | 3.6 d | −0.01 d | 2 d | 1.78 |
| pcos | 83.0% | 6.5 d | −1.34 d | 7 d | 5.66 |
| regime-shift | 87.9% | 3.6 d | −0.09 d | 2 d | 2.52 |
| perimenopause | 78.3% | 6.3 d | −3.56 d | 20 d | 8.38 |

These are measured, not gated, and they are for charted histories — the windows
are narrower than the 5.7 / 13.9 / 7.2 / 22.0 days a period-starts-only forecast
gets. **The window is not uniformly 80%:** perimenopause lands 78.3% inside with a
20-day 90th-percentile miss, and the negative bias there means starts arrive later
than forecast — skipped cycles, which nothing in a period-start history announces.

### Assumed vs solid

| Solid — measured, rule-defined or sourced | Assumed — a knob in `js/model.js` |
|---|---|
| Rolling-origin error on every cohort, 300 seeds (read only data logged before each forecast) | Population prior sd 5.0 days — the mean is sourced, the sd is not confirmed |
| Change-point detection rate and false-fire rate | PCOS prior, 36.5 ± 9.0 days — **no source** |
| Luteal mode's gain, and its loss when the luteal phase is unstable | Perimenopause prior, 33.0 ± 11.0 days — **no source** |
| Node and browser give byte-identical output (Playwright, `file://`) | Luteal prior, 13.5 ± 2.0 days — between two sources, matches neither |
| The 3-over-6 and LH-positive rules as written | Within-person spread: cycle 3.0 d, luteal 2.0 d — **no source** |
| Population mean cycle length, 29.3 days [1] | Recency half-life 6 cycles; window mass 80%; luteal margin 15% |
| | Every synthetic cohort's shape |

**Two of the priors are unsourced, and they are kept anyway.** A literature
search found no study giving a single mean and sd for cycle length in PCOS or in
perimenopause, and it shouldn't have been expected to. PCOS is defined by
oligomenorrhoea — cycles over 35 days [4] — with observed lengths running from
35 to 90+ days. The menopausal transition is a *drift*, not a distribution:
early transition is a persistent ≥7-day difference between consecutive cycles,
late transition is ≥60 days without a period [5]. So 36.5 and 33.0 are
engineering choices, not findings. The part that matters is the width: sd 9.0
and 11.0 are deliberately wide, so the prior concedes ignorance and a person's
own cycles outweigh it within a few logs. Replacing them with other unsourced
numbers would change nothing about their honesty.

`opts.ageBand` is accepted and deliberately does not move the prior: there is no
defensible number by age band that a declared condition doesn't already express
better.

### Sources

Found by a literature search on 2026-09-16. Where only the abstract was
reachable, the figure is quoted from the abstract, and the note says so.

| # | Source | Used for | What it says | Fit with the model |
|---|---|---|---|---|
| 1 | Bull JR et al. 2019. "Real-world menstrual cycle characteristics of more than 600,000 menstrual cycles." *npj Digital Medicine* 2:83. [doi:10.1038/s41746-019-0152-7](https://doi.org/10.1038/s41746-019-0152-7) | Population prior | Mean cycle 29.3 days; mean luteal phase 12.4 days; 612,613 cycles from 124,648 app users | Mean matches exactly. The sd of 5.0 could **not** be confirmed from what was reachable — treat it as assumed |
| 2 | Lenton EA et al. 1984. "Normal variation in the length of the luteal phase of the menstrual cycle." *BJOG* 91(7). [link](https://obgyn.onlinelibrary.wiley.com/doi/abs/10.1111/j.1471-0528.1984.tb04831.x) | Luteal prior | Luteal phase 14.13 ± 1.41 days, 327 ovulatory cycles | The prior's 13.5 sits between this and [1]'s 12.4; its sd of 2.0 is wider than this on purpose, because app-logged ovulation dates are noisier than a clinic's |
| 3 | Fehring RJ et al. 2006. "Variability in the phases of the menstrual cycle." *JOGNN* 35(3). [link](https://www.jognn.org/article/S0884-2175(15)34376-8/abstract) | Within-person spread (context only) | Mean cycle 28.9 ± 3.4 days across 1,060 cycles from 141 women; 42.5% of women had cycles varying by more than 7 days | 3.4 is a spread **across** people, not within one person. It does not source the model's 3.0 |
| 4 | Apple Women's Health Study 2025. "Variability of menstrual cycles by age, polycystic ovary syndrome, and early-life cycle irregularity." *AJOG*. [link](https://www.ajog.org/article/S0002-9378(25)00867-1/fulltext) | PCOS prior (context only) | Participants with PCOS had longer, more variable cycles; 160,206 cycles from 15,586 participants. No single mean or sd reported | Supports a long, wide prior. Does not source 36.5 ± 9.0 |
| 5 | Harlow SD et al. / ReSTAGE Collaboration 2008. *Fertility and Sterility*. [link](https://www.fertstert.org/article/S0015-0282(06)00929-0/fulltext) | Perimenopause prior (context only) | Early transition: ≥7-day persistent difference between consecutive cycles. Late transition: ≥60 days without a period | Supports a wide prior and the change-point detector. Does not source 33.0 ± 11.0 |
| 6 | Trussell J. Contraceptive failure tables, in *Contraceptive Technology*. | "About 1 in 4" in the fertility card | Typical-use first-year failure for calendar-based fertility-awareness methods is roughly 23–24% | "About 1 in 4" fits. **The edition and exact figure were not confirmed** — check a current edition before this sentence is quoted anywhere as a statistic |

**Not used, on purpose.** The search also turned up a modelling study on TREMIN
data giving mean cycle lengths in the years before the final period. Its figures
could not be traced to a reachable page, so they are not cited here and do not
feed the model.
<!-- END engine · Window B -->

## Optional sync

**Sync is off until you finish a form, and the app never needs it.** `js/sync.js`
keeps an encrypted copy of the log in a [Turso](https://turso.tech) database that
you create and own, so a second device can read it. The local `localStorage`
state stays the source of truth: with sync off, offline, or the database gone,
nothing changes about logging, prediction or export.

**What the database can see, and what it cannot.**

| The database can see | The database cannot see |
|---|---|
| That rows exist, how many, and when each was last written | Any date, flow level, symptom, temperature, note or tag |
| Ciphertext (AES-GCM) and keyed hashes | Which rows are days and which are lists, beyond a `day` / `blob` label |
| Your token's requests | Your passphrase — it never leaves the browser and is not stored |

Every record is encrypted in the browser with a key derived from a passphrase
(PBKDF2, 250,000 iterations, the same floor as the PIN lock). Record ids are keyed
hashes, so the database cannot list your dates. **Lose the passphrase and the
uploaded copy cannot be opened by anyone, including you** — your local log is
unaffected, and setup makes you tick that you understand.

**The token is stored in this browser only.** It is not inside the PIN-sealed
state, not in a JSON backup, and not in the repo; `tools/verify.py` fails if a
JWT-shaped string appears in `js/` or the deploy copy. A token compiled into a
public static site would be a token anyone could read — which is why there is no
config file and the page asks you to paste it.

### The things most sync gets wrong

**A change on one side only is not a conflict.** Each record is merged three
ways against what was last synced, so an edit made on one device simply arrives
on the other. Only a record changed on *both* since the last sync is a conflict;
the newer edit wins and the other version is kept in a list under Settings → Sync,
and `epok.state.prev` holds the local state a pull overwrote.

**A device that has never synced does not get to "change" anything.** The first
version of the join logic let a fresh device's empty cycles list count as a local
edit, stamp it later than the other device's upload, and win — replacing a real
log with nothing. An untouched default now never counts as a change on a
device's first sync. Found by running two browser contexts, not by reading.

**An empty database is not "everything was deleted".** If the database loses its
salt row (reset, recreated, wrong database) the sync stops and changes nothing
locally, and a pull that would delete more than half your logged days (and more
than 10) is refused with the numbers. Both exist because the alternative erases
months of log on the strength of one unreachable server.

**An unreachable database is said plainly.** A failed sync shows a banner with
the age of the last good one and never presents old data as current. Edits keep
being tracked while sync is paused, so resuming does not stamp an old edit as
new and let it beat a newer one made elsewhere.

### Assumed vs solid — sync

| Solid — exercised in `tools/verify.py sync` | Assumed — not verified |
|---|---|
| Join from a second device, wrong passphrase refused before any upload, one-sided edits merge without conflict, a two-sided edit keeps the newer and lists the other | **That a browser can call a real Turso endpoint** (CORS), and that it accepts exactly the `/v2/pipeline` request `js/sync.js` sends. The tests run against `tools/mock_turso.py`, which is **not** Turso |
| The database holds no readable note, tag or date | Last-writer-wins relies on both devices' clocks agreeing to within the gap between two edits |
| Offline, locked-session, reset-database and delete-the-copy behaviour | Cycles, events and profile fields sync as whole lists, so two devices that both edited the same list lose the older edit (listed, not merged) |
| The token is in neither the export nor the state | Turso's free-tier limits and the token's lifetime |

To try it for real: create a database and a token with `turso db create` /
`turso db tokens create`, paste the URL and token into Settings → Sync, and if
the browser reports it could not reach the database, that is the CORS question
above, answered. `PLAN-features-sync.md § C0` is the checklist.

## The interface

**A misdated log is worse than no log, so backdating always shows itself.**
The logging date is a separate concept from today, and it is never persisted
across a reload — waking up tomorrow still silently editing yesterday's log
is exactly the kind of quiet corruption this app is built to refuse. Whenever
it isn't today, a persistent banner names the date and offers one tap back to
"today", and it reappears on every view, not just the one where you set it.

**Editing a period start states the consequence before it happens, not
after.** Tapping "mark period start" shows what it will do to the predicted
next date — before → after — in the same breath as the button that commits
it. Every commit gets an undo, never a confirmation dialog.

**A forgotten PIN is not a support ticket.** Turning on encryption downloads
an encrypted backup first, as part of the same action, not a separate step
you could skip — the setup screen states in plain words that nobody, not the
app and not its author, can recover a forgotten PIN. There is no reset.

**Correlations are gated hard enough to mostly say nothing.** A tag's rate on
period days is compared against its rate elsewhere with a two-proportion
z-test, requiring both 3 cycles of data for that tag and a conservative fixed
critical value (z ≥ 3.5 — stricter than the ~2.94 an exact Bonferroni
correction needs for 30 simultaneous tests, erring on the strict side rather
than computing the exact figure per tag count). What clears it renders as a
raw count — "cramps on 8 of your last 9 period days" — never a p-value, never
the word "correlated". Tested against both a real signal (a tag at ~90% of
period days against a ~5% baseline, over a realistic non-period sample) and
noise (an elevated rate over only 2 non-period samples): the real signal
cleared the gate, the noise correctly did not.

**Fertility bands never claim to be closed.** Per-day probability, not a hard
window, and the card states outright that this is an estimate, not
contraception — calendar-based methods have a documented real-world failure
rate around 1 in 4. `tools/score.js` fails the build if that card's text ever
contains "closed", "over", "safe" or "no longer fertile" (Window B's guard,
enforced on Window C's copy).

**A wide screen doesn't get a stranded canyon of background.** Content is
capped and centred beside the rail — not just capped, which centers only
until the columns are miscomputed and the cap collapses to its own content
(a real bug, found by screenshot and fixed by Window A; see `STATUS.md`
2026-09-16 11:20). Checked at 1920px, 1440px and 400px, across all 4 palettes
and both modes — 120 combinations, zero horizontal overflow.

**The Clue importer admits it's guessing.** There is no sample Clue export on
disk to verify the column mapping against, so the importer says so on every
parse, shows its guessed date/flow columns for correction before anything is
written, and a 5-row preview of exactly what would land. It stays labelled
unverified here and in the UI until a real export has been run through it.

**Nothing gets switched on silently.** Every reminder is a checkbox with its
own reason attached, defaulting off even across a schema migration — the v2
migration explicitly zeroes every per-reminder toggle rather than inheriting
the old single `remindersOn` boolean, because inheriting a reminder nobody
individually chose is the exact failure "suggest, explain, let it be
unticked" exists to prevent.

### Assumed vs solid — interface

| Solid — measured, not described | Assumed — a knob, stated as one |
|---|---|
| Zero console/page errors and zero horizontal overflow across 4 palettes × 2 modes × 3 viewports × 5 views (120 combinations, Playwright) | The correlation gate's z ≥ 3.5 is a fixed constant, not a computed per-n Bonferroni critical value — deliberately stricter than exact, never looser |
| PIN enable → download → reload → lock screen → unlock → disable round-trip, driven by real clicks | Cycle-day phase boundaries in the Report (menstrual/follicular/luteal) are a heuristic off the person's own average cycle length, not a confirmed ovulation |
| A period's length and a cycle's ovulation date are both **derived live** from logged flow/BBT/LH — nothing in the app writes `cycle.end` or `cycle.ovulation` directly, so reading them as stored fields would silently show nothing for every real user | The Clue CSV column-guessing heuristics (regex on header names) are unverified against a real export — see Features |
| `python3 tools/verify.py` — 616 checks, 0 failed outside two `shell` checks that only flag a stale `deploy/public/` copy (expected until `./deploy.sh` is re-run before publishing) | |

## Deployment & privacy

`./deploy.sh` copies the browser-facing files (`index.html`,
`manifest.webmanifest`, `service-worker.js`, `css/`, `js/`, `icons/`) into
`deploy/public`, then verifies every file is byte-identical with the source
and refuses if `PLAN-epok.md`, `CONTRACTS.md`, `STATUS.md`, or anything under
`tools/` ever lands in the copy. `deploy/wrangler.jsonc` targets Cloudflare
Pages as static assets only — no Worker, no password — because the only
thing that becomes public is the code; the log itself never leaves the
browser it was typed into — unless you turn on sync, in which case only ciphertext
leaves it (see *Optional sync*). `deploy/` is not a git repository and nothing here
commits or pushes on its own: `./deploy.sh --push` runs `npx wrangler deploy`
after copying, and a plain `./deploy.sh` just copies and reports.

Run `./deploy.sh` again before publishing if you've changed anything since
the last copy — `tools/verify.py`'s `shell` section checks this and will
name exactly which files are stale.

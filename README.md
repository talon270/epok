# epok

A client-side menstrual tracker with a Bayesian prediction engine that states
its own measured error, and a Swiss/terminal brutalist interface. Vanilla
HTML/CSS/JS, no build step, no backend, no accounts. It opens straight from
`file://` and stays fully usable that way — logging, prediction, encryption,
export — everything except push reminders, which need a real origin (see
Setup). Your log lives in this browser's `localStorage` and never leaves it
unless you export it yourself.

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
| **Today** | One-tap flow chips, period-start action (states the predicted-date change before it commits), the prediction card, BBT/LH quick entry, the full tag grid inline |
| **Calendar** | Month grid: period days shaded by flow, fertile days and ovulation for every cycle (confirmed where BBT/LH says so), the predicted window as a dashed outline. Tapping a day shows it in a detail panel; LOG THIS DAY is what switches the logging date |
| **Insights** | Cycle-length trend, a temperature chart with the detected ovulation shift marked, a symptom-by-cycle-day heatmap, gated pattern detection |
| **Settings** | Profile (all skippable), contraception method and its reminder rules, PIN encryption, per-reminder checkboxes, palette/mode/day-boundary, tag hiding and custom tags, JSON/CSV export and import, Clue CSV import |
| **Report** | One printable page for a clinician: cycle table, summary stats, top symptoms by phase, ovulation dates — headed "self-reported" |

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
| `live mode chosen` | Which mode the model picks on a full 20-cycle chart |
| `change-point detector` | Detection rate, what it saves, and how often it fires wrongly |
| `contract surface` | Refusal path, curve mass, window bracketing, ovulation and fertility shapes |

### Measured error

`node tools/score.js --seeds 300`, run 2026-09-16. Each run is 20 synthetic cycles
scored leave-one-out, giving 16 predictions per run. Median absolute error in
days, with the mean in brackets:

| Cohort | Period starts only | With chart | With chart, unstable luteal |
|---|---|---|---|
| regular (28 ± 2) | 1.50 (1.68) | 1.00 (1.20) | 1.50 (1.82) |
| pcos (bimodal, 24–45) | 5.00 (5.29) | 1.00 (2.44) | 2.25 (3.28) |
| regime-shift (28 → 34 at cycle 8) | 2.00 (2.53) | 1.00 (1.17) | 2.00 (2.23) |
| perimenopause (28 → 40, ~15% skipped) | 5.00 (8.21) | 1.00 (4.73) | 2.00 (5.64) |

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
regime-shift cohort this fires on 93% of runs three cycles after the shift — the
first point at which three post-shift cycles exist — and cuts mean error over
the next six cycles from 4.20 to 3.54 days. False fires: 0.4% of 3,900 checks on
the regular cohort.

**Irregular is not the same as changed.** If you have declared PCOS or
perimenopause, the detector needs 3.5 standard errors instead of 2.5, because
irregularity is expected. Measured over 300 seeds, that cuts false fires on the
PCOS cohort from 9.1% of 3,900 checks to 2.3%, with mean error 5.29 → 5.25 days. Telling someone with PCOS
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
measurement. That cuts luteal choices to 27% and the cohort's mean error from 1.94
to 1.82 days. **It is still worse than ignoring the chart (1.68)** — the margin
narrows the loss, it does not remove it, because the model cannot always tell a
stable luteal phase from a lucky run of one. The `LUT.STRESS` column keeps that
visible.

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
| Both | Both rules fire | The LH-derived day, source `both` |

The BBT rule needs at least four readings in the six-day baseline and returns
`null` rather than guessing when the chart is sparse. **Neither rule is used to
say contraception is safe.** Detection feeds prediction only; full
symptothermal rules with cervical fluid are out of scope (PLAN-epok.md).

### Assumed vs solid

| Solid — measured, rule-defined or sourced | Assumed — a knob in `js/model.js` |
|---|---|
| Leave-one-out error on every cohort, 300 seeds | Population prior sd 5.0 days — the mean is sourced, the sd is not confirmed |
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
browser it was typed into. `deploy/` is not a git repository and nothing here
commits or pushes on its own: `./deploy.sh --push` runs `npx wrangler deploy`
after copying, and a plain `./deploy.sh` just copies and reports.

Run `./deploy.sh` again before publishing if you've changed anything since
the last copy — `tools/verify.py`'s `shell` section checks this and will
name exactly which files are stale.

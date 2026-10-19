# Epok — algorithm review and proposed features

Written 2026-10-03 against `main`, commit `46afe6f`.
Method: source tracing through storage, prediction, backtesting, calendar and insights; the existing 300-seed benchmark; focused Node reproductions; browser checks and real UI clicks using isolated synthetic profiles. Medical interpretation was checked against the primary sources linked below.

**The core is worth keeping, but its inputs and evaluation need fixing before its accuracy claims can be trusted.** The strongest parts are the pure, independently runnable engine, explicit uncertainty, minimum history requirement, and offline architecture. The largest problems are disconnected chart data, scoring that can read future observations, and treating uncertain ovulation evidence as an exact date.

**This is a review. None of the proposed application changes is implemented.** GitNexus tools were unavailable; findings were established from source and execution, without relying on an index. All measurements below use synthetic data, not a clinical validation dataset or the user's health records.

**What the algorithm currently does**

| Stage | Current behavior |
|---|---|
| Build cycles | Calculate lengths from successive period starts. Logging any flow, including spotting, can automatically create a start. |
| Choose a prior | Start at 29.3 days; declared PCOS/perimenopause select wider, differently centered priors. The condition-specific numbers are explicitly unsourced in the README. |
| Fit cycle length | Apply a normal Bayesian update with a six-cycle recency half-life. Pool observed variance toward a fixed spread, then include uncertainty in the mean in the next-cycle distribution. The variance calculation itself is unweighted. |
| Detect a change | Compare the last three lengths with all earlier lengths. If the mean difference clears both thresholds, fit only those three. |
| Use charting | If current ovulation is detected and historical `cycle.ovulation` fields exist, consider ovulation plus fitted luteal length. Select it when its predicted spread is at least 15% smaller. |
| Display uncertainty | Return a most likely date and a contiguous interval containing at least 80% of the modeled probability. |
| Report error | Reconstruct forecasts over successive historical prefixes and report their median absolute error. This is a rolling historical backtest, although the code calls it leave-one-out. |
| Estimate fertility | Shift period forecasts backward by mean luteal length, or use one detected ovulation date; combine this with a fixed daily fertility profile. |

**Verified findings, ranked**

**1. BUG (high): normal chart logging cannot activate the advertised luteal predictor.**

[`lutealStats`](/home/talon/SyncedWork/Claude/epok/js/model.js:329) reads only `cycle.ovulation`. [`blankCycle`](/home/talon/SyncedWork/Claude/epok/js/storage.js:400) initializes this to `null`, and daily BBT/LH edits never populate it. Historical calendar detection calculates dates separately without supplying them to prediction. By contrast, the [synthetic generator](/home/talon/SyncedWork/Claude/epok/tools/cohorts.js:158) preloads past cycles with the generator's true ovulation dates.

**Reproduction:** retain every daily measurement but clear stored ovulation fields to match ordinary app logs. Luteal mode then activates in **0 of 1,200** full charted histories. Over 4,800 scored forecasts per cohort:

| Synthetic cohort | Mean absolute error with prefilled historical ovulation | Mean absolute error with ordinary app-shaped records |
|---|---:|---:|
| Regular | 1.20 days | 1.68 days |
| PCOS | 2.44 days | 5.29 days |
| Regime shift | 1.17 days | 2.53 days |
| Perimenopause | 4.73 days | 8.21 days |

**Smallest correct fix:** derive historical ovulation evidence from each completed cycle's BBT/LH observations before fitting luteal lengths. Share that derivation with calendar/report code and recompute it after edits. Keep synthetic ground truth outside the model's input; test the full storage-to-prediction path. Re-run the benchmark after fixing finding 3 as well.

**2. BUG (high): the ovulation detector overstates agreement and certainty.**

[`detectOvulation`](/home/talon/SyncedWork/Claude/epok/js/model.js:291) chooses the first positive LH test. When a BBT shift also exists, it returns the LH-derived date with `source: "both"` without comparing dates. [`fertility`](/home/talon/SyncedWork/Claude/epok/js/model.js:620) then represents the detected date with probability 1 and labels it confirmed.

**Reproduction:** an LH-derived date of January 10 and a BBT-derived date of January 20 return January 10, source `both`. A single positive LH test also produces `confirmed: true`.

ASRM describes urinary LH as indirect evidence preceding ovulation by roughly 1–2 days, notes false positives, and describes limitations in BBT interpretation. These findings do not support an exact confirmed date from one strip. [ASRM fertility evaluation guidance](https://www.asrm.org/practice-guidance/practice-committee-documents/fertility-evaluation-of-infertile-women-a-committee-opinion-2021/).

**Smallest correct fix:** preserve the LH and temperature dates separately. Use labels such as “LH surge detected,” “temperature shift detected,” and “signals disagree.” Reserve combined evidence for compatible timing under a documented rule, and propagate uncertainty into period/fertility estimates. Keep multiple LH episodes available for interpretation instead of automatically discarding every later positive.

**3. BUG (high): historical accuracy can depend on observations made after the outcome.**

[`loo`](/home/talon/SyncedWork/Claude/epok/js/model.js:481) slices the cycle list but passes the entire `opts.days` map. [`currentOvulation`](/home/talon/SyncedWork/Claude/epok/js/model.js:342) scans 45 days beyond the reopened cycle start, which can extend into the following cycle.

**Reproduction:** for a cycle ending April 24, adding only an LH result dated May 4 changes the earlier forecast from April 25 to May 18. Its recorded error changes from 1 to 24 days. This demonstrates future-data leakage; the direction of the resulting bias is not always optimistic.

There is also no writer for the `predictions` history promised by `CONTRACTS.md`. The displayed “past predictions” are retrospective reconstructions, not saved forecasts that were actually shown at the time.

**Smallest correct fix:** introduce an explicit forecast date and restrict observations to information available by that date. Score forecasts at defined lead times, such as cycle start and after chart evidence appears. Save forecast snapshots with their date, model version, input revision and eventual outcome. Label reconstructed historical scores separately until enough genuine snapshots exist.

**4. BUG (high): inferred period starts can misrepresent the flow log.**

[`flowStreakStarts`](/home/talon/SyncedWork/Claude/epok/js/storage.js:505) accepts spotting as a period start. [`editDay`](/home/talon/SyncedWork/Claude/epok/js/storage.js:342) only runs inference for a truthy flow value, while inference is additive and skips starts near existing ones.

**Browser reproductions:**

- One SPOTTING click creates a cycle. Clicking SPOTTING again removes the only logged day but leaves the cycle behind.
- Log bleeding starting October 2, then backfill October 1 with the same flow: the inferred start stays October 2.

These dates become the predictor's training data. This is a data integrity problem before it is a statistical problem.

**Smallest correct fix:** record whether a start was explicitly entered or inferred, and record user rejection of an inference. Reconcile inferred starts when flow changes or is cleared, preserving manual decisions. Keep spotting as a distinct observation unless explicitly marked as a period start. Introduce provenance through a schema migration that preserves existing starts.

**5. MODEL GAP (high): selecting hormonal contraception does not change natural-cycle estimates.**

The [Today prediction call](/home/talon/SyncedWork/Claude/epok/js/views/today.js:108) and [calendar calls](/home/talon/SyncedWork/Claude/epok/js/views/calendar.js:76) pass conditions, age and daily logs, but no contraception context.

**Browser reproduction:** selecting COMBINED PILL 21+7 leaves the prediction card byte-for-byte unchanged, and the fertility engine still returns 31 daily bands. CDC guidance describes suppression of ovulation with combined hormonal contraceptives; a natural-cycle inference therefore needs an explicit applicability decision. [CDC combined hormonal contraceptives guidance](https://www.cdc.gov/contraception/hcp/usspr/combined-hormonal-contraceptives.html).

**Smallest correct fix:** add method-aware prediction eligibility with a visible explanation. Distinguish a pack schedule from a natural period forecast. Use effective dates for starting/stopping methods so earlier cycles retain their context. Split hormonal and copper IUDs before applying IUD-specific rules; a generic `iud` value is insufficient.

**6. BUG / MODEL GAP (medium): the open cycle has no observation date and a fixed 45-day scan.**

The predictor does not know how far the current cycle has progressed. Its open-cycle ovulation scan stops at `start + 45`, regardless of actual observations.

**Reproductions:** on logging date October 2, a 40-day open cycle still displays September 20 as “predicted next start,” with a September 17–23 window. An LH observation at `start + 60` is found when explicitly scanning that range, but the live fertility path ignores it and returns an estimated date.

**Smallest correct fix:** accept `asOf` consistently and bound detection by actual available observations. Show when an earlier forecast has expired. Only condition a revised forecast on continued absence of bleeding when that absence has actually been recorded; an empty log does not prove it. If the model has no credible remaining support, explain the uncertainty instead of forcing a new precise date from its truncated tail.

**7. BUG (medium): the detected regime keeps moving, then discarded history returns.**

[`detectRegime`](/home/talon/SyncedWork/Claude/epok/js/model.js:205) independently compares the latest three cycles against all earlier cycles on every call. It does not retain or reconstruct a stable change boundary.

**Reproduction:** eight exactly 28-day cycles followed by exactly 34-day cycles. After three new cycles, eight old cycles are dropped. With the next observation, the reported boundary moves one cycle forward and nine are dropped. At 16 completed cycles, the detector stops firing, all 16 are included again, and the predicted length falls from 34 to 32 days despite another identical 34-day observation.

**Smallest correct fix:** derive a stable segment boundary by replaying changes in chronological order, or persist a validated boundary with edit invalidation. Fit all observations in the current segment. Add a multi-cycle continuation test; checking whether the detector fires once misses this failure.

**8. DESIGN RISK (medium): the advertised interval mass is not calibrated coverage.**

The existing [score harness](/home/talon/SyncedWork/Claude/epok/tools/score.js:211) checks that a window brackets its point estimate and that curve mass sums to one. It does not check how often actual starts land inside the interval.

**Measured cycle-length coverage**, using 300 seeds and 4,800 rolling forecasts per cohort:

| Synthetic cohort | Starts inside the nominal 80% window | Mean window width, end minus start |
|---|---:|---:|
| Regular | 87.0% | 5.7 days |
| PCOS | 72.8% | 13.9 days |
| Regime shift | 79.0% | 7.2 days |
| Perimenopause | 76.4% | 22.0 days |

The calculations contain the intended probability under the assumed model; these results show the assumption does not yield uniform 80% empirical coverage. They do not establish coverage on real users.

**Smallest correct fix:** add coverage, window width, signed error and large-error quantiles to temporal validation. Compare against recent-median and recency-weighted-mean baselines. Assess calibration by history size, irregularity and forecast timing. Broader/heavier-tailed distributions are candidates to evaluate after input and backtest fixes, not automatically better replacements.

**9. BUG (medium): exact 0.20°C temperature rises can fail the threshold.**

[`detectOvulation`](/home/talon/SyncedWork/Claude/epok/js/model.js:317) compares binary floating-point subtraction directly with `0.2`.

**Reproduction:** six readings at 36.6°C followed by three at 36.8°C return no detection because subtraction produces `0.19999999999999574`. The equivalent 36.5→36.7 chart does detect a shift.

**Smallest correct fix:** compare integer hundredths of a degree, matching the recorded precision. Test values exactly at and immediately below the documented threshold.

**10. MODEL GAP (medium): symptom patterns depend on which unrelated tags were logged.**

[`correlationsSection`](/home/talon/SyncedWork/Claude/epok/js/views/insights.js:279) counts all inferred period days in one denominator, but only days with at least one tag in the non-period denominator. A BBT-only day is excluded; adding an unrelated mood tag includes it.

**Browser reproduction:** the same cramps on 15 period days across three cycles produce no pattern when 60 non-period days contain only BBT. Add only an unrelated mood tag to those 60 days and the cramps pattern appears. Neither the cramps nor the cycle dates changed.

**Smallest correct fix:** add an explicit completed symptom check-in, including “no symptoms,” and compare rates using equally observed days. Do not treat unknown symptoms as absence. Then evaluate cycle-level resampling or a model that accounts for days being grouped within cycles. The fixed z threshold alone cannot correct biased denominators or within-cycle dependence.

**Algorithm improvements after the correctness fixes**

| Improvement | Why it belongs next | Evidence required before choosing it |
|---|---|---|
| Track uncertain and incomplete cycles | A long interval can represent a missed entry or a genuine long cycle. Preserve both possibilities and user annotations. | Tests with skipped entries, partial imports and true long cycles; no automatic deletion of outliers. |
| Fit spread and luteal history consistently | Cycle means decay with recency, cycle variance uses all observations equally, and luteal statistics have no recency weighting. | Temporal comparisons through gradual drift and abrupt changes, with interval coverage as well as error. |
| Compare model choices using past predictive performance | A 15% narrower fitted spread does not prove a mode is more accurate; the README already documents a stress case where charting worsens error. | Compare both modes at the same forecast dates, using only earlier outcomes and enough scored examples. Otherwise retain the simpler fit. |
| Treat fertility output as an uncertain relative estimate | Fixed profile values and an exact detected date do not establish an individual's conception probability. Uncertain timing should also be distinguishable from a well-supported low estimate. | Explicit evidence states, uncertainty propagation and calibration before adding numeric pregnancy probabilities. |
| Compute one shared analysis per state revision | Today computes prediction in preview and display, then repeats historical scoring for its sample count. Calendar/report independently derive evidence. | First unify correctness; cache by all relevant inputs and forecast date, invalidating after edits. No need to add a framework or backend. |

The population cycle mean of 29.3 days is supported by Bull et al.'s study of 612,613 ovulatory cycles. That sample does not by itself validate Epok's condition priors, within-person variance assumptions or behavior during anovulatory cycles. [Bull et al., 2019](https://www.nature.com/articles/s41746-019-0152-7).

**Additional features, in recommended order**

| Priority | Feature | Useful behavior |
|---|---|---|
| 1 | Cycle review and correction | A timeline showing inferred/manual starts, spotting, incomplete history and excluded observations. Every correction previews the forecast change and has undo. |
| 2 | Forecast history and personal reliability | Show the forecast originally made, actual start, lead time, error and window hit/miss. Explain why a forecast changed. This turns the existing error card into an auditable history. |
| 3 | Daily symptom check-in | “No symptoms,” severity and effect on daily activity, with logging completeness. Makes pattern denominators meaningful and adds useful detail to reports. |
| 4 | Temperature quality notes | Measurement time and optional disturbed-reading flags. Let users exclude a reading from inference while retaining the measurement and reason. |
| 5 | Dated life and medication events | Record contraceptive changes, pregnancy/postpartum/breastfeeding periods and other user-entered context. Show prediction applicability and let users pause unsuitable estimates. |
| 6 | Improve the existing clinician report | Add a selectable date range, symptom severity, prolonged bleeding episodes, medication/event annotations and observation completeness. Use detected/estimated ovulation evidence for phase summaries rather than the current average-cycle midpoint heuristic. |

**Suggested implementation order**

1. Make the new reproductions permanent, then fix time-bounded scoring and shared chart evidence together.
2. Fix inferred-start provenance, contradictory ovulation evidence and temperature arithmetic.
3. Add method context, observation dates and long-cycle handling.
4. Stabilize regime segmentation; measure interval coverage and compare simple baselines before changing the model family.
5. Add forecast snapshots and explicit symptom check-ins, then the remaining features.

**Verification record**

| Check | Result |
|---|---|
| `node tools/score.js --seeds 300` | Passed all existing cohort, change-point and contract gates; reproduced README figures. |
| `python3 tools/verify.py boot period completion calendar` | 68 checks, 0 failed. Chromium required execution outside the sandbox. |
| Focused Node audit | Confirmed the chart integration gap, future-data leakage, conflicting evidence, long-cycle limit, moving regime boundary and measured interval coverage. |
| Additional temperature boundary examples | Confirmed the 36.6→36.8°C failure and 36.5→36.7°C detection. |
| Focused browser audit | Confirmed spotting/clear behavior, backfilled start mismatch, unchanged contraception forecasts, expired forecast display, empty forecast snapshots and symptom denominator sensitivity. No page/console errors in these cases. |

Reproduction scripts and outputs are in `/tmp/epok-review-2026-10-03/`: `algorithm-audit.cjs`, `algorithm-results.json`, `browser-audit.py`, and `browser-results.json`. These scratch artifacts may be cleared with `/tmp`. This was an algorithm review with focused browser verification, not a full security, storage durability or clinical validation audit.

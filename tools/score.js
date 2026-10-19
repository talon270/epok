/* ==========================================================================
   EPOK · SCORE
   Owner: Window B. `node tools/score.js` — the proof that the engine works.
   Prints cohort x median absolute error x n. That table is what B4, B5 and
   B20 are judged on. A described result is a guess.

   Usage:  node tools/score.js               all cohorts, 60 seeds each
           node tools/score.js --seeds 200
           node tools/score.js --verbose     per-cycle rows for seed 1
   ========================================================================== */
"use strict";

var Model = require("../js/model.js");
var Backtest = require("../js/backtest.js");
var Cohorts = require("./cohorts.js");

// Recorded bars, in days of median absolute error. A run that exceeds one has
// regressed and the exit code says so. These come from the first clean run of
// B5/B20 and move only with a STATUS.md line saying what changed and why.
// Measured at 300 seeds on 2026-09-16, then given roughly 8% headroom so
// seed-to-seed noise does not fail the build. Measured means were:
//   regular 1.68 / 1.20 / 1.82   pcos 5.29 / 2.44 / 3.28
//   regime-shift 2.53 / 1.17 / 2.23   perimenopause 8.21 / 4.73 / 5.64
// `app` (ordinary app-shaped records, chart present, cycle.ovulation empty) was
// 1.68 / 5.29 / 2.53 / 8.21 before past ovulation was derived from the chart —
// identical to the cycle-length column, because luteal mode never activated —
// and is 1.17 / 2.34 / 1.17 / 4.69 after.
var BARS = {
  "regular":       { cycleLength: 1.80, luteal: 1.30, lutealStress: 1.95, app: 1.27 },
  "pcos":          { cycleLength: 5.70, luteal: 2.65, lutealStress: 3.55, app: 2.55 },
  "regime-shift":  { cycleLength: 2.75, luteal: 1.28, lutealStress: 2.40, app: 1.27 },
  "perimenopause": { cycleLength: 8.90, luteal: 5.10, lutealStress: 6.10, app: 5.05 }
};

// Change-point bars. Detection is measured three cycles after the shift,
// because REGIME_WINDOW is 3 — that is the first state in which the detector
// has enough post-shift data to be capable of firing at all.
// Measured at 300 seeds with the stateless detector: 93% detection, 0.4% and
// 2.3% false fires. The detector now replays its history so a boundary stays
// where it was set (see detectRegime), and that costs something: 86% detection,
// 0.4% and 5.3% false fires. PCOS pays most because a noisy run that survives
// the mature-boundary bar now stays in force instead of vanishing on the next
// call. The PCOS bar is set to that measured figure plus headroom, not to the
// old one — the old one was low because the detector forgot, which was the bug.
var CP_BARS = { detect: 0.85, falseRegular: 0.02, falsePcos: 0.06 };

var CYCLES_PER_RUN = 20;      // leave-one-out then has 16 scoreable predictions
var STRESS_LUTEAL_SD = 2.5;   // pessimistic end of the literature, vs 1.3 default

var args = process.argv.slice(2);
var SEEDS = args.indexOf("--seeds") >= 0 ? parseInt(args[args.indexOf("--seeds") + 1], 10) : 60;
var VERBOSE = args.indexOf("--verbose") >= 0;

var CONDITION_BY_COHORT = { "pcos": ["pcos"], "perimenopause": ["perimenopause"] };
function seedOf(s) { return s * 977 + 13; }

function median(xs) {
  if (!xs.length) return null;
  var a = xs.slice().sort(function (x, y) { return x - y; });
  var h = a.length >> 1;
  return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
}
function avg(xs) {
  var s = 0;
  for (var i = 0; i < xs.length; i++) s += xs[i];
  return xs.length ? s / xs.length : null;
}
function pad(s, n, right) {
  s = String(s);
  while (s.length < n) s = right ? s + " " : " " + s;
  return s;
}
function days(a, b) {
  function t(k) { var p = k.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000; }
  return t(b) - t(a);
}
/** Cycles as the app stores them: no ovulation field, whatever the chart says. */
function stripOvulation(cycles) {
  return cycles.map(function (c) {
    return { start: c.start, end: c.end, length: c.length, ovulation: null, ovulationSource: null };
  });
}
/** The state the app is actually in the moment before a period: cycle k open. */
function reopen(cycles, k) {
  return cycles.slice(0, k + 1).map(function (c, i) {
    return i === k
      ? { start: c.start, end: c.end, length: null, ovulation: null, ovulationSource: null }
      : c;
  });
}

// ── accuracy table ────────────────────────────────────────────────────────
/**
 * Each cohort is scored three times over the same generated cycles: with the
 * day map withheld (cycle-length mode only), with it supplied (luteal mode
 * available), and with it supplied over a deliberately less stable luteal
 * phase. Same seeds throughout, so the columns differ only by what the model
 * was allowed to see.
 */
function scoreCohort(cohort) {
  var blind = [], charted = [], stressed = [], modes = {}, sample = null;
  var appAll = [], appRows = [], appModes = {}, baseAll = [];
  // Per-run medians are what the user is shown; the pooled per-prediction mean
  // is what a regression is caught by, because a median of integers barely moves.
  var blindAll = [], chartedAll = [], stressedAll = [];

  for (var s = 1; s <= SEEDS; s++) {
    var conditions = CONDITION_BY_COHORT[cohort] || [];
    var g = Cohorts.generate(cohort, CYCLES_PER_RUN, seedOf(s));
    var gs = Cohorts.generate(cohort, CYCLES_PER_RUN, seedOf(s), { lutealSd: STRESS_LUTEAL_SD });

    var b = Backtest.run(g.cycles, { conditions: conditions });
    var c = Backtest.run(g.cycles, { conditions: conditions, days: g.days });
    var x = Backtest.run(gs.cycles, { conditions: conditions, days: gs.days });
    if (b.mae !== null) blind.push(b.mae);
    if (c.mae !== null) charted.push(c.mae);
    if (x.mae !== null) stressed.push(x.mae);
    function absOf(r) { return r.perCycle.map(function (q) { return Math.abs(q.errorDays); }); }
    blindAll = blindAll.concat(absOf(b));
    chartedAll = chartedAll.concat(absOf(c));
    stressedAll = stressedAll.concat(absOf(x));

    // App-shaped: the same daily chart, but cycle.ovulation empty — which is
    // what the app actually stores. The generator hands the model its own
    // ground truth in LUTEAL; this column makes it detect the dates itself.
    var a = Backtest.run(stripOvulation(g.cycles), { conditions: conditions, days: g.days });
    appAll = appAll.concat(absOf(a));
    for (var bi = Model.MIN_CYCLES_TO_PREDICT; bi < g.cycles.length - 1; bi++) {
      var recent = g.cycles.slice(0, bi).map(function (c) { return c.length; }).slice(-6);
      baseAll.push(Math.abs(Math.round(median(recent)) -
        days(g.cycles[bi].start, g.cycles[bi + 1].start)));
    }
    appRows = appRows.concat(a.perCycle);
    var liveApp = Model.predict(reopen(stripOvulation(g.cycles), CYCLES_PER_RUN - 1),
      { conditions: conditions, days: g.days, noMae: true });
    appModes[liveApp.mode] = (appModes[liveApp.mode] || 0) + 1;

    var live = Model.predict(g.cycles, { conditions: conditions, days: g.days, noMae: true });
    modes[live.mode] = (modes[live.mode] || 0) + 1;
    if (s === 1) sample = { live: live, charted: c };
  }

  return {
    cohort: cohort,
    cycleLength: median(blind),
    luteal: median(charted),
    lutealStress: median(stressed),
    cycleLengthMean: avg(blindAll),
    lutealMean: avg(chartedAll),
    lutealStressMean: avg(stressedAll),
    appMean: avg(appAll),
    baselineMean: avg(baseAll),
    appRows: appRows,
    appModes: appModes,
    n: CYCLES_PER_RUN - Model.MIN_CYCLES_TO_PREDICT - 1,
    runs: blind.length,
    modes: modes,
    sample: sample
  };
}

// ── change-point evidence ─────────────────────────────────────────────────
/**
 * PLAN A4's guard: "if the detector doesn't fire on the regime-shift cohort,
 * it doesn't ship." That is measured here at the earliest state where firing
 * is possible, together with what the detector costs — the false-fire rate on
 * cohorts with no true change point, and the post-shift error with the
 * detector switched off.
 */
function changePointEvidence() {
  var shift = Cohorts.REGIME_SHIFT_AT;
  var fired = 0, onErr = [], offErr = [], s, k, g, p;

  for (s = 1; s <= SEEDS; s++) {
    g = Cohorts.generate("regime-shift", CYCLES_PER_RUN, seedOf(s));
    if (Model.predict(reopen(g.cycles, shift + 3), { noMae: true }).regime.changed) fired++;
    for (k = shift; k <= shift + 5 && k < g.cycles.length - 1; k++) {
      p = Model.predict(reopen(g.cycles, k), { noMae: true });
      if (p.nextStart) onErr.push(Math.abs(days(g.cycles[k + 1].start, p.nextStart)));
      p = Model.predict(reopen(g.cycles, k), { noMae: true, noRegime: true });
      if (p.nextStart) offErr.push(Math.abs(days(g.cycles[k + 1].start, p.nextStart)));
    }
  }

  var falses = {};
  ["regular", "pcos"].forEach(function (cohort) {
    var hits = 0, checks = 0;
    for (var s2 = 1; s2 <= SEEDS; s2++) {
      var gg = Cohorts.generate(cohort, CYCLES_PER_RUN, seedOf(s2));
      for (var kk = 6; kk < gg.cycles.length - 1; kk++) {
        checks++;
        if (Model.predict(reopen(gg.cycles, kk), {
          conditions: CONDITION_BY_COHORT[cohort] || [], noMae: true
        }).regime.changed) hits++;
      }
    }
    falses[cohort] = { rate: hits / checks, hits: hits, checks: checks };
  });

  return {
    detect: fired / SEEDS,
    onMean: avg(onErr), offMean: avg(offErr), scored: onErr.length,
    falses: falses
  };
}

// ── contract surface ──────────────────────────────────────────────────────
/**
 * The cohorts exercise accuracy; they never reach the refusal path, the
 * fertility card or a bare ovulation call. This asserts the shapes those
 * return, because a view built against a field that silently went missing is
 * the integration failure the contract exists to prevent.
 */
function contractChecks() {
  var fails = [];
  function ok(cond, what) { if (!cond) fails.push(what); }

  var PRED_KEYS = ["mode", "nextStart", "window", "curve", "n", "refused",
                   "prior", "regime", "mae", "reason"];
  function shapeOk(p, label) {
    PRED_KEYS.forEach(function (k) {
      ok(Object.prototype.hasOwnProperty.call(p, k), label + ": missing field " + k);
    });
    ok(typeof p.reason === "string" && p.reason.length > 0, label + ": empty reason");
    ok(["population", "cycle-length", "luteal"].indexOf(p.mode) >= 0, label + ": bad mode " + p.mode);
  }

  // Refusal: no data at all, and below the three-cycle floor.
  var empty = Model.predict([], {});
  shapeOk(empty, "empty");
  ok(empty.refused && empty.nextStart === null && empty.curve.length === 0,
     "empty: should refuse with no date and no curve");

  var g = Cohorts.generate("regular", 20, seedOf(1));
  [1, 2, 3].forEach(function (k) {
    var sub = reopen(g.cycles, k);
    var p = Model.predict(sub, {});
    shapeOk(p, k + " closed");
    if (k < Model.MIN_CYCLES_TO_PREDICT) {
      ok(p.refused && p.nextStart === null, k + " closed: should refuse below the floor");
      ok(/\b3\b/.test(p.reason), k + " closed: reason should name the floor");
    } else {
      ok(!p.refused && !!p.nextStart, k + " closed: should predict at the floor");
    }
  });

  // A full prediction: window brackets the date, curve is a distribution.
  var full = Model.predict(reopen(g.cycles, 18), { days: g.days });
  shapeOk(full, "full");
  ok(full.window && full.window[0] <= full.nextStart && full.nextStart <= full.window[1],
     "full: window must bracket nextStart");
  var mass = full.curve.reduce(function (a, c) { return a + c.p; }, 0);
  ok(Math.abs(mass - 1) < 1e-9, "full: curve must sum to 1, got " + mass.toFixed(6));
  ok(full.curve.every(function (c) { return /^\d{4}-\d{2}-\d{2}$/.test(c.date); }),
     "full: every curve date must be a ymd key");
  ok(typeof full.mae === "number", "full: mae must be measured, not null");

  // Ovulation and luteal stats.
  var last = g.cycles[17];
  var ov = Model.detectOvulation(g.days, last.start, g.cycles[18].start);
  ok(ov && /^\d{4}-\d{2}-\d{2}$/.test(ov.date), "detectOvulation: should find a charted ovulation");
  ok(ov && ["bbt", "lh", "both"].indexOf(ov.source) >= 0, "detectOvulation: bad source");
  ok(Model.detectOvulation({}, last.start, g.cycles[18].start) === null,
     "detectOvulation: empty day map must return null, not a guess");
  var lut = Model.lutealStats(g.cycles);
  ok(lut && lut.n > 0 && lut.mean > 9 && lut.mean < 20, "lutealStats: implausible result");
  ok(Model.lutealStats([]) === null, "lutealStats: no data must return null");

  // Fertility: bands over the whole open cycle, and never a closed claim.
  var f = Model.fertility(reopen(g.cycles, 18), { days: g.days });
  ok(f.bands.length > 20, "fertility: bands must cover the open cycle");
  ok(f.bands.every(function (b) { return ["low", "elevated", "peak"].indexOf(b.band) >= 0; }),
     "fertility: bad band value");
  ok(/not contraception/i.test(f.reason), "fertility: reason must say it is not contraception");
  ok(!/(closed|over|safe|no longer fertile)/i.test(f.reason),
     "fertility: reason must never claim a window has closed");
  var fEmpty = Model.fertility([], {});
  ok(fEmpty.bands.length === 0 && fEmpty.ovulation === null && /not contraception/i.test(fEmpty.reason),
     "fertility: empty state must still carry the caveat");

  // History: finished cycles only, confirmed where the chart says so.
  function shift(key, n) {
    var d = new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10) + n));
    return d.toISOString().slice(0, 10);
  }
  var bare = g.cycles.map(function (c) { return { start: c.start, length: c.length }; });
  var h = Model.history(bare, { days: g.days });
  var closed = bare.filter(function (c, i) { return typeof c.length === "number" && bare[i + 1]; }).length;
  ok(h.length > 0 && h.length <= closed, "history: one entry per finished cycle at most, got " + h.length + " of " + closed);
  var h17 = h.filter(function (e) { return e.start === g.cycles[17].start; })[0];
  var truth = Model.detectOvulation(g.days, g.cycles[17].start, shift(g.cycles[18].start, -1));
  ok(h17 && truth && h17.ovulation.date === truth.date && h17.ovulation.source === truth.source &&
     h17.confirmed === (truth.source === "both"),
     "history: a charted cycle must carry detectOvulation's date; confirmed only when LH and temperature agree");
  ok(h.every(function (e) { return e.bands.every(function (b) { return b.date >= e.start && b.date <= e.end; }); }),
     "history: bands must stay inside their own cycle");
  var hBlank = Model.history(bare, {});
  ok(hBlank.length > 0 && hBlank.every(function (e) { return !e.confirmed && e.ovulation.source === "estimated"; }),
     "history: with no chart, every ovulation must be an estimate");
  var e0 = hBlank[0], n0 = bare[bare.map(function (c) { return c.start; }).indexOf(e0.start) + 1];
  ok(e0.ovulation.date === shift(n0.start, -14),
     "history: uncharted ovulation must be next start minus the 13.5d luteal prior (rounded), got " + e0.ovulation.date);
  ok(Model.history([], {}).length === 0 && Model.history(bare.slice(0, 1), {}).length === 0,
     "history: no finished cycle must return nothing");

  // Backtest shape.
  var bt = Backtest.run(g.cycles, {});
  ok(typeof bt.mae === "number" && bt.n === bt.perCycle.length,
     "backtest: mae/n/perCycle must agree");
  ok(Backtest.run([], {}).n === 0, "backtest: no cycles must score nothing");


  // ── regressions from REVIEW-algorithm-2026-10-03.md ──────────────────────
  function ymd(n) { return new Date(Date.UTC(2026, 0, 1) + n * 86400000).toISOString().slice(0, 10); }
  function cyclesFromLengths(lens) {
    var out = [], at = 0;
    lens.forEach(function (L) { out.push({ start: ymd(at), end: ymd(at + 4), length: L, ovulation: null, ovulationSource: null }); at += L; });
    out.push({ start: ymd(at), end: ymd(at + 4), length: null, ovulation: null, ovulationSource: null });
    return out;
  }

  // 1. Ordinary app records (no cycle.ovulation) must still activate luteal mode.
  var appCycles = reopen(stripOvulation(g.cycles), 18);
  var appPred = Model.predict(appCycles, { days: g.days, noMae: true });
  ok(Model.lutealStats(Model.withOvulation(appCycles, g.days)).n >= 10,
     "luteal: past ovulation must be derived from the chart when cycle.ovulation is empty");
  ok(Model.lutealStats(appCycles) === null,
     "luteal: lutealStats on bare cycles must stay null — derivation is withOvulation's job");

  // 2 + 9. Exactly-0.20C rise is detected; one hundredth under is not; LH and BBT 10 days apart conflict.
  function bbtChart(start, base, rise) {
    var d = {};
    for (var i = 0; i < 6; i++) d[ymd(start + i)] = { bbt: base };
    for (i = 6; i < 9; i++) d[ymd(start + i)] = { bbt: Math.round((base + rise) * 100) / 100 };
    return d;
  }
  ok(Model.detectOvulation(bbtChart(0, 36.6, 0.2), ymd(0), ymd(20)) !== null,
     "bbt: 36.6 -> 36.8 is exactly the documented 0.2C rise and must be detected");
  ok(Model.detectOvulation(bbtChart(0, 36.6, 0.19), ymd(0), ymd(20)) === null,
     "bbt: 36.6 -> 36.79 is under the threshold and must not be detected");
  var both = bbtChart(0, 36.6, 0.3);                       // temperature points near day 5
  both[ymd(15)] = { lh: "positive" };                      // LH points at day 16
  var conf = Model.detectOvulation(both, ymd(0), ymd(25));
  ok(conf && conf.source === "conflict" && conf.date === null && conf.lh && conf.bbt,
     "ovulation: LH and BBT 10 days apart must report a conflict with no date, got " + JSON.stringify(conf));
  var near = bbtChart(0, 36.6, 0.3); near[ymd(5)] = { bbt: 36.6, lh: "positive" };
  var agree = Model.detectOvulation(near, ymd(0), ymd(25));
  ok(agree && agree.source === "both" && agree.date,
     "ovulation: LH and BBT within " + 3 + " days must still be 'both'");
  var lhOnly = {}; lhOnly[ymd(12)] = { lh: "positive" };
  var cyc4 = cyclesFromLengths([28, 28, 28, 28]);
  lhOnly = {}; lhOnly[ymd(112 + 12)] = { lh: "positive" };
  var fLh = Model.fertility(cyc4, { days: lhOnly, asOf: ymd(130) });
  ok(fLh.ovulation && fLh.ovulation.source === "lh" && fLh.confirmed === false,
     "fertility: a single LH strip must be reported as LH-detected and not confirmed, got " + JSON.stringify(fLh.ovulation) + " confirmed=" + fLh.confirmed);

  // 3. A result logged inside the NEXT cycle must not change an earlier forecast.
  //    Cycle 7's own chart is blanked so the only LH signal in reach is the one
  //    dated inside cycle 8 — which is what leaked into cycle 7's forecast.
  var leakG = Cohorts.generate("regular", 12, seedOf(7));
  var blank = JSON.parse(JSON.stringify(leakG.days));
  for (var li = 0; li < leakG.cycles[7].length; li++) {
    var bk = shift(leakG.cycles[7].start, li);
    if (blank[bk]) { blank[bk].lh = null; blank[bk].bbt = null; }
  }
  var lateKey = shift(leakG.cycles[8].start, 3);
  var withLate = JSON.parse(JSON.stringify(blank));
  withLate[lateKey] = Object.assign({}, withLate[lateKey], { lh: "positive" });
  var before = Backtest.run(leakG.cycles, { days: blank }).perCycle;
  var after = Backtest.run(leakG.cycles, { days: withLate }).perCycle;
  var row7 = function (rows) { return rows.filter(function (r) { return r.start === leakG.cycles[7].start; })[0]; };
  ok(row7(before) && row7(after) && row7(before).predicted === row7(after).predicted,
     "backtest: an LH result dated inside the next cycle changed the earlier forecast from " +
     (row7(before) && row7(before).predicted) + " to " + (row7(after) && row7(after).predicted) + " (future-data leakage)");

  // 6. Expiry and as-of bounding.
  var stale = Model.predict(cyclesFromLengths([28, 28, 28, 28, 28]), { asOf: ymd(28 * 5 + 40), noMae: true });
  ok(stale.expired === true && /expired/i.test(stale.reason),
     "predict: a window 30+ days behind asOf must be marked expired, got " + stale.expired);
  var fresh = Model.predict(cyclesFromLengths([28, 28, 28, 28, 28]), { asOf: ymd(28 * 5 + 20), noMae: true });
  ok(fresh.expired === false, "predict: a window still ahead must not be marked expired");
  var late = {}; late[ymd(28 * 5 + 59)] = { lh: "positive" };
  var lateCyc = cyclesFromLengths([28, 28, 28, 28, 28]);
  var fLate = Model.fertility(lateCyc, { days: late, asOf: ymd(28 * 5 + 62) });
  ok(fLate.ovulation && fLate.ovulation.source === "lh",
     "fertility: an LH surge 59 days into a long cycle must be found when asOf covers it, got " + JSON.stringify(fLate.ovulation));
  var fEarly = Model.fertility(lateCyc, { days: late, asOf: ymd(28 * 5 + 30) });
  ok(!fEarly.ovulation || fEarly.ovulation.source === "estimated",
     "fertility: a surge dated after asOf must not be read");

  // 7. A regime boundary must not drift or dissolve as the record grows.
  var fits = [];
  for (var extra = 3; extra <= 12; extra++) {
    var lens = [28, 28, 28, 28, 28, 28, 28, 28];
    for (var q = 0; q < extra; q++) lens.push(34);
    var pr = Model.predict(cyclesFromLengths(lens), { noMae: true });
    fits.push(pr.regime.changed && pr.regime.since === ymd(8 * 28) ? pr.n : "drift@" + extra + ":" + JSON.stringify(pr.regime));
  }
  ok(fits.every(function (f, i) { return f === i + 3; }),
     "regime: boundary must stay at the first 34-day cycle and the fit must grow by one each time, got " + fits.join(","));

  // 5. An ovulation-suppressing method pauses natural-cycle prediction and fertility.
  var pill = { id: "combined-21-7", label: "COMBINED PILL 21+7", start: ymd(0) };
  var paused = Model.predict(cyclesFromLengths([28, 28, 28, 28]), { contraception: pill, asOf: ymd(200), noMae: true });
  ok(paused.refused && paused.paused === "contraception" && paused.nextStart === null && /suppresses ovulation/.test(paused.reason),
     "contraception: a combined pill must pause the natural-cycle forecast with its reason");
  var fPaused = Model.fertility(cyclesFromLengths([28, 28, 28, 28]), { contraception: pill, asOf: ymd(200) });
  ok(fPaused.bands.length === 0 && fPaused.paused === "contraception",
     "contraception: a combined pill must pause fertility bands");
  var future = Model.predict(cyclesFromLengths([28, 28, 28, 28]), { contraception: { id: "ring", start: ymd(500) }, asOf: ymd(200), noMae: true });
  ok(!future.refused, "contraception: a method that has not started yet must not pause anything");
  var copper = Model.predict(cyclesFromLengths([28, 28, 28, 28]), { contraception: { id: "iud", start: ymd(0) }, asOf: ymd(200), noMae: true });
  ok(!copper.refused, "contraception: a generic IUD must not pause (hormonal vs copper is not recorded)");

  // ── features A1, A4, A5 (PLAN-features-sync.md) ──────────────────────────
  // A1. A cycle the user leaves out is not fitted, but is still in the list.
  var base28 = cyclesFromLengths([28, 28, 28, 28, 28]);
  var withOutlier = cyclesFromLengths([28, 28, 70, 28, 28, 28]);
  var pOut = Model.predict(withOutlier, { noMae: true });
  withOutlier[2].excluded = true;
  var pEx = Model.predict(withOutlier, { noMae: true });
  ok(pEx.n === 5 && true, "excluded: the fit must count 5 cycles, not 6, got n=" + pEx.n);
  ok(pOut.window && pEx.window && days(pEx.window[0], pEx.window[1]) < days(pOut.window[0], pOut.window[1]),
     "excluded: leaving out a 70-day cycle must narrow the window");
  var fewLeft = cyclesFromLengths([28, 28, 28, 28]);
  fewLeft[0].excluded = true; fewLeft[1].excluded = true;
  var pFew = Model.predict(fewLeft, { noMae: true });
  ok(pFew.refused && /left out/.test(pFew.reason), "excluded: below the floor the reason must say cycles were left out, got " + pFew.reason);

  // A4. A disturbed reading is ignored; an identical clean one is not.
  function riseChart(disturbIdx) {
    var dd = bbtChart(0, 36.4, 0.3);
    dd[ymd(6)] = { bbt: 36.7 };
    if (disturbIdx !== undefined) dd[ymd(disturbIdx)] = { bbt: 36.9, bbtMeta: { time: "07:10", disturbed: "alcohol" } };
    return dd;
  }
  var spike = bbtChart(0, 36.4, 0.3); spike[ymd(3)] = { bbt: 36.9 };       // unflagged outlier in the baseline
  ok(Model.detectOvulation(spike, ymd(0), ymd(20)) === null,
     "bbt: an unflagged high reading inside the baseline raises the bar, so no rise is called");
  var flagged = bbtChart(0, 36.4, 0.3); flagged[ymd(3)] = { bbt: 36.9, bbtMeta: { time: "05:40", disturbed: "illness" } };
  ok(Model.detectOvulation(flagged, ymd(0), ymd(20)) !== null,
     "bbt: the same reading flagged disturbed must be ignored, letting the rise be called");
  var sparseClean = {}; for (var si = 0; si < 6; si++) sparseClean[ymd(si)] = { bbt: 36.4, bbtMeta: { disturbed: "travel" } };
  for (si = 6; si < 9; si++) sparseClean[ymd(si)] = { bbt: 36.8 };
  ok(Model.detectOvulation(sparseClean, ymd(0), ymd(20)) === null,
     "bbt: a baseline of all-disturbed readings must return null, not a guess");

  // A5. Spans: cycles inside a pregnancy / closed method span leave the fit; an open one pauses.
  var spanCycles = cyclesFromLengths([28, 28, 28, 28, 28, 40, 28, 28, 28]);
  var preg = [{ id: "e1", type: "pregnancy", from: ymd(28 * 5 - 1), to: ymd(28 * 5 + 45), note: "" }];
  var pSpan = Model.predict(spanCycles, { events: preg, noMae: true });
  var pNone = Model.predict(spanCycles, { noMae: true });
  ok(pSpan.n < pNone.n, "events: cycles overlapping a pregnancy must leave the fit, n " + pSpan.n + " vs " + pNone.n);
  var pillSpan = [{ id: "e2", type: "contraception", method: "combined-21-7", from: ymd(0), to: ymd(28 * 3 - 1), note: "" }];
  var pPill = Model.predict(spanCycles, { events: pillSpan, noMae: true });
  ok(pPill.n === pNone.n - 3, "events: three cycles on a closed pill span must leave the fit, n " + pPill.n + " vs " + pNone.n);
  var openContra = [{ id: "e3", type: "contraception", method: "combined-21-7", from: ymd(0), to: null, note: "" }];
  ok(!Model.predict(spanCycles, { events: openContra, noMae: true }).refused,
     "events: an open contraception event is the current method (read from opts.contraception) and must not pause on its own");
  var openPreg = [{ id: "e4", type: "pregnancy", from: ymd(28 * 8), to: null, note: "" }];
  var pPaused = Model.predict(spanCycles, { events: openPreg, asOf: ymd(28 * 8 + 10), noMae: true });
  ok(pPaused.refused && pPaused.paused === "event" && /pregnancy/.test(pPaused.reason), "events: an open pregnancy must pause with its reason");
  var fPaused2 = Model.fertility(spanCycles, { events: openPreg, asOf: ymd(28 * 8 + 10) });
  ok(fPaused2.bands.length === 0 && fPaused2.paused === "event", "events: an open pregnancy must pause the fertility bands");
  var bf = [{ id: "e5", type: "breastfeeding", from: ymd(0), to: null, note: "" }];
  var pBf = Model.predict(spanCycles, { events: bf, asOf: ymd(28 * 8 + 5), noMae: true });
  ok(!pBf.refused && /Breastfeeding/.test(pBf.reason), "events: breastfeeding must caveat, not pause");

  return fails;
}

var contractFails = contractChecks();

// ── report ────────────────────────────────────────────────────────────────
var results = Cohorts.COHORTS.map(scoreCohort);
var cp = changePointEvidence();
var failed = [];

console.log("");
console.log("contract surface   " + (contractFails.length ? contractFails.length + " FAILED" : "all checks pass"));
contractFails.forEach(function (f) { console.log("  FAIL  " + f); });
if (contractFails.length) failed.push("contract surface (" + contractFails.length + " checks)");

console.log("");
console.log("epok · engine score   " + SEEDS + " seeds x " + CYCLES_PER_RUN +
            " cycles, leave-one-out, MEDIAN absolute error in days");
console.log("");
console.log(pad("COHORT", 15, true) + pad("CYCLE-LEN", 14) + pad("LUTEAL", 14) +
            pad("LUT.STRESS", 14) + pad("APP-SHAPED", 12) + pad("N/RUN", 7) + "   median (mean); APP-SHAPED mean only");
console.log("-".repeat(80));

function cell(medv, meanv) { return pad(medv.toFixed(2) + " (" + meanv.toFixed(2) + ")", 14); }

results.forEach(function (r) {
  var bar = BARS[r.cohort];
  var bad = r.cycleLengthMean > bar.cycleLength || r.lutealMean > bar.luteal ||
            r.lutealStressMean > bar.lutealStress || r.appMean > bar.app;
  if (bad) failed.push(r.cohort + " (accuracy)");
  console.log(
    pad(r.cohort, 15, true) +
    cell(r.cycleLength, r.cycleLengthMean) +
    cell(r.luteal, r.lutealMean) +
    cell(r.lutealStress, r.lutealStressMean) +
    pad(r.appMean.toFixed(2), 12) +
    pad(r.n, 7) +
    (bad ? "   <-- REGRESSED" : "")
  );
});
console.log("");
console.log("bars, on the MEAN (a median of whole days barely moves under a real regression):");
results.forEach(function (r) {
  var bar = BARS[r.cohort];
  console.log("  " + pad(r.cohort, 15, true) + "cycle-len <= " + bar.cycleLength.toFixed(2) +
              "   luteal <= " + bar.luteal.toFixed(2) + "   stress <= " + bar.lutealStress.toFixed(2) +
              "   app-shaped <= " + bar.app.toFixed(2));
});

console.log("");
console.log("  CYCLE-LEN    day map withheld: the model sees period starts only.");
console.log("  LUTEAL       day map supplied, luteal phase generated at sd 1.3 (literature's stable case).");
console.log("  LUT.STRESS   same, at sd " + STRESS_LUTEAL_SD.toFixed(1) + " — a person whose luteal phase is NOT stable.");
console.log("               The gap between the last two columns is how much of the LUTEAL");
console.log("               column is the generator's assumption rather than the engine's skill.");
console.log("  APP-SHAPED   same charts as LUTEAL, but cycle.ovulation left empty as the app stores it, so");
console.log("               the model has to DETECT every past ovulation itself. This is the column that");
console.log("               says what a real log gets; LUTEAL says what a log with answers pre-filled gets.");

// Calibration of the window the app prints, on the app-shaped runs. Measured,
// not gated: a coverage bar would need a decision about what the window is
// FOR, and the honest number is the finding.
console.log("");
console.log("window calibration, app-shaped runs   (nominal " + Math.round(100 * Model.WINDOW_MASS) + "% window)");
console.log("-".repeat(80));
console.log(pad("COHORT", 15, true) + pad("INSIDE", 9) + pad("WIDTH", 9) + pad("BIAS", 9) + pad("P90 ABS", 9) + pad("BASELINE", 10) + "   (baseline: median of last 6 lengths)");
results.forEach(function (r) {
  var rows = r.appRows, inside = 0, width = [], signed = [], abs = [];
  rows.forEach(function (q) {
    if (q.window && q.actual >= q.window[0] && q.actual <= q.window[1]) inside++;
    if (q.window) width.push(days(q.window[0], q.window[1]));
    signed.push(q.errorDays); abs.push(Math.abs(q.errorDays));
  });
  abs.sort(function (a, b) { return a - b; });
  console.log(pad(r.cohort, 15, true) +
    pad((100 * inside / rows.length).toFixed(1) + "%", 9) + pad(avg(width).toFixed(1) + "d", 9) +
    pad((avg(signed) >= 0 ? "+" : "") + avg(signed).toFixed(2), 9) +
    pad(abs[Math.floor(0.9 * (abs.length - 1))].toFixed(0) + "d", 9) +
    pad(r.baselineMean.toFixed(2), 10));
});

console.log("");
console.log("live mode chosen, at " + CYCLES_PER_RUN + " cycles with a full chart, app-shaped records:");
results.forEach(function (r) {
  var m = Object.keys(r.appModes).map(function (k) {
    return k + " " + Math.round(100 * r.appModes[k] / r.runs) + "%";
  }).join(", ");
  console.log("  " + pad(r.cohort, 15, true) + m);
});

console.log("");
console.log("change-point detector   (PLAN A4)");
console.log("-".repeat(80));
console.log("  fires 3 cycles after the shift   " + (100 * cp.detect).toFixed(0) + "% of runs" +
            "        bar " + (100 * CP_BARS.detect).toFixed(0) + "%");
console.log("  mean error in the 6 cycles after the shift:  ON " + cp.onMean.toFixed(2) +
            "d   OFF " + cp.offMean.toFixed(2) + "d   (" + cp.scored + " predictions)");
console.log("  false fires, regular cohort      " + (100 * cp.falses.regular.rate).toFixed(1) + "% of " +
            cp.falses.regular.checks + " checks   bar " + (100 * CP_BARS.falseRegular).toFixed(0) + "%");
console.log("  false fires, pcos cohort         " + (100 * cp.falses.pcos.rate).toFixed(1) + "% of " +
            cp.falses.pcos.checks + " checks   bar " + (100 * CP_BARS.falsePcos).toFixed(0) + "%");

if (cp.detect < CP_BARS.detect) failed.push("regime-shift (detection " + (100 * cp.detect).toFixed(0) + "%)");
if (cp.onMean >= cp.offMean) failed.push("change-point (detector does not reduce post-shift error)");
if (cp.falses.regular.rate > CP_BARS.falseRegular) failed.push("regular (false fires)");
if (cp.falses.pcos.rate > CP_BARS.falsePcos) failed.push("pcos (false fires)");

if (VERBOSE) {
  var s0 = results[0].sample;
  console.log("\nper-cycle, " + results[0].cohort + " seed 1, charted:");
  s0.charted.perCycle.forEach(function (row) {
    console.log("  from " + row.start + "  predicted " + row.predicted + "  actual " + row.actual +
                "  " + (row.errorDays > 0 ? "+" : "") + row.errorDays + "d");
  });
  console.log("\nlive: " + s0.live.reason);
  console.log("window " + JSON.stringify(s0.live.window) + "  n=" + s0.live.n +
              "  mode=" + s0.live.mode + "  mae=" + s0.live.mae);
}

console.log("");
if (failed.length) {
  console.log("REGRESSED: " + failed.join("; "));
  process.exit(1);
}
console.log("All cohorts and the change-point detector are within their recorded bars.");

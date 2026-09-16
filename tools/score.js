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
var BARS = {
  "regular":       { cycleLength: 1.80, luteal: 1.30, lutealStress: 1.95 },
  "pcos":          { cycleLength: 5.70, luteal: 2.65, lutealStress: 3.55 },
  "regime-shift":  { cycleLength: 2.75, luteal: 1.28, lutealStress: 2.40 },
  "perimenopause": { cycleLength: 8.90, luteal: 5.10, lutealStress: 6.10 }
};

// Change-point bars. Detection is measured three cycles after the shift,
// because REGIME_WINDOW is 3 — that is the first state in which the detector
// has enough post-shift data to be capable of firing at all.
// Measured at 300 seeds: 93% detection, 0.4% and 2.3% false fires.
var CP_BARS = { detect: 0.85, falseRegular: 0.02, falsePcos: 0.035 };

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
  ok(h17 && truth && h17.confirmed && h17.ovulation.date === truth.date,
     "history: a charted cycle must carry detectOvulation's date, confirmed");
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
            pad("LUT.STRESS", 14) + pad("N/RUN", 7) + "   median (mean)");
console.log("-".repeat(80));

function cell(medv, meanv) { return pad(medv.toFixed(2) + " (" + meanv.toFixed(2) + ")", 14); }

results.forEach(function (r) {
  var bar = BARS[r.cohort];
  var bad = r.cycleLengthMean > bar.cycleLength || r.lutealMean > bar.luteal ||
            r.lutealStressMean > bar.lutealStress;
  if (bad) failed.push(r.cohort + " (accuracy)");
  console.log(
    pad(r.cohort, 15, true) +
    cell(r.cycleLength, r.cycleLengthMean) +
    cell(r.luteal, r.lutealMean) +
    cell(r.lutealStress, r.lutealStressMean) +
    pad(r.n, 7) +
    (bad ? "   <-- REGRESSED" : "")
  );
});
console.log("");
console.log("bars, on the MEAN (a median of whole days barely moves under a real regression):");
results.forEach(function (r) {
  var bar = BARS[r.cohort];
  console.log("  " + pad(r.cohort, 15, true) + "cycle-len <= " + bar.cycleLength.toFixed(2) +
              "   luteal <= " + bar.luteal.toFixed(2) + "   stress <= " + bar.lutealStress.toFixed(2));
});

console.log("");
console.log("  CYCLE-LEN    day map withheld: the model sees period starts only.");
console.log("  LUTEAL       day map supplied, luteal phase generated at sd 1.3 (literature's stable case).");
console.log("  LUT.STRESS   same, at sd " + STRESS_LUTEAL_SD.toFixed(1) + " — a person whose luteal phase is NOT stable.");
console.log("               The gap between the last two columns is how much of the LUTEAL");
console.log("               column is the generator's assumption rather than the engine's skill.");

console.log("");
console.log("live mode chosen, at " + CYCLES_PER_RUN + " cycles with a full chart:");
results.forEach(function (r) {
  var m = Object.keys(r.modes).map(function (k) {
    return k + " " + Math.round(100 * r.modes[k] / r.runs) + "%";
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

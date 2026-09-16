/* ==========================================================================
   EPOK · SYNTHETIC COHORTS
   Owner: Window B. Node only — never loaded by the browser.

     · regular        28 +/- 2
     · pcos           24-45, high variance
     · regime-shift   28 for 8 cycles, then 34 (the change-point test)
     · perimenopause  lengthening, with skipped cycles

   Known ground truth is the point: a model scored only against real data
   cannot be shown to have missed a regime change.
   ========================================================================== */
"use strict";

// Every cohort starts here so two runs with the same seed are byte-identical.
var EPOCH = "2024-01-07";

// Charting realism. A person who takes their temperature does not take it
// every day, and an LH strip is only used around the expected surge.
var BBT_MISS_RATE   = 0.15;
var BBT_FOLLICULAR  = { mean: 36.45, sd: 0.08 };
var BBT_LUTEAL      = { mean: 36.72, sd: 0.09 };
var LH_TEST_WINDOW  = 5;    // days either side of expected ovulation that get a strip

// Luteal phase is the stable half of the cycle — this is the fact B20 exploits.
var LUTEAL = { mean: 13.5, sd: 1.3 };

var REGIME_SHIFT_AT = 8;    // cycle index where 28 becomes 34

// ── seeded PRNG ───────────────────────────────────────────────────────────
// mulberry32: 32 bits of state, good enough for synthetic health data and
// short enough to read. Reproducibility is the requirement, not crypto.
function rng(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r, mean, sd) {
  // Box-Muller. Only one of the two normals is kept; the waste is irrelevant here.
  var u = 1 - r(), v = r();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

// ── date arithmetic on "YYYY-MM-DD" ───────────────────────────────────────
// UTC integers throughout: these are calendar-day keys, not instants, so a
// local-time parse would only introduce a DST hazard.
function toDays(key) {
  var p = key.split("-");
  return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000;
}
function fromDays(n) {
  var d = new Date(n * 86400000);
  var m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return d.getUTCFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
}
function addDays(key, n) { return fromDays(toDays(key) + n); }

// ── per-cohort length draw ────────────────────────────────────────────────
// Each returns { length, ovulates } for cycle index i (0-based).
var COHORTS = {
  "regular": function (r) {
    return { length: Math.round(clamp(gauss(r, 28, 2), 21, 40)), ovulates: true };
  },

  "pcos": function (r) {
    // Bimodal, not merely wide: PCOS produces ordinary-ish cycles interleaved
    // with long anovulatory ones. A single fat Gaussian would understate how
    // hard this cohort is, which would flatter the model.
    if (r() < 0.55) return { length: Math.round(clamp(gauss(r, 29, 3), 24, 45)), ovulates: true };
    return { length: Math.round(clamp(33 + r() * 12, 24, 45)), ovulates: r() < 0.4 };
  },

  "regime-shift": function (r, i) {
    var mean = i < REGIME_SHIFT_AT ? 28 : 34;
    return { length: Math.round(clamp(gauss(r, mean, 2), 21, 45)), ovulates: true };
  },

  "perimenopause": function (r, i, n) {
    // Mean drifts 28 -> 40 and variance grows with it; roughly one cycle in
    // seven is skipped, which shows up as a near-doubled length and no
    // ovulation. Skips are the part that breaks naive averaging.
    var t = n > 1 ? i / (n - 1) : 0;
    var mean = 28 + 12 * t;
    var sd = 2 + 6 * t;
    var len = Math.round(clamp(gauss(r, mean, sd), 21, 70));
    if (r() < 0.15) return { length: Math.round(clamp(len * 1.8, 40, 90)), ovulates: false };
    return { length: len, ovulates: true };
  }
};

/**
 * generate(cohort, n, seed) -> { cohort, cycles, days, truth }
 *
 * `cycles` is exactly the stored shape from CONTRACTS.md, ascending, with the
 * last entry open (length null) the way the live app always holds it.
 * `days` is the sparse day map, carrying flow, bbt and lh.
 * `truth` is what the generator knew and the model is not told.
 */
function generate(cohort, n, seed, opts) {
  opts = opts || {};
  // lutealSd overrides the generator's luteal spread. Scoring luteal mode
  // against a MORE variable luteal phase than the literature's best case is
  // the only way to show the mode degrades honestly rather than merely
  // reflecting an assumption the generator put there.
  var lutealSd = typeof opts.lutealSd === "number" ? opts.lutealSd : LUTEAL.sd;
  var draw = COHORTS[cohort];
  if (!draw) throw new Error("unknown cohort: " + cohort);
  if (n < 2) throw new Error("need at least 2 cycles");

  var r = rng(seed);
  var cycles = [], days = {}, truth = { lengths: [], ovulations: [], skipped: [] };
  var start = EPOCH;

  for (var i = 0; i < n; i++) {
    var last = i === n - 1;
    var d = draw(r, i, n);
    var bleed = Math.round(clamp(gauss(r, 4.8, 1.0), 2, 8));

    // Ovulation is placed backwards from the NEXT start, because the luteal
    // phase is the fixed part — placing it forwards from this start would
    // build the model's own assumption into the data being used to test it.
    var ovDay = null;
    if (d.ovulates) {
      var luteal = Math.round(clamp(gauss(r, LUTEAL.mean, lutealSd), 9, 18));
      var off = d.length - luteal;
      if (off >= 8) ovDay = off;           // implausibly early ovulation is dropped
    }
    var ovKey = ovDay === null ? null : addDays(start, ovDay);

    for (var k = 0; k < d.length; k++) {
      var key = addDays(start, k);
      var day = { flow: null, tags: [], bbt: null, lh: null, pill: null, note: "" };

      if (k < bleed) day.flow = k === 0 ? "medium" : k === 1 ? "heavy" : k < 4 ? "medium" : "light";

      if (r() > BBT_MISS_RATE) {
        var luteal_phase = ovDay !== null && k > ovDay;
        var b = luteal_phase ? BBT_LUTEAL : BBT_FOLLICULAR;
        day.bbt = Math.round(gauss(r, b.mean, b.sd) * 100) / 100;
      }

      if (ovDay !== null && Math.abs(k - (ovDay - 1)) <= LH_TEST_WINDOW) {
        // The surge lands the day before ovulation. Strips are read as a single
        // positive; a second positive day is possible but adds nothing to test.
        day.lh = k === ovDay - 1 ? "positive" : "negative";
      }

      days[key] = day;
    }

    cycles.push({
      start: start,
      end: addDays(start, bleed - 1),
      length: last ? null : d.length,
      ovulation: last ? null : ovKey,     // the open cycle's ovulation must be DETECTED, not handed over
      ovulationSource: last ? null : (ovKey ? "both" : null)
    });

    truth.lengths.push(d.length);
    truth.ovulations.push(ovKey);
    if (!d.ovulates) truth.skipped.push(i);

    start = addDays(start, d.length);
  }

  truth.changePoint = cohort === "regime-shift" ? cycles[REGIME_SHIFT_AT].start : null;
  return { cohort: cohort, cycles: cycles, days: days, truth: truth };
}

module.exports = { generate: generate, COHORTS: Object.keys(COHORTS), REGIME_SHIFT_AT: REGIME_SHIFT_AT };

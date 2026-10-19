/* ==========================================================================
   EPOK · MODEL

   Owner: Window B. See PLAN-epok.md § Parallel windows.

     · PRIOR         population 29.3d sd 5.0, shifted by declared conditions, shrinking with real data
     · POSTERIOR     Bayesian over cycle length; refuses to predict below 3 cycles
     · CHANGE-POINT  a superseded regime is dropped from the fit, and the card says so
     · LUTEAL        confirmed ovulation switches to ovulation + measured luteal length
     · HISTORY       per finished cycle: ovulation (confirmed or estimated) and its fertile bands
     · AS-OF         every forecast sees only observations up to opts.asOf, so a backtest cannot read the future
     · PAUSED        no natural-cycle forecast while an ovulation-suppressing method, a pregnancy or
                     a postpartum span is in effect
     · SPANS         cycles that overlap such a span, or that the user left out, are not fitted
     · PURE          no DOM, no localStorage. Everything arrives as arguments.

   Public namespace: Epok.Model
   ========================================================================== */

"use strict";

(function () {
  // Starting points only — their influence decays to near-zero by roughly six
  // logged cycles. Sources and their limits: README § Sources. The population
  // mean 29.3 is Bull et al. 2019; its sd 5.0 is unconfirmed. The PCOS and
  // perimenopause figures have NO source — no study reports a single mean and
  // sd for either — and are kept as deliberately wide engineering choices.
  var PRIOR_POPULATION = { mean: 29.3, sd: 5.0, source: "population" };
  var PRIOR_BY_CONDITION = {
    pcos:          { mean: 36.5, sd: 9.0, source: "pcos" },
    perimenopause: { mean: 33.0, sd: 11.0, source: "perimenopause" }
  };
  // Written on every saved forecast (state.predictions) so a snapshot says
  // which engine made it. Bump it when a change can move a forecast.
  var MODEL_VERSION = 2;
  var MIN_CYCLES_TO_PREDICT = 3;   // below this the model refuses and says why
  var REGIME_WINDOW = 3;           // cycles compared against the prior regime

  // How fast an old cycle stops mattering. A half-life of 6 means the cycle
  // from a year ago carries an eighth of the weight of last month's — enough
  // history to be stable, not so much that a person's body from 2024 argues
  // with their body now.
  var RECENCY_HALF_LIFE = 6;

  // Change-point thresholds. The recent block must differ from the prior block
  // by BOTH 2.5 standard errors AND a flat 3 days. The standard-error test
  // alone fires on a very regular person's ordinary noise; the flat-day test
  // alone fires constantly on PCOS. Requiring both is what makes the detector
  // usable on all four cohorts with one set of numbers. The 3-day floor mattered
  // when spread was floored (it halved regular-cohort false fires, 4.1% -> 2.2%);
  // since spread is pooled it changes nothing on the cohorts — 0.4% false fires
  // and 93% detection at either 2 or 3 days, 300 seeds. It stays as a guard for
  // a person more regular than any cohort, where a 2-day move is still noise.
  var REGIME_SIGMAS   = 2.5;
  var REGIME_MIN_DAYS = 3.0;

  // A declared irregular condition raises the bar, because irregularity is
  // then not news — the user already told us. Measured over 300 seeds: 3.5
  // sigmas cuts false fires on the PCOS cohort from 9.1% of 3900 checks to
  // 2.3%, mean error 5.29 -> 5.25 days, regime-shift detection unchanged.
  // Telling someone with PCOS that their cycles have "changed" when they are
  // merely being irregular is the PLAN A5 failure in another costume.
  var REGIME_SIGMAS_IRREGULAR = 3.5;

  // Extra sigmas a boundary must clear once more than REGIME_WINDOW cycles
  // sit after it. See detectRegime.
  var REGIME_MATURE_EXTRA = 1.0;

  // Spread is POOLED toward a typical within-person figure rather than floored.
  // A floor lets three near-identical cycles claim near-certainty, and one
  // measured luteal length claim any certainty at all — which is the false
  // confidence this whole app exists to refuse. Pooling with a few pseudo-
  // observations makes a short record honestly vague and leaves a long one
  // almost untouched.
  //
  // Note these are WITHIN-person spreads, not the population priors above. The
  // population sd of 5.0 days is mostly the difference between people, and
  // using it here would make a regular person's window absurdly wide.
  var WITHIN_SD_CYCLE = 3.0;    // typical within-person spread. UNSOURCED — see README § Sources
  var WITHIN_SD_LUTEAL = 2.0;   // the luteal phase is the tighter half
  var PSEUDO_OBS = 2;           // how much the pooled figure is worth, in cycles

  // Luteal phase: the stable half. Lenton 1984 measured 14.13 +/- 1.41 days;
  // Bull 2019 reports a mean of 12.4 from app data. 13.5 sits between them and
  // the sd of 2.0 is wider than Lenton's on purpose — app-logged ovulation is
  // noisier than a clinic's. That stability is why a confirmed ovulation can
  // beat a cycle-length fit, though it has to prove it (LUTEAL_MARGIN).
  var LUTEAL_PRIOR = { mean: 13.5, sd: 2.0 };

  // Luteal mode must be DECISIVELY tighter, not merely tighter. When the two
  // spreads are close the comparison is a coin flip on estimation noise, and
  // measured over 300 seeds it picked luteal on 49% of predictions on a regular
  // cohort with an unstable luteal phase (sd 2.5) and was 0.54 days worse each
  // time. Requiring a 15% margin cuts that to 27% and the cohort's mean error
  // from 1.94 to 1.82 days — still worse than ignoring the chart (1.68), so
  // this narrows the loss rather than removing it.
  // The tie goes to cycle length because every cycle contributes a length,
  // while only charted cycles contribute a luteal measurement.
  var LUTEAL_MARGIN = 0.85;
  var LUTEAL_PLAUSIBLE = [9, 20];   // days; anything outside is a mis-logged ovulation

  // 3-over-6: three consecutive temperatures above the highest of the previous
  // six, the third at least this far above. The standard symptothermal rule.
  var BBT_RISE_C = 0.2;
  // Compared as integer hundredths: 36.8 - 36.6 is 0.19999999999999574 in
  // floating point and failed a threshold the chart exactly meets.
  var BBT_RISE_HUNDREDTHS = Math.round(BBT_RISE_C * 100);

  // LH and temperature are two different, indirect signals. They are called
  // "both" only when their dates fall within this many days of each other;
  // further apart they are a conflict, never averaged into a date neither
  // signal reported. UNSOURCED — an engineering tolerance, not a clinical one.
  var OV_AGREE_DAYS = 3;

  // How far a single-signal ovulation date is trusted, as a spread around it.
  // An LH surge precedes ovulation by roughly 1-2 days and a strip can be a
  // false positive (ASRM); a temperature rise only shows ovulation after the
  // fact and is noisier still. "both" and a user-recorded date stay exact.
  // The shapes are UNSOURCED and deliberately wide.
  var OV_SPREAD = {
    lh:  { "-1": 0.25, "0": 0.50, "1": 0.25 },
    bbt: { "-2": 0.10, "-1": 0.20, "0": 0.40, "1": 0.20, "2": 0.10 }
  };

  // Methods that suppress ovulation, so bleeding on them is a pack or
  // withdrawal bleed and not the cycle this model fits (CDC US SPR for
  // combined hormonal methods; injection, implant, ring and patch likewise).
  // The progestogen-only pill and IUDs are NOT listed: pill suppression is
  // inconsistent, and the data table does not separate hormonal from copper
  // IUDs — pausing on a copper IUD would be wrong.
  var OV_SUPPRESSING = {
    "combined-21-7": true, "combined-24-4": true, "continuous": true,
    "patch": true, "ring": true, "injection": true, "implant": true
  };
  var BBT_LOOKBACK = 6;

  // Central credible interval reported as the window. 80% is chosen over 95%
  // deliberately: on the PCOS cohort the 80% window averages 15.3 days and the
  // 95% window 23.1 — most of a cycle, which tells the user nothing.
  var WINDOW_MASS = 0.80;

  // Day-relative conception probability, peaking the day before ovulation.
  // Used only to shape the fertility bands — never to assert safety.
  var FERTILE_PROFILE = {
    "-5": 0.10, "-4": 0.16, "-3": 0.24, "-2": 0.30,
    "-1": 0.33, "0": 0.28, "1": 0.08, "2": 0.02
  };
  var BAND_PEAK = 0.20;
  var BAND_ELEVATED = 0.08;

  // ── date arithmetic on "YYYY-MM-DD" ─────────────────────────────────────
  // UTC integers throughout. These are calendar-day keys, not instants, so a
  // local-time parse would buy nothing and cost a DST bug. Keys only ever
  // enter this module already formed by Epok.ymd().
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
  function diffDays(a, b) { return toDays(b) - toDays(a); }

  // ── small statistics ────────────────────────────────────────────────────
  function mean(xs) {
    var s = 0;
    for (var i = 0; i < xs.length; i++) s += xs[i];
    return s / xs.length;
  }
  function sampleVar(xs) {
    if (xs.length < 2) return null;
    var m = mean(xs), s = 0;
    for (var i = 0; i < xs.length; i++) s += (xs[i] - m) * (xs[i] - m);
    return s / (xs.length - 1);
  }
  /** Sample spread pooled with PSEUDO_OBS pseudo-observations at `typical`. */
  function pooledSd(xs, typical) {
    var sv = sampleVar(xs);
    var df = xs.length - 1;
    if (sv === null) return typical;
    return Math.sqrt((PSEUDO_OBS * typical * typical + df * sv) / (PSEUDO_OBS + df));
  }
  function median(xs) {
    if (!xs.length) return null;
    var a = xs.slice().sort(function (x, y) { return x - y; });
    var h = a.length >> 1;
    return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
  }

  /**
   * Normal-normal conjugate update with recency-weighted observations.
   * Returns the posterior over the MEAN plus the predictive spread for the
   * NEXT observation — which is the one the window has to cover. Reporting
   * only the uncertainty in the mean would produce a window that looks
   * precise and is wrong about half the time.
   */
  function posterior(obs, prior) {
    if (!obs.length) {
      return { mean: prior.mean, meanSd: prior.sd, predSd: prior.sd, weight: 0, obsSd: prior.sd };
    }
    var obsSd = pooledSd(obs, WITHIN_SD_CYCLE);
    var varObs = obsSd * obsSd;
    var precision = 1 / (prior.sd * prior.sd);
    var num = prior.mean * precision;
    var w = 0;
    for (var i = 0; i < obs.length; i++) {
      var wi = Math.pow(0.5, (obs.length - 1 - i) / RECENCY_HALF_LIFE);
      w += wi;
      num += wi * obs[i] / varObs;
      precision += wi / varObs;
    }
    var varMean = 1 / precision;
    return {
      mean: num / precision,
      meanSd: Math.sqrt(varMean),
      predSd: Math.sqrt(varObs + varMean),
      weight: w,
      obsSd: obsSd
    };
  }

  function priorFor(opts) {
    var conditions = (opts && opts.conditions) || [];
    var best = PRIOR_POPULATION;
    for (var i = 0; i < conditions.length; i++) {
      var p = PRIOR_BY_CONDITION[conditions[i]];
      // Widest declared condition wins: a wide prior concedes ignorance, and
      // conceding ignorance is the safe direction to be wrong in.
      if (p && p.sd > best.sd) best = p;
    }
    // opts.ageBand is accepted and deliberately does not move the prior. There
    // is no defensible population number by age band that isn't already said
    // better by a declared condition, and inventing one would be the exact
    // false confidence this app exists to avoid.
    return best;
  }

  /**
   * Change-point detection. Compares the last REGIME_WINDOW lengths against the
   * rest of the current segment; if they differ on both tests, the older block
   * is superseded.
   *
   * Replayed chronologically rather than re-run on the whole record: a fresh
   * test on every call let the boundary slide one cycle forward with each new
   * observation, and once the record was twice the window the detector stopped
   * firing and every dropped cycle came back (eight 28s then 34s: the fit fell
   * from 34 to 32 on another identical 34). Once a boundary is set, the cycles
   * after it are one segment and are only compared against each other.
   */
  function regimeFires(prior, recent, sigmas) {
    var dm = Math.abs(mean(recent) - mean(prior));
    var sp = pooledSd(prior, WITHIN_SD_CYCLE), sr = pooledSd(recent, WITHIN_SD_CYCLE);
    var se = Math.sqrt(sp * sp / prior.length + sr * sr / recent.length);
    return dm >= sigmas * se && dm >= REGIME_MIN_DAYS;
  }

  function detectRegime(lengths, sigmas) {
    var bounds = [0];                       // segment starts; bounds[0] is the record's start
    for (var n = REGIME_WINDOW * 2; n <= lengths.length; n++) {
      var from = bounds[bounds.length - 1];
      if (n - from < REGIME_WINDOW * 2) continue;
      var cut = n - REGIME_WINDOW;
      if (regimeFires(lengths.slice(from, cut), lengths.slice(cut, n), sigmas)) bounds.push(cut);
    }
    // A boundary is kept only if the WHOLE segment after it still differs from
    // the one before it. A single noisy run that fired and then regressed to
    // the old mean is dropped here; without this, one false fire stuck for the
    // rest of the record and the PCOS cohort's false-fire rate went 2.3% -> 16%.
    while (bounds.length > 1) {
      var b = bounds[bounds.length - 1], pb = bounds[bounds.length - 2];
      // A boundary with more than REGIME_WINDOW cycles behind it has had time to
      // prove itself, so it is held to a stricter bar than a fresh one.
      var bar = lengths.length - b > REGIME_WINDOW ? sigmas + REGIME_MATURE_EXTRA : sigmas;
      if (regimeFires(lengths.slice(pb, b), lengths.slice(b), bar)) break;
      bounds.pop();
    }
    var boundary = bounds[bounds.length - 1];
    return boundary > 0 ? { changed: true, index: boundary, dropped: boundary }
                        : { changed: false, index: 0, dropped: 0 };
  }

  // ── cycle helpers ───────────────────────────────────────────────────────
  // Returns the closed cycles themselves, not just their lengths: the
  // change-point index has to map back to a real cycle to name the date the
  // new regime started.
  function closedCycles(cycles) {
    var out = [];
    for (var i = 0; i < cycles.length; i++) {
      if (typeof cycles[i].length === "number" && !cycles[i]._skip && !cycles[i].excluded) out.push(cycles[i]);
    }
    return out;
  }

  /**
   * Spans, from events, in which a cycle is not a natural one: pregnancy,
   * postpartum, and a closed spell on an ovulation-suppressing method. An
   * open contraception event is the CURRENT method and is read from
   * opts.contraception instead, so it is not counted twice. A span with no
   * start covers everything before its end.
   */
  function skipSpans(events) {
    var out = [];
    (events || []).forEach(function (e) {
      var natural = e.type === "pregnancy" || e.type === "postpartum" ||
        (e.type === "contraception" && e.to && OV_SUPPRESSING[e.method]);
      if (natural) out.push({ from: e.from || "0000-01-01", to: e.to || "9999-12-31" });
    });
    return out;
  }

  /** Copies of closed cycles, marked _skip when they overlap a span. The open cycle is never marked. */
  function flagCycles(cycles, events) {
    var spans = skipSpans(events);
    return cycles.map(function (c, i) {
      var next = cycles[i + 1];
      var skip = false;
      if (next && spans.length) {
        var last = addDays(next.start, -1);
        for (var j = 0; j < spans.length; j++) {
          if (c.start <= spans[j].to && last >= spans[j].from) { skip = true; break; }
        }
      }
      var copy = {};
      for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) copy[k] = c[k];
      copy._skip = skip;
      return copy;
    });
  }

  function anchorOf(cycles) {
    return cycles.length ? cycles[cycles.length - 1].start : null;
  }

  /** Build the per-day start-probability curve from a normal predictive. */
  function buildCurve(anchor, m, s) {
    var lo = Math.round(m - 3.5 * s), hi = Math.round(m + 3.5 * s);
    if (lo < 1) lo = 1;
    if (hi < lo + 2) hi = lo + 2;
    var pts = [], total = 0, i, p;
    for (i = lo; i <= hi; i++) {
      p = Math.exp(-0.5 * Math.pow((i - m) / s, 2));
      pts.push({ offset: i, p: p });
      total += p;
    }
    var curve = [];
    for (i = 0; i < pts.length; i++) {
      curve.push({ date: addDays(anchor, pts[i].offset), p: pts[i].p / total });
    }
    return curve;
  }

  /** Smallest contiguous band around the mode holding WINDOW_MASS of the curve. */
  function windowFrom(curve) {
    if (!curve.length) return null;
    var best = 0, i;
    for (i = 1; i < curve.length; i++) if (curve[i].p > curve[best].p) best = i;
    var lo = best, hi = best, mass = curve[best].p;
    while (mass < WINDOW_MASS && (lo > 0 || hi < curve.length - 1)) {
      var takeLo = lo > 0 && (hi >= curve.length - 1 || curve[lo - 1].p >= curve[hi + 1].p);
      if (takeLo) { lo--; mass += curve[lo].p; }
      else { hi++; mass += curve[hi].p; }
    }
    return [curve[lo].date, curve[hi].date];
  }

  function modeDate(curve) {
    if (!curve.length) return null;
    var best = 0;
    for (var i = 1; i < curve.length; i++) if (curve[i].p > curve[best].p) best = i;
    return curve[best].date;
  }

  // ── ovulation ───────────────────────────────────────────────────────────
  /**
   * A day's temperature as the detector may use it. A reading the user marked
   * disturbed (illness, alcohol, poor sleep…) is kept in the log and left out
   * here — treated as missing, so a baseline with too few clean readings
   * returns no rise rather than a guess.
   */
  function bbtOf(d) {
    if (!d || typeof d.bbt !== "number") return null;
    if (d.bbtMeta && d.bbtMeta.disturbed) return null;
    return d.bbt;
  }

  /**
   * detectOvulation(days, cycleStart, cycleEnd)
   * Scans the inclusive date range [cycleStart, cycleEnd] — that is the whole
   * cycle window, not the bleeding days. Returns null when neither rule fires.
   */
  function detectOvulation(days, cycleStart, cycleEnd) {
    if (!days || !cycleStart || !cycleEnd) return null;
    var span = diffDays(cycleStart, cycleEnd);
    if (span < 0) return null;

    var keys = [], i;
    for (i = 0; i <= span; i++) keys.push(addDays(cycleStart, i));

    // LH: the surge precedes ovulation by roughly a day. The FIRST positive in
    // the window is taken — a cycle with two separate surges is not resolved
    // here, and the date it returns is a single strip's reading, not a fact.
    var lhDate = null;
    for (i = 0; i < keys.length; i++) {
      var d = days[keys[i]];
      if (d && d.lh === "positive") { lhDate = addDays(keys[i], 1); break; }
    }

    // BBT 3-over-6. Ovulation is placed the day before the first high reading.
    var bbtDate = null;
    for (i = BBT_LOOKBACK; i + 2 < keys.length; i++) {
      var back = [], j, dj;
      for (j = i - BBT_LOOKBACK; j < i; j++) {
        dj = days[keys[j]];
        if (bbtOf(dj) !== null) back.push(bbtOf(dj));
      }
      if (back.length < 4) continue;          // too sparse a baseline to call a rise
      var base = Math.max.apply(null, back);

      var highs = [], ok = true;
      for (j = i; j < i + 3; j++) {
        dj = days[keys[j]];
        var bj = bbtOf(dj);
        if (bj === null || bj <= base) { ok = false; break; }
        highs.push(bj);
      }
      if (!ok) continue;
      if (Math.round(highs[2] * 100) - Math.round(base * 100) < BBT_RISE_HUNDREDTHS) continue;
      bbtDate = addDays(keys[i], -1);
      break;
    }

    // The two signals are kept apart. "both" needs them within OV_AGREE_DAYS;
    // otherwise the result is a conflict with NO date, because any single date
    // picked from two that disagree would be one neither signal reported.
    if (lhDate && bbtDate) {
      if (Math.abs(diffDays(lhDate, bbtDate)) <= OV_AGREE_DAYS) {
        return { date: lhDate, source: "both", rule: "lh-positive", lh: lhDate, bbt: bbtDate };
      }
      return { date: null, source: "conflict", rule: "disagree", lh: lhDate, bbt: bbtDate };
    }
    if (lhDate) return { date: lhDate, source: "lh", rule: "lh-positive", lh: lhDate, bbt: null };
    if (bbtDate) return { date: bbtDate, source: "bbt", rule: "3-over-6", lh: null, bbt: bbtDate };
    return null;
  }

  /** Measured luteal length: ovulation to the next period start. */
  function lutealStats(cycles) {
    var obs = [];
    for (var i = 0; i < cycles.length; i++) {
      var c = cycles[i];
      if (!c.ovulation || typeof c.length !== "number" || c._skip || c.excluded) continue;
      var luteal = c.length - diffDays(c.start, c.ovulation);
      if (luteal >= LUTEAL_PLAUSIBLE[0] && luteal <= LUTEAL_PLAUSIBLE[1]) obs.push(luteal);
    }
    if (!obs.length) return null;
    return { mean: mean(obs), sd: pooledSd(obs, WITHIN_SD_LUTEAL), n: obs.length };
  }

  function latestKey(days) {
    var best = null;
    for (var k in days) if (Object.prototype.hasOwnProperty.call(days, k) && (best === null || k > best)) best = k;
    return best;
  }

  /**
   * The open cycle's ovulation: recorded if present, detected from days if not.
   * Detection reads only observations up to opts.asOf (else the newest logged
   * day) — never a fixed horizon, which both missed a late surge in a long
   * cycle and let a backtest read the cycle that came after.
   */
  function currentOvulation(cycles, opts) {
    if (!cycles.length) return null;
    var cur = cycles[cycles.length - 1];
    if (cur.ovulation) {
      return { date: cur.ovulation, source: cur.ovulationSource || "estimated", rule: "recorded" };
    }
    var days = opts && opts.days;
    if (!days) return null;
    var end = (opts && opts.asOf) || latestKey(days);
    if (!end || end < cur.start) return null;
    return detectOvulation(days, cur.start, end);
  }

  /**
   * Closed cycles that carry no recorded ovulation get one derived from their
   * own BBT/LH, bounded by the next start. Without this the luteal predictor
   * only ever ran on data pre-filled by a test generator: ordinary app logs
   * never write cycle.ovulation, so luteal mode activated in 0 of 1,200 fully
   * charted histories.
   */
  function withOvulation(cycles, days) {
    if (!days) return cycles;
    return cycles.map(function (c, i) {
      var next = cycles[i + 1];
      if (c.ovulation || !next || typeof c.length !== "number") return c;
      var det = detectOvulation(days, c.start, addDays(next.start, -1));
      if (!det || !det.date) return c;
      var copy = {};
      for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) copy[k] = c[k];
      copy.ovulation = det.date;
      copy.ovulationSource = det.source;
      return copy;
    });
  }

  /** Distribution over the ovulation date implied by one piece of evidence. */
  function ovulationDist(ev) {
    var spread = ev.rule === "recorded" ? null : OV_SPREAD[ev.source];
    if (!spread) return [{ date: ev.date, p: 1 }];
    var out = [];
    for (var off in spread) {
      if (Object.prototype.hasOwnProperty.call(spread, off)) out.push({ date: addDays(ev.date, parseInt(off, 10)), p: spread[off] });
    }
    return out;
  }
  /** Exact only when two signals agree or the user recorded it; one signal is a spread. */
  function isConfirmed(ev) { return !!ev && (ev.rule === "recorded" || !OV_SPREAD[ev.source]); }

  var SOURCE_WORDS = { both: "temperature and LH", lh: "an LH test", bbt: "the temperature rise" };

  /**
   * What pauses natural-cycle prediction right now, or null. Three causes:
   * an ovulation-suppressing method (from its start date; with no start date
   * it is paused outright, because the alternative is forecasting a pack
   * bleed), an open pregnancy, or an open postpartum span.
   */
  function pausedBy(opts) {
    var c = opts && opts.contraception;
    if (c && OV_SUPPRESSING[c.id] && !(c.start && opts.asOf && c.start > opts.asOf)) {
      return { kind: "contraception", label: c.label || c.id, start: c.start };
    }
    var events = (opts && opts.events) || [];
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.type !== "pregnancy" && e.type !== "postpartum") continue;
      var asOf = opts.asOf || "9999-12-31";
      // `to` is the last day of the span for the FIT (cycles overlapping it are
      // left out), but a span ended today stops pausing today.
      if ((e.from || "0000-01-01") <= asOf && (!e.to || e.to > asOf)) return { kind: "event", type: e.type };
    }
    return null;
  }
  function pausedReason(c) {
    if (c.kind === "event") {
      return "A " + c.type + " span is open in your events, so natural-cycle predictions are paused — " +
        "the cycle this model fits is not the one happening. They resume when the span is ended.";
    }
    return c.label + " is in use, and it suppresses ovulation — so the bleeding on it is a " +
      "scheduled or withdrawal bleed, not the cycle this model fits. Natural-cycle predictions are paused " +
      "rather than showing a date that means something else. They resume when the method in Settings is " +
      "set to NONE." + (c.start ? "" : " (No start date is set, so every logged cycle is treated as affected.)");
  }
  /** Breastfeeding does not pause anything; it widens how much to trust the date. */
  function breastfeeding(opts) {
    var events = (opts && opts.events) || [], asOf = (opts && opts.asOf) || "9999-12-31";
    return events.some(function (e) {
      return e.type === "breastfeeding" && (e.from || "0000-01-01") <= asOf && (!e.to || e.to > asOf);
    });
  }

  // ── prediction ──────────────────────────────────────────────────────────
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  /**
   * predict(cycles, opts) -> Prediction (shape frozen in CONTRACTS.md)
   * opts: { conditions: [], ageBand, days, asOf, contraception, noMae, noRegime }
   * `asOf` is the date the forecast is made on: nothing logged after it is read.
   * Omit it and the newest logged day stands in. `contraception` is
   * { id, label, start } of the current method, or absent.
   * `noMae` is internal — it stops the leave-one-out pass recursing.
   * `noRegime` is internal — tools/score.js uses it to score the engine with
   * change-point detection switched off, which is the only way to show the
   * detector earns its place rather than merely existing.
   */
  function predict(cycles, opts) {
    opts = opts || {};
    cycles = flagCycles(cycles || [], opts.events);

    var prior = priorFor(opts);
    var closed = closedCycles(cycles);
    var lengths = closed.map(function (c) { return c.length; });
    var anchor = anchorOf(cycles);

    var out = {
      mode: "population",
      nextStart: null,
      window: null,
      curve: [],
      n: lengths.length,
      refused: false,
      prior: { mean: prior.mean, sd: prior.sd, source: prior.source },
      regime: { changed: false, since: null, dropped: 0 },
      mae: null,
      asOf: opts.asOf || null,
      expired: false,
      paused: null,
      reason: ""
    };

    var pause = pausedBy(opts);
    if (pause) {
      out.refused = true;
      out.paused = pause.kind;
      out.reason = pausedReason(pause);
      return out;
    }

    if (!anchor) {
      out.refused = true;
      out.reason = "No period start has been logged yet, so there is nothing to predict from.";
      return out;
    }

    if (lengths.length < MIN_CYCLES_TO_PREDICT) {
      out.refused = true;
      var left = cycles.filter(function (c) { return typeof c.length === "number" && (c._skip || c.excluded); }).length;
      out.reason = "Only " + plural(lengths.length, "complete cycle") + " usable" +
        (left ? " (" + plural(left, "other") + " left out — excluded by you, or inside a pregnancy, postpartum or method span)" : " logged") + ". " +
        "The model needs " + MIN_CYCLES_TO_PREDICT +
        " before it will name a date, because below that it would be repeating the population average back to you.";
      return out;
    }

    // Change-point: a superseded regime is dropped, and the card says so.
    var regime = opts.noRegime
      ? { changed: false, index: 0, dropped: 0 }
      : detectRegime(lengths, prior.source === "population" ? REGIME_SIGMAS : REGIME_SIGMAS_IRREGULAR);
    var used = regime.changed ? lengths.slice(regime.index) : lengths;
    if (regime.changed) {
      out.regime = {
        changed: true,
        since: closed[regime.index].start,
        dropped: regime.dropped
      };
    }
    out.n = used.length;

    var post = posterior(used, prior);

    // Luteal mode: a confirmed ovulation in the open cycle plus at least one
    // measured luteal length beats a cycle-length fit, because the follicular
    // phase carries nearly all the variance.
    var ov = currentOvulation(cycles, opts);
    if (ov && !ov.date) ov = null;                  // a conflict is not evidence of a date
    var lut = lutealStats(withOvulation(cycles, opts.days));
    var lpost = (ov && lut) ? posteriorFromStats(lut, LUTEAL_PRIOR) : null;

    // Luteal mode is offered, not assumed. It wins only when it produces the
    // NARROWER predictive distribution — which is the whole of its claim. A
    // person whose luteal phase is not actually stable is better served by
    // their cycle length, and measured on the stress cohort (luteal sd 2.5)
    // that is exactly what happens: 1.5d from cycle length against 2.0d from
    // luteal. Assuming a confirmed ovulation always wins would have shipped
    // the worse prediction to the most regular users.
    if (lpost && lpost.predSd < LUTEAL_MARGIN * post.predSd) {
      out.mode = "luteal";
      out.curve = buildCurve(ov.date, lpost.mean, lpost.predSd);
      out.nextStart = modeDate(out.curve);
      out.window = windowFrom(out.curve);
      out.reason = "Luteal mode: ovulation detected " + ov.date + " by " +
        (SOURCE_WORDS[ov.source] || "your log") +
        ", plus your own luteal length of " + lpost.mean.toFixed(1) + " days from " +
        plural(lut.n, "cycle") + ". That is a tighter fit than your cycle length alone gives (" +
        lpost.predSd.toFixed(1) + " days of spread against " + post.predSd.toFixed(1) + ").";
    } else {
      out.mode = "cycle-length";
      out.curve = buildCurve(anchor, post.mean, post.predSd);
      out.nextStart = modeDate(out.curve);
      out.window = windowFrom(out.curve);
      out.reason = "Cycle-length mode: " + post.mean.toFixed(1) + " days on average from " +
        plural(out.n, "cycle") +
        (out.regime.changed
          ? ", counting only since " + out.regime.since + " — your last " + REGIME_WINDOW +
            " cycles are long enough away from the " + plural(out.regime.dropped, "earlier cycle") +
            " that those are no longer used."
          : ".") +
        (lpost
          ? " Ovulation is detected this cycle, but your luteal length varies more than your cycle length does (" +
            lpost.predSd.toFixed(1) + " days of spread against " + post.predSd.toFixed(1) +
            "), so the cycle-length fit is used instead."
          : "");
    }

    // An earlier forecast stays on the record but stops being a forecast once
    // its window is behind us. Nothing here assumes bleeding has not started —
    // an empty log does not prove that — so the curve is not re-conditioned
    // into a fresh precise date.
    if (breastfeeding(opts)) {
      out.reason += " Breastfeeding is on record, and cycle timing can run longer or less regularly while it lasts — " +
        "treat the window as less certain than it prints.";
    }
    if (opts.asOf && out.window && opts.asOf > out.window[1]) {
      out.expired = true;
      out.reason = "This forecast has expired: its window ended " + plural(diffDays(out.window[1], opts.asOf), "day") +
        " ago and no period start is logged since. If bleeding has started, log it; if it has not, this is a longer " +
        "cycle than the fit allowed for, and the model has no credible new date to offer. " + out.reason;
    }

    if (!opts.noMae) {
      var scored = loo(cycles, opts);
      if (scored.length) out.mae = median(scored.map(function (r) { return Math.abs(r.errorDays); }));
    }
    return out;
  }

  /** Posterior from already-summarised observations (used for luteal). */
  function posteriorFromStats(stats, prior) {
    var varObs = stats.sd * stats.sd;
    var precision = 1 / (prior.sd * prior.sd) + stats.n / varObs;
    var m = (prior.mean / (prior.sd * prior.sd) + stats.n * stats.mean / varObs) / precision;
    var varMean = 1 / precision;
    return { mean: m, meanSd: Math.sqrt(varMean), predSd: Math.sqrt(varObs + varMean) };
  }

  /**
   * Leave-one-out: predict each cycle start from only what was known before it.
   * Internal (Window B) — Epok.Backtest.run is the public face of this.
   */
  function loo(cycles, opts) {
    opts = opts || {};
    cycles = flagCycles(cycles, opts.events);
    var rows = [];
    for (var i = MIN_CYCLES_TO_PREDICT; i < cycles.length - 1; i++) {
      // A cycle the user left out, or one inside a span, is not an outcome the
      // model is being asked to predict.
      if (cycles[i]._skip || cycles[i].excluded) continue;
      // Everything up to and including cycle i, with cycle i reopened — this
      // is exactly the state the app holds the moment before the next period.
      var subset = cycles.slice(0, i + 1);
      var open = cycles[i];
      subset[i] = {
        start: open.start, end: open.end, length: null,
        ovulation: null, ovulationSource: null
      };
      var actual = cycles[i + 1].start;
      // The forecast is made the day before the period arrives, so it may read
      // anything logged up to then and nothing after. Without this bound an LH
      // result dated inside the NEXT cycle changed an earlier forecast from
      // 25 Apr to 18 May.
      var p = predict(subset, {
        conditions: opts.conditions, ageBand: opts.ageBand, days: opts.days,
        asOf: addDays(actual, -1), contraception: opts.contraception, events: opts.events,
        noMae: true, noRegime: opts.noRegime
      });
      if (!p.nextStart || p.paused) continue;
      rows.push({
        start: open.start,
        predicted: p.nextStart,
        actual: actual,
        errorDays: diffDays(actual, p.nextStart),
        window: p.window,
        mode: p.mode
      });
    }
    return rows;
  }

  /** Convolve an ovulation-date distribution with FERTILE_PROFILE, banded per day over [from, to]. */
  function bandsOver(ovDist, from, to) {
    var acc = {};
    for (var k = 0; k < ovDist.length; k++) {
      for (var off in FERTILE_PROFILE) {
        if (!Object.prototype.hasOwnProperty.call(FERTILE_PROFILE, off)) continue;
        var d = addDays(ovDist[k].date, parseInt(off, 10));
        acc[d] = (acc[d] || 0) + ovDist[k].p * FERTILE_PROFILE[off];
      }
    }
    var bands = [];
    for (var t = 0; t <= diffDays(from, to); t++) {
      var key = addDays(from, t);
      var pv = acc[key] || 0;
      bands.push({
        date: key,
        band: pv >= BAND_PEAK ? "peak" : pv >= BAND_ELEVATED ? "elevated" : "low",
        p: Math.round(pv * 1000) / 1000
      });
    }
    return bands;
  }

  // ── history ─────────────────────────────────────────────────────────────
  /**
   * history(cycles, opts) -> one entry per FINISHED cycle (the open one is
   * fertility()'s job): { start, end, ovulation: { date, source }, confirmed, bands }.
   *
   * Ovulation is confirmed when BBT/LH over that cycle fires detectOvulation(),
   * otherwise it is the next start minus the luteal mean, spread over the
   * luteal predictive sd. Looking back is the easier direction — the next
   * start is a fact here, not a forecast — so these estimates are tighter
   * than the open cycle's, and they still say ESTIMATE. No cycle-count floor:
   * the floor guards a forecast, and nothing here is forecast.
   */
  function history(cycles, opts) {
    var days = (opts && opts.days) || {};
    cycles = flagCycles(cycles, opts && opts.events);
    var found = [], conflicts = {}, i;
    for (i = 0; i < cycles.length; i++) {
      var c = cycles[i], next = cycles[i + 1];
      if (!next || typeof c.length !== "number") { found.push(null); continue; }
      if (c.ovulation) { found.push({ date: c.ovulation, source: c.ovulationSource || "recorded", rule: "recorded" }); continue; }
      var det = detectOvulation(days, c.start, addDays(next.start, -1));
      if (det && !det.date) { conflicts[i] = { lh: det.lh, bbt: det.bbt }; det = null; }
      found.push(det ? { date: det.date, source: det.source, rule: det.rule } : null);
    }

    // Charted cycles measure the luteal phase for the uncharted ones.
    var measured = cycles.map(function (c, j) {
      return found[j] ? { start: c.start, length: c.length, ovulation: found[j].date, _skip: c._skip, excluded: c.excluded } : { start: c.start, length: c.length, _skip: c._skip, excluded: c.excluded };
    });
    var lut = lutealStats(measured);
    var luteal = lut ? posteriorFromStats(lut, LUTEAL_PRIOR) : { mean: LUTEAL_PRIOR.mean, predSd: LUTEAL_PRIOR.sd };

    var out = [];
    for (i = 0; i < cycles.length - 1; i++) {
      var cur = cycles[i], nxt = cycles[i + 1];
      if (typeof cur.length !== "number") continue;
      var end = addDays(nxt.start, -1);
      var detected = !!found[i];
      var confirmed = detected && isConfirmed(found[i]);
      var ovDate = detected ? found[i].date : addDays(nxt.start, -Math.round(luteal.mean));
      // A cycle too short to hold its own estimated ovulation gets no guess.
      if (diffDays(cur.start, ovDate) < 1 || diffDays(ovDate, end) < 0) continue;

      var dist;
      if (detected) dist = ovulationDist(found[i]);
      else {
        dist = []; var total = 0, o;
        for (o = -3; o <= 3; o++) {
          var w = Math.exp(-0.5 * Math.pow(o / luteal.predSd, 2));
          dist.push({ date: addDays(ovDate, o), p: w }); total += w;
        }
        dist.forEach(function (x) { x.p /= total; });
      }
      out.push({
        start: cur.start, end: end, confirmed: confirmed,
        ovulation: { date: ovDate, source: detected ? found[i].source : "estimated" },
        conflict: conflicts[i] || null,
        bands: bandsOver(dist, cur.start, end)
      });
    }
    return out;
  }

  // ── fertility ───────────────────────────────────────────────────────────
  /**
   * Per-day probability bands, never a hard window and never a closed one.
   * The ovulation-day uncertainty is convolved with the day-relative
   * conception profile, so an uncertain ovulation produces a flatter, wider,
   * honestly less useful set of bands rather than a confident wrong one.
   */
  function fertility(cycles, opts) {
    opts = opts || {};
    // Worded so it states the limit positively. An earlier draft said the card
    // "never tells you a fertile window has closed" — true, but it put the
    // exact claim people act on into the text, and tools/score.js bans those
    // words outright so a later edit cannot quietly reintroduce the assertion.
    var never = "This is an estimate, not contraception. Calendar-based estimates fail for about 1 in 4 people who rely on them in a year. A low band is not a zero, on any day of your cycle.";

    var pause = pausedBy(opts);
    if (pause) {
      return { bands: [], ovulation: null, confirmed: false, paused: pause.kind,
        reason: pausedReason(pause) + " " + never };
    }
    var p = predict(cycles, { conditions: opts.conditions, ageBand: opts.ageBand, days: opts.days,
      asOf: opts.asOf, contraception: opts.contraception, events: opts.events, noMae: true });
    if (!cycles.length || p.refused) {
      return { bands: [], ovulation: null, confirmed: false,
        reason: "Not enough logged cycles to estimate ovulation. " + never };
    }

    var found = currentOvulation(cycles, opts);
    var conflict = found && !found.date ? found : null;
    var confirmedOv = found && found.date ? found : null;
    var lut = lutealStats(withOvulation(flagCycles(cycles, opts.events), opts.days));
    var lutealMean = lut ? posteriorFromStats(lut, LUTEAL_PRIOR).mean : LUTEAL_PRIOR.mean;

    // Distribution over the ovulation date: either a confirmed single day, or
    // the next-start curve walked back by the luteal length.
    var ovDist = [];
    if (confirmedOv) {
      ovDist = ovulationDist(confirmedOv);
    } else {
      for (var i = 0; i < p.curve.length; i++) {
        ovDist.push({ date: addDays(p.curve[i].date, -Math.round(lutealMean)), p: p.curve[i].p });
      }
    }

    // Cover the whole open cycle so the calendar has a value for every day,
    // including the days after ovulation — which read "low", never "over".
    var from = cycles[cycles.length - 1].start;
    var to = p.nextStart ? addDays(p.nextStart, 2) : addDays(from, 35);
    var bands = bandsOver(ovDist, from, to);

    return {
      bands: bands,
      ovulation: confirmedOv
        ? { date: confirmedOv.date, source: confirmedOv.source }
        : (p.nextStart ? { date: addDays(p.nextStart, -Math.round(lutealMean)), source: "estimated" } : null),
      confirmed: isConfirmed(confirmedOv),
      conflict: conflict ? { lh: conflict.lh, bbt: conflict.bbt } : null,
      reason: (confirmedOv
        ? (isConfirmed(confirmedOv)
            ? "Ovulation confirmed " + confirmedOv.date + " by " + (SOURCE_WORDS[confirmedOv.source] || "your log") + ". "
            : "Ovulation detected around " + confirmedOv.date + " from " + SOURCE_WORDS[confirmedOv.source] +
              " alone — one indirect signal, so the bands are spread across neighbouring days rather than pinned to one. ")
        : conflict
          ? "Your LH test points to " + conflict.lh + " and your temperature rise to " + conflict.bbt +
            ": the signals disagree, so neither is used and ovulation is estimated from your predicted next start. "
          : "Ovulation estimated from your predicted next start, so these bands are as uncertain as that prediction. ") + never
    };
  }

  var Model = {
    predict: predict,
    fertility: fertility,
    history: history,
    detectOvulation: detectOvulation,
    withOvulation: withOvulation,
    flagCycles: flagCycles,
    MODEL_VERSION: MODEL_VERSION,
    lutealStats: lutealStats,
    _loo: loo,                        // internal: Epok.Backtest is the public face
    MIN_CYCLES_TO_PREDICT: MIN_CYCLES_TO_PREDICT,
    WINDOW_MASS: WINDOW_MASS
  };

  // Runs in the browser AND under Node — tools/score.js requires this file.
  if (typeof module !== "undefined" && module.exports) module.exports = Model;
  else (window.Epok = window.Epok || {}).Model = Model;
})();

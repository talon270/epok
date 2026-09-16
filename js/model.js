/* ==========================================================================
   EPOK · MODEL

   Owner: Window B. See PLAN-epok.md § Parallel windows.

     · PRIOR         population 29.3d sd 5.0, shifted by declared conditions, shrinking with real data
     · POSTERIOR     Bayesian over cycle length; refuses to predict below 3 cycles
     · CHANGE-POINT  a superseded regime is dropped from the fit, and the card says so
     · LUTEAL        confirmed ovulation switches to ovulation + measured luteal length
     · HISTORY       per finished cycle: ovulation (confirmed or estimated) and its fertile bands
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
   * Change-point detection. Compares the last REGIME_WINDOW lengths against
   * everything before them; if they differ on both tests, the older block is
   * superseded and dropped from the fit.
   */
  function detectRegime(lengths, sigmas) {
    var none = { changed: false, index: 0, dropped: 0 };
    if (lengths.length < REGIME_WINDOW * 2) return none;

    var cut = lengths.length - REGIME_WINDOW;
    var prior = lengths.slice(0, cut);
    var recent = lengths.slice(cut);
    var dm = Math.abs(mean(recent) - mean(prior));
    var sp = pooledSd(prior, WITHIN_SD_CYCLE), sr = pooledSd(recent, WITHIN_SD_CYCLE);
    var se = Math.sqrt(sp * sp / prior.length + sr * sr / recent.length);

    if (dm >= sigmas * se && dm >= REGIME_MIN_DAYS) {
      return { changed: true, index: cut, dropped: cut };
    }
    return none;
  }

  // ── cycle helpers ───────────────────────────────────────────────────────
  // Returns the closed cycles themselves, not just their lengths: the
  // change-point index has to map back to a real cycle to name the date the
  // new regime started.
  function closedCycles(cycles) {
    var out = [];
    for (var i = 0; i < cycles.length; i++) {
      if (typeof cycles[i].length === "number") out.push(cycles[i]);
    }
    return out;
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

    // LH: the surge precedes ovulation by roughly a day. The first positive is
    // taken; a later one in the same cycle is the same surge read twice.
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
        if (dj && typeof dj.bbt === "number") back.push(dj.bbt);
      }
      if (back.length < 4) continue;          // too sparse a baseline to call a rise
      var base = Math.max.apply(null, back);

      var highs = [], ok = true;
      for (j = i; j < i + 3; j++) {
        dj = days[keys[j]];
        if (!dj || typeof dj.bbt !== "number" || dj.bbt <= base) { ok = false; break; }
        highs.push(dj.bbt);
      }
      if (!ok) continue;
      if (highs[2] - base < BBT_RISE_C) continue;
      bbtDate = addDays(keys[i], -1);
      break;
    }

    if (lhDate && bbtDate) return { date: lhDate, source: "both", rule: "lh-positive" };
    if (lhDate) return { date: lhDate, source: "lh", rule: "lh-positive" };
    if (bbtDate) return { date: bbtDate, source: "bbt", rule: "3-over-6" };
    return null;
  }

  /** Measured luteal length: ovulation to the next period start. */
  function lutealStats(cycles) {
    var obs = [];
    for (var i = 0; i < cycles.length; i++) {
      var c = cycles[i];
      if (!c.ovulation || typeof c.length !== "number") continue;
      var luteal = c.length - diffDays(c.start, c.ovulation);
      if (luteal >= LUTEAL_PLAUSIBLE[0] && luteal <= LUTEAL_PLAUSIBLE[1]) obs.push(luteal);
    }
    if (!obs.length) return null;
    return { mean: mean(obs), sd: pooledSd(obs, WITHIN_SD_LUTEAL), n: obs.length };
  }

  /** The open cycle's ovulation: recorded if present, detected from days if not. */
  function currentOvulation(cycles, opts) {
    if (!cycles.length) return null;
    var cur = cycles[cycles.length - 1];
    if (cur.ovulation) {
      return { date: cur.ovulation, source: cur.ovulationSource || "estimated", rule: "recorded" };
    }
    var days = opts && opts.days;
    if (!days) return null;
    // Scan from this start up to a generous horizon; the cycle is still open,
    // so there is no next start to bound it with.
    return detectOvulation(days, cur.start, addDays(cur.start, 45));
  }

  // ── prediction ──────────────────────────────────────────────────────────
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  /**
   * predict(cycles, opts) -> Prediction (shape frozen in CONTRACTS.md)
   * opts: { conditions: [], ageBand, days, noMae, noRegime }
   * `noMae` is internal — it stops the leave-one-out pass recursing.
   * `noRegime` is internal — tools/score.js uses it to score the engine with
   * change-point detection switched off, which is the only way to show the
   * detector earns its place rather than merely existing.
   */
  function predict(cycles, opts) {
    opts = opts || {};
    cycles = cycles || [];

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
      reason: ""
    };

    if (!anchor) {
      out.refused = true;
      out.reason = "No period start has been logged yet, so there is nothing to predict from.";
      return out;
    }

    if (lengths.length < MIN_CYCLES_TO_PREDICT) {
      out.refused = true;
      out.reason = "Only " + plural(lengths.length, "complete cycle") + " logged. " +
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
    var lut = lutealStats(cycles);
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
      out.reason = "Luteal mode: ovulation confirmed " + ov.date + " by " +
        (ov.source === "both" ? "temperature and LH" : ov.source === "lh" ? "an LH test" : "the temperature rise") +
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
          ? " Ovulation is confirmed this cycle, but your luteal length varies more than your cycle length does (" +
            lpost.predSd.toFixed(1) + " days of spread against " + post.predSd.toFixed(1) +
            "), so the cycle-length fit is used instead."
          : "");
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
    var rows = [];
    for (var i = MIN_CYCLES_TO_PREDICT; i < cycles.length - 1; i++) {
      // Everything up to and including cycle i, with cycle i reopened — this
      // is exactly the state the app holds the moment before the next period.
      var subset = cycles.slice(0, i + 1);
      var open = cycles[i];
      subset[i] = {
        start: open.start, end: open.end, length: null,
        ovulation: null, ovulationSource: null
      };
      var p = predict(subset, {
        conditions: opts.conditions, ageBand: opts.ageBand, days: opts.days,
        noMae: true, noRegime: opts.noRegime
      });
      if (!p.nextStart) continue;
      var actual = cycles[i + 1].start;
      rows.push({
        start: open.start,
        predicted: p.nextStart,
        actual: actual,
        errorDays: diffDays(actual, p.nextStart),
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
    var found = [], i;
    for (i = 0; i < cycles.length; i++) {
      var c = cycles[i], next = cycles[i + 1];
      if (!next || typeof c.length !== "number") { found.push(null); continue; }
      if (c.ovulation) { found.push({ date: c.ovulation, source: c.ovulationSource || "recorded" }); continue; }
      var det = detectOvulation(days, c.start, addDays(next.start, -1));
      found.push(det ? { date: det.date, source: det.source } : null);
    }

    // Charted cycles measure the luteal phase for the uncharted ones.
    var measured = cycles.map(function (c, j) {
      return found[j] ? { start: c.start, length: c.length, ovulation: found[j].date } : { start: c.start, length: c.length };
    });
    var lut = lutealStats(measured);
    var luteal = lut ? posteriorFromStats(lut, LUTEAL_PRIOR) : { mean: LUTEAL_PRIOR.mean, predSd: LUTEAL_PRIOR.sd };

    var out = [];
    for (i = 0; i < cycles.length - 1; i++) {
      var cur = cycles[i], nxt = cycles[i + 1];
      if (typeof cur.length !== "number") continue;
      var end = addDays(nxt.start, -1);
      var confirmed = !!found[i];
      var ovDate = confirmed ? found[i].date : addDays(nxt.start, -Math.round(luteal.mean));
      // A cycle too short to hold its own estimated ovulation gets no guess.
      if (diffDays(cur.start, ovDate) < 1 || diffDays(ovDate, end) < 0) continue;

      var dist;
      if (confirmed) dist = [{ date: ovDate, p: 1 }];
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
        ovulation: { date: ovDate, source: confirmed ? found[i].source : "estimated" },
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

    var p = predict(cycles, { conditions: opts.conditions, ageBand: opts.ageBand, days: opts.days, noMae: true });
    if (!cycles.length || p.refused) {
      return { bands: [], ovulation: null, confirmed: false,
        reason: "Not enough logged cycles to estimate ovulation. " + never };
    }

    var confirmedOv = currentOvulation(cycles, opts);
    var lut = lutealStats(cycles);
    var lutealMean = lut ? posteriorFromStats(lut, LUTEAL_PRIOR).mean : LUTEAL_PRIOR.mean;

    // Distribution over the ovulation date: either a confirmed single day, or
    // the next-start curve walked back by the luteal length.
    var ovDist = [];
    if (confirmedOv) {
      ovDist.push({ date: confirmedOv.date, p: 1 });
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
      confirmed: !!confirmedOv,
      reason: (confirmedOv
        ? "Ovulation confirmed " + confirmedOv.date + ". "
        : "Ovulation estimated from your predicted next start, so these bands are as uncertain as that prediction. ") + never
    };
  }

  var Model = {
    predict: predict,
    fertility: fertility,
    history: history,
    detectOvulation: detectOvulation,
    lutealStats: lutealStats,
    _loo: loo,                        // internal: Epok.Backtest is the public face
    MIN_CYCLES_TO_PREDICT: MIN_CYCLES_TO_PREDICT,
    WINDOW_MASS: WINDOW_MASS
  };

  // Runs in the browser AND under Node — tools/score.js requires this file.
  if (typeof module !== "undefined" && module.exports) module.exports = Model;
  else (window.Epok = window.Epok || {}).Model = Model;
})();

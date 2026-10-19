/* ==========================================================================
   EPOK · VIEW · INSIGHTS

   Owner: Window C. See PLAN-epok.md § Parallel windows.

     · ALWAYS      cycle length history and trend, period length, variability, regularity, the model's own error
     · HEATMAP     tag frequency by cycle-day bucket
     · GATED       correlations only past 3 cycles AND a corrected threshold (A5 guard)
     · RAW COUNTS  'cramps on 8 of your last 9 period days (9 cycles)'. Never a p-value, never "correlated".

   Public namespace: Epok.Views.Insights
   ========================================================================== */

"use strict";

(function () {
  var E = window.Epok;

  // Bonferroni-style correction. A proper per-n critical value needs an
  // inverse-normal-CDF implementation; using a fixed, conservative z instead
  // is the lazy-but-not-liberal choice — z=3.5 clears the ~2.94 that exact
  // Bonferroni needs for 30 simultaneous tests at alpha=0.05, with headroom
  // for a growing tag vocabulary. Erring stricter is the safe direction to be
  // wrong in (A5), the same principle model.js uses for its own priors.
  var CORR_Z_CRITICAL = 3.5;
  var CORR_MIN_CYCLES = 3;      // A5: needs data from at least this many cycles

  function mean(xs) { return xs.reduce(function (a, b) { return a + b; }, 0) / xs.length; }
  function sd(xs) {
    if (xs.length < 2) return null;
    var m = mean(xs), s = 0;
    xs.forEach(function (x) { s += (x - m) * (x - m); });
    return Math.sqrt(s / (xs.length - 1));
  }

  /* Nothing in the app currently writes cycle.end — Window A's B3 built only
     the period-START path (that's the model's one input), and CSV/JSON import
     are the only other writers, so a manually-logged cycle has end===null
     forever. Rather than add a "mark period end" action (a second commit
     point next to period start, with its own undo and consequence text — a
     bigger surface than Insights needs), period length is derived here from
     the actual flow log: the run of consecutive flow-logged days starting at
     the cycle's start. Falls back to the stored end if one exists (import). */
  function periodEnd(c, days) {
    if (c.end) return c.end;
    var key = c.start, last = null;
    for (var i = 0; i < 60; i++) {
      var d = days[key];
      if (!d || !d.flow) break;
      last = key;
      key = E.shiftDay(key, 1);
    }
    return last;
  }

  /* `basis` is the sample the number came from, printed under it every time.
     These tiles are arithmetic on the log, not model output, so none of them
     carries the ESTIMATE tag — that tag means "derived from an estimate", and
     putting it on an average of logged lengths would teach the reader to
     ignore it. */
  function statTile(label, value, unit, basis) {
    return E.el("div", { class: "card stat-tile" }, [
      E.el("p", { class: "micro faint", text: label }),
      E.el("p", { class: "data" }, [
        value == null ? "—" : String(value),
        unit ? E.el("span", { class: "unit", text: " " + unit }) : null
      ]),
      basis && value != null ? E.el("p", { class: "micro faint", text: basis }) : null
    ]);
  }

  function count(n, word) { return n + " " + word + (n === 1 ? "" : "S"); }

  /* ==================================================================
     STATS
     ================================================================== */

  // Below this many settled saved forecasts the error shown is the backtest's
  // reconstruction, and the card says so. UNSOURCED threshold: six is roughly
  // the number of cycles the model's own prior takes to fade.
  var SAVED_MIN = 6;
  function settled(s) {
    return (s.predictions || []).filter(function (p) { return p.actual != null && !p.void; });
  }
  function savedSettled(s) { return settled(s).length; }

  /* ==================================================================
     FORECAST HISTORY — forecasts epok actually showed, settled against
     what happened. Distinct from the backtest above, which rebuilds them.
     ================================================================== */

  function forecastHistorySection() {
    var s = E.Store.get();
    var preds = (s.predictions || []).filter(function (p) { return !p.void; });
    if (!preds.length) {
      return group("FORECAST HISTORY", [E.el("p", { class: "small dim", text:
        "No forecast has been saved yet. Once a cycle has one, each version is kept here with the date it was made, " +
        "and settled against the real start when it arrives." })]);
    }
    var done = settled(s);
    var summary;
    if (done.length >= SAVED_MIN) {
      var errs = done.map(function (p) { return Math.abs(p.errorDays); }).sort(function (a, b) { return a - b; });
      var med = errs.length % 2 ? errs[errs.length >> 1] : (errs[(errs.length >> 1) - 1] + errs[errs.length >> 1]) / 2;
      var hit = done.filter(function (p) { return p.inWindow; }).length;
      summary = "Measured on " + done.length + " forecasts epok actually showed: median error " + med + " day" +
        (med === 1 ? "" : "s") + ", " + hit + " of " + done.length + " starts inside the printed window.";
    } else {
      summary = "Only " + done.length + " saved forecast" + (done.length === 1 ? " has" : "s have") + " been settled so far. Until there are " +
        SAVED_MIN + ", the MEASURED ERROR above is reconstructed from your history, not from forecasts you were shown.";
    }

    var head = E.el("tr", {}, ["MADE", "FOR", "ACTUAL", "LEAD", "ERROR", "WINDOW", "WHY IT CHANGED"].map(function (h) {
      return E.el("th", { text: h });
    }));
    var rows = preds.slice().reverse().slice(0, 24).map(function (p) {
      var sameAnchor = preds.filter(function (q) { return q.anchor === p.anchor && q.madeOn <= p.madeOn && q !== p; });
      var prev = sameAnchor[sameAnchor.length - 1];
      var why = "first forecast for this cycle";
      if (prev) {
        var bits = [];
        var shift = E.daysBetween(prev.nextStart, p.nextStart);
        if (shift) bits.push("moved " + (shift > 0 ? "+" : "") + shift + " d");
        if (prev.mode !== p.mode) bits.push(prev.mode + " → " + p.mode);
        if (prev.n !== p.n) bits.push("fit on " + p.n + " cycles, was " + prev.n);
        if (prev.modelVersion !== p.modelVersion) bits.push("engine v" + prev.modelVersion + " → v" + p.modelVersion);
        why = bits.join("; ") || "window changed";
      }
      var err = p.actual == null ? "—" : (p.errorDays > 0 ? "+" : "") + p.errorDays + " d";
      return E.el("tr", {}, [
        E.el("td", { text: E.prettyDate(p.madeOn) }), E.el("td", { text: E.prettyDate(p.nextStart) }),
        E.el("td", { text: p.actual ? E.prettyDate(p.actual) : "PENDING" }),
        E.el("td", { text: p.actual ? E.daysBetween(p.madeOn, p.actual) + " d" : "—" }),
        E.el("td", { text: err }),
        E.el("td", { text: p.actual == null ? "—" : p.inWindow ? "HIT" : "MISS" }),
        E.el("td", { text: why })
      ]);
    });
    return group("FORECAST HISTORY", [
      E.el("p", { class: "small", text: summary }),
      E.el("p", { class: "small faint", text: "ERROR is forecast minus actual: positive means the forecast was late. LEAD is how many days before the real start the forecast was made." }),
      E.el("div", { style: "overflow-x:auto" }, [E.el("table", { class: "report-table" }, [head].concat(rows))])
    ]);
  }

  function statsSection(cycles, days) {
    var closed = cycles.filter(function (c) { return c.length != null; });
    var lengths = closed.map(function (c) { return c.length; });
    var ends = cycles.map(function (c) { return periodEnd(c, days); });
    var periodLengths = [];
    cycles.forEach(function (c, i) { if (ends[i]) periodLengths.push(E.daysBetween(c.start, ends[i]) + 1); });

    var M = window.Epok.Model;
    var s = E.Store.get();
    var mae = null, scored = 0;
    if (M && cycles.length) {
      var opts = E.Store.modelOpts();
      mae = M.predict(cycles, opts).mae;
      if (mae != null && E.Backtest) scored = E.Backtest.run(cycles, opts).n;
    }

    return group("OVERVIEW", [
      E.el("div", { class: "stat-grid" }, [
        statTile("CYCLES LOGGED", cycles.length, null, null),
        statTile("AVG CYCLE LENGTH", lengths.length ? Math.round(mean(lengths) * 10) / 10 : null, "DAYS",
                 "FROM " + count(lengths.length, "COMPLETE CYCLE")),
        statTile("REGULARITY (SD)", lengths.length >= 2 ? Math.round(sd(lengths) * 10) / 10 : null, "DAYS",
                 "FROM " + count(lengths.length, "COMPLETE CYCLE")),
        statTile("AVG PERIOD LENGTH", periodLengths.length ? Math.round(mean(periodLengths) * 10) / 10 : null, "DAYS",
                 "FROM " + count(periodLengths.length, "PERIOD")),
        statTile("MEASURED ERROR", mae, "DAYS", "MEDIAN OVER " + count(scored, "PAST PREDICTION") +
                 (savedSettled(s) >= SAVED_MIN ? "" : " · RECONSTRUCTED FROM YOUR LOG"))
      ])
    ]);
  }

  /* ==================================================================
     CYCLE LENGTH TREND
     ================================================================== */

  function trendSection(cycles) {
    var closed = cycles.filter(function (c) { return c.length != null; });
    if (!closed.length) {
      return group("CYCLE LENGTH", [E.el("p", { class: "small dim", text: "Nothing to show until a first full cycle is logged." })]);
    }
    var max = Math.max.apply(null, closed.map(function (c) { return c.length; }).concat([35]));
    var rows = closed.map(function (c) {
      var pct = Math.max(4, Math.round((c.length / max) * 100));
      return E.el("div", { class: "bar-row" }, [
        E.el("span", { class: "bar-row__label", text: E.prettyDate(c.start) }),
        E.el("span", { class: "bar-row__track" }, [
          E.el("span", { class: "bar-row__fill", style: "width:" + pct + "%" })
        ]),
        E.el("span", { class: "bar-row__value", text: c.length + "d" })
      ]);
    });
    return group("CYCLE LENGTH", rows);
  }

  /* ==================================================================
     SYMPTOM HEATMAP BY CYCLE DAY
     ================================================================== */

  var BUCKETS = [[1, 5], [6, 10], [11, 15], [16, 20], [21, 25], [26, 30], [31, 999]];
  function bucketLabel(b) { return b[1] === 999 ? "31+" : b[0] + "–" + b[1]; }
  function bucketIndex(cycleDay) {
    for (var i = 0; i < BUCKETS.length; i++) if (cycleDay >= BUCKETS[i][0] && cycleDay <= BUCKETS[i][1]) return i;
    return BUCKETS.length - 1;
  }

  function cycleDayOf(cycles, key) {
    for (var i = cycles.length - 1; i >= 0; i--) {
      if (E.daysBetween(cycles[i].start, key) >= 0) return E.daysBetween(cycles[i].start, key) + 1;
    }
    return null;
  }

  function heatmapSection(cycles, days) {
    var counts = {}; // tagId -> [bucket counts]
    Object.keys(days).forEach(function (key) {
      var d = days[key];
      if (!d.tags || !d.tags.length) return;
      var cd = cycleDayOf(cycles, key);
      if (cd == null) return;
      var bi = bucketIndex(cd);
      d.tags.forEach(function (t) {
        counts[t] = counts[t] || new Array(BUCKETS.length).fill(0);
        counts[t][bi]++;
      });
    });

    var tagIds = Object.keys(counts);
    if (!tagIds.length) {
      return group("SYMPTOMS BY CYCLE DAY", [E.el("p", { class: "small dim", text: "Log a tag on a few days to see when it clusters in your cycle." })]);
    }

    var labelById = {};
    window.Epok.Tags.ALL.concat(E.Store.get().customTags || []).forEach(function (t) { labelById[t.id] = t.label; });
    var maxCount = 1;
    tagIds.forEach(function (id) { counts[id].forEach(function (c) { if (c > maxCount) maxCount = c; }); });

    var grid = E.el("div", { class: "heatmap", style: "grid-template-columns:120px repeat(" + BUCKETS.length + ",1fr)" });
    grid.appendChild(E.el("div", { class: "heatmap-cell" }));
    BUCKETS.forEach(function (b) { grid.appendChild(E.el("div", { class: "heatmap-cell micro faint", text: bucketLabel(b) })); });

    tagIds.forEach(function (id) {
      grid.appendChild(E.el("div", { class: "heatmap-cell small", text: labelById[id] || id }));
      counts[id].forEach(function (c) {
        var opacity = c === 0 ? 0 : 0.15 + 0.85 * (c / maxCount);
        grid.appendChild(E.el("div", { class: "heatmap-cell", style: "position:relative" }, [
          c ? E.el("div", { style: "position:absolute;inset:0;background:var(--accent);opacity:" + opacity }) : null,
          E.el("span", { style: "position:relative", text: c || "" })
        ]));
      });
    });

    return group("SYMPTOMS BY CYCLE DAY", [grid]);
  }

  /* ==================================================================
     TEMPERATURE (B19) — Epok.el() only creates HTML elements, so a chart
     needs its own createElementNS helper; this stays local to this file.
     ================================================================== */

  var SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, children) {
    var n = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function bbtSection(cycles, days) {
    if (!cycles.length) return null;
    var cur = cycles[cycles.length - 1];
    var end = cur.end || E.today();
    var span = E.daysBetween(cur.start, end);
    if (span < 0) return null;

    var points = [];
    for (var i = 0; i <= Math.min(span, 45); i++) {
      var key = E.shiftDay(cur.start, i);
      var d = days[key];
      if (d && typeof d.bbt === "number") points.push({ i: i, v: d.bbt });
    }
    if (points.length < 3) {
      return group("TEMPERATURE", [E.el("p", { class: "small dim", text: "Log a temperature on a few days this cycle to see a chart here." })]);
    }

    var vals = points.map(function (p) { return p.v; });
    var min = Math.min.apply(null, vals) - 0.1, max = Math.max.apply(null, vals) + 0.1;
    var w = 600, h = 140, pad = 20;
    var xSpan = Math.max(span, 1);
    function x(i) { return pad + (i / xSpan) * (w - 2 * pad); }
    function y(v) { return h - pad - ((v - min) / (max - min)) * (h - 2 * pad); }

    var pathD = points.map(function (p, idx) {
      return (idx === 0 ? "M" : "L") + x(p.i).toFixed(1) + "," + y(p.v).toFixed(1);
    }).join(" ");

    var M = window.Epok.Model;
    var ov = M ? M.detectOvulation(days, cur.start, end) : null;
    if (ov && !ov.date) ov = null;        // LH and temperature disagree: no single day to mark

    var children = [svgEl("path", { d: pathD, fill: "none", stroke: "var(--accent)", "stroke-width": "2" })];
    if (ov) {
      var oi = E.daysBetween(cur.start, ov.date);
      children.push(svgEl("line", {
        x1: String(x(oi)), x2: String(x(oi)), y1: "0", y2: String(h),
        stroke: "var(--estimate)", "stroke-width": "1", "stroke-dasharray": "3,3"
      }));
    }
    points.forEach(function (p) {
      children.push(svgEl("circle", { cx: String(x(p.i)), cy: String(y(p.v)), r: "2.5", fill: "var(--accent)" }));
    });

    var svg = svgEl("svg", { viewBox: "0 0 " + w + " " + h, width: "100%", height: "140", role: "img", "aria-label": "Temperature chart" }, children);
    var wrap = E.el("div", {});
    wrap.appendChild(svg);

    return group("TEMPERATURE", [
      wrap,
      ov
        ? E.el("p", { class: "small dim" }, [
            E.el("span", { class: "est", text: "DETECTED" }),
            " Shift " + E.prettyDate(ov.date) + " (" + (ov.rule === "3-over-6" ? "3-over-6 rule" : "LH positive") + ")."
          ])
        : E.el("p", { class: "small faint", text: "No ovulation shift detected yet this cycle." })
    ]);
  }

  /* ==================================================================
     GATED CORRELATIONS (B12 / A5 guard)
     ================================================================== */

  function correlationsSection(cycles, days) {
    var withEnd = cycles.map(function (c) { return { c: c, end: periodEnd(c, days) }; })
                         .filter(function (x) { return x.end; });
    if (withEnd.length < CORR_MIN_CYCLES) {
      return group("PATTERNS", [E.el("p", { class: "small dim", text:
        "Needs at least " + CORR_MIN_CYCLES + " logged periods before it looks for a pattern worth surfacing." })]);
    }

    var periodDayKeys = {}; // key -> cycle index, for "which cycles" counting
    withEnd.forEach(function (x, i) {
      var span = E.daysBetween(x.c.start, x.end);
      for (var k = 0; k <= span; k++) periodDayKeys[E.shiftDay(x.c.start, k)] = i;
    });
    var periodKeys = Object.keys(periodDayKeys);
    var nonPeriodKeys = Object.keys(days).filter(function (k) { return !(k in periodDayKeys); });

    // A day only counts as "no <tag>" if the user was actually looking at that
    // kind of symptom: a tag in the same category on that day, or an explicit
    // check-in. A BBT-only day, or a day with only a mood tag, says nothing
    // about cramps — counting it as a cramp-free day made the same cramps
    // appear or vanish depending on which unrelated tags had been logged.
    // Both groups use the same rule; the period group used to count every
    // period day while the other group counted only tagged ones.
    var tags = window.Epok.Tags.visible();
    var catOf = {};
    window.Epok.Tags.ALL.concat(tags).forEach(function (t) { catOf[t.id] = t.category; });
    function observed(d, cat) {
      if (!d) return false;
      if (d.checkin) return true;
      return (d.tags || []).some(function (id) { return catOf[id] === cat; });
    }
    var rows = [];

    tags.forEach(function (t) {
      var id = t.id, periodHits = 0, periodTotal = 0, cyclesWithTag = {};
      periodKeys.forEach(function (k) {
        if (!observed(days[k], t.category)) return;
        periodTotal++;
        if (days[k].tags.indexOf(id) >= 0) { periodHits++; cyclesWithTag[periodDayKeys[k]] = true; }
      });
      var nCyclesWithTag = Object.keys(cyclesWithTag).length;
      if (nCyclesWithTag < CORR_MIN_CYCLES) return;

      var nonHits = 0, nonTotal = 0;
      nonPeriodKeys.forEach(function (k) {
        if (!observed(days[k], t.category)) return;
        nonTotal++;
        if (days[k].tags.indexOf(id) >= 0) nonHits++;
      });
      if (periodTotal < 1 || nonTotal < 1) return;

      var p1 = periodHits / periodTotal, p2 = nonHits / nonTotal;
      var pooled = (periodHits + nonHits) / (periodTotal + nonTotal);
      var se = Math.sqrt(pooled * (1 - pooled) * (1 / periodTotal + 1 / nonTotal));
      if (se === 0) return;
      var z = (p1 - p2) / se;
      if (z < CORR_Z_CRITICAL) return;

      var rated = [];
      periodKeys.forEach(function (k) {
        var r = days[k] && days[k].severity && days[k].severity[id];
        if (r) rated.push(r);
      });
      var sevText = rated.length
        ? " Your own rating averaged " + (rated.reduce(function (a, b) { return a + b; }, 0) / rated.length).toFixed(1) +
          " of 3 over " + rated.length + " rated day" + (rated.length === 1 ? "" : "s") + "."
        : "";
      rows.push({ z: z, text: t.label + " on " + periodHits + " of the " + periodTotal +
        " period days you checked for it (" + withEnd.length + " cycle" + (withEnd.length === 1 ? "" : "s") + ")." + sevText });
    });

    if (!rows.length) {
      return group("PATTERNS", [E.el("p", { class: "small dim", text: "Nothing yet clears the noise threshold — that's expected for most logs, and is not the same as nothing being there." })]);
    }
    rows.sort(function (a, b) { return b.z - a.z; });
    return group("PATTERNS", rows.map(function (r) {
      return E.el("p", { class: "corr-row", text: r.text });
    }));
  }

  function group(title, children) {
    return E.el("div", { class: "settings-group" }, [E.el("h2", { text: title })].concat(children));
  }

  /* ==================================================================
     RENDER
     ================================================================== */

  function render() {
    var cycles = E.Store.cycles();
    var days = E.Store.get().days;

    if (!cycles.length) {
      return E.el("div", {}, [
        E.el("h1", { text: "INSIGHTS", style: "margin-bottom:var(--s4)" }),
        E.el("section", { class: "card" }, [
          E.el("p", { class: "dim", text: "Nothing logged yet. Mark a period start on Today to begin." })
        ])
      ]);
    }

    return E.el("div", {}, [
      E.el("h1", { text: "INSIGHTS", style: "margin-bottom:var(--s4)" }),
      statsSection(cycles, days),
      forecastHistorySection(),
      trendSection(cycles),
      bbtSection(cycles, days),
      heatmapSection(cycles, days),
      correlationsSection(cycles, days)
    ]);
  }

  var Insights = { id: "insights", title: "INSIGHTS", render: render };
  window.Epok = window.Epok || {};
  window.Epok.Views = window.Epok.Views || {};

  window.Epok.Views.Insights = Insights;
})();

/* ==========================================================================
   EPOK · VIEW · REPORT

   Owner: Window C. See PLAN-epok.md § Parallel windows; extended per
   PLAN-features-sync.md A6.

     · ONE PAGE    print stylesheet, no PDF library
     · RANGE       3 / 6 / 12 months, everything, or two dates. The range is
                   printed on the page, and every figure is computed inside it
     · CONTENT     cycles, bleeding, prolonged-bleeding episodes, events,
                   symptoms with the user's own severity, how complete the log is
     · HEADER      date range and the words 'self-reported'
     · DERIVED     ovulation dates come from Epok.Model.detectOvulation() against logged BBT/LH —
                   there is no stored "ovulation" write path any more than there is for cycle.end
     · PHASES      placed from a detected ovulation where one exists, and by the
                   average-cycle midpoint where it does not — and the page says how
                   many symptom days used which

   Public namespace: Epok.Views.Report
   ========================================================================== */

"use strict";

(function () {
  var E = window.Epok;

  // Flagged, not diagnosed. Whether a long bleed or a long cycle matters is a
  // clinician's call; the page only makes sure it is not missed. UNSOURCED.
  var PROLONGED_BLEED_DAYS = 7;
  var LONG_CYCLE_DAYS = 45;
  var MAX_ROWS = 24;

  // Module-local, not persisted: a report is opened to be printed, not kept.
  var range = { preset: 12, from: "", to: "" };   // preset: 3 | 6 | 12 | "all" | "custom"

  function mean(xs) { return xs.reduce(function (a, b) { return a + b; }, 0) / xs.length; }
  function sd(xs) {
    if (xs.length < 2) return null;
    var m = mean(xs), s = 0;
    xs.forEach(function (x) { s += (x - m) * (x - m); });
    return Math.sqrt(s / (xs.length - 1));
  }
  function pct(n, d) { return d ? Math.round(100 * n / d) + "%" : "—"; }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }

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

  /* The window the report covers, as { from, to } keys. */
  function bounds(cycles, days) {
    var today = E.today();
    if (range.preset === "custom") {
      return { from: range.from || "0000-01-01", to: range.to || today };
    }
    if (range.preset === "all") {
      var first = Object.keys(days).sort()[0] || (cycles[0] && cycles[0].start) || today;
      return { from: cycles[0] && cycles[0].start < first ? cycles[0].start : first, to: today };
    }
    var d = new Date(); d.setMonth(d.getMonth() - range.preset);
    var from = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    return { from: from, to: today };
  }

  function inRange(key, b) { return key >= b.from && key <= b.to; }

  /* Bleeding episodes: runs of consecutive days with any logged flow. */
  function bleedEpisodes(days, b) {
    var keys = Object.keys(days).filter(function (k) { return days[k] && days[k].flow && inRange(k, b); }).sort();
    var out = [], cur = null;
    keys.forEach(function (k) {
      if (cur && E.daysBetween(cur.last, k) === 1) { cur.last = k; cur.n++; }
      else { cur = { first: k, last: k, n: 1 }; out.push(cur); }
    });
    return out;
  }

  function render() {
    var s = E.Store.get();
    var allCycles = E.Store.cycles();
    var days = s.days;

    if (!allCycles.length) {
      return E.el("div", {}, [
        E.el("h1", { text: "REPORT", style: "margin-bottom:var(--s4)" }),
        E.el("section", { class: "card" }, [E.el("p", { class: "dim", text: "Nothing logged yet — there is no history to report." })])
      ]);
    }

    var M = window.Epok.Model;
    var b = bounds(allCycles, days);
    var flags = M && M.flagCycles ? M.flagCycles(allCycles, s.events) : allCycles;
    var idxs = [];
    allCycles.forEach(function (c, i) { if (inRange(c.start, b)) idxs.push(i); });
    var cycles = idxs.map(function (i) { return allCycles[i]; });

    // ── summary ────────────────────────────────────────────────────────
    var lengths = idxs.filter(function (i) { return allCycles[i].length != null; }).map(function (i) { return allCycles[i].length; });
    var avgLen = lengths.length ? mean(lengths) : 29.3;
    var periodLens = [];
    cycles.forEach(function (c) { var e = periodEnd(c, days); if (e) periodLens.push(E.daysBetween(c.start, e) + 1); });

    var opts = E.Store.modelOpts();
    var mae = M ? M.predict(allCycles, opts).mae : null;
    var scored = (mae != null && E.Backtest) ? E.Backtest.run(allCycles, opts).n : 0;
    var savedDone = (s.predictions || []).filter(function (p) { return p.actual != null && !p.void; });

    // ── completeness ───────────────────────────────────────────────────
    var span = Math.max(1, E.daysBetween(b.from, b.to) + 1);
    var withBbt = 0, withLh = 0, watched = 0, disturbed = 0, impactBad = 0;
    Object.keys(days).forEach(function (k) {
      if (!inRange(k, b)) return;
      var d = days[k];
      if (typeof d.bbt === "number") { withBbt++; if (d.bbtMeta && d.bbtMeta.disturbed) disturbed++; }
      if (d.lh) withLh++;
      if (d.checkin || (d.tags && d.tags.length)) watched++;
      if (d.impact === "a-lot") impactBad++;
    });

    // ── cycles table ───────────────────────────────────────────────────
    var recent = idxs.slice(-MAX_ROWS).reverse();
    var ovByIdx = {};
    var rows = recent.map(function (i) {
      var c = allCycles[i], next = allCycles[i + 1];
      var pEnd = periodEnd(c, days);
      // Detection needs the WHOLE cycle span, not the bleeding days. The open
      // cycle is bounded by today: nothing after it has been logged.
      var cycleEnd = next ? E.shiftDay(next.start, -1) : E.today();
      var ov = M ? M.detectOvulation(days, c.start, cycleEnd) : null;
      ovByIdx[i] = ov && ov.date ? ov.date : (c.ovulation || null);
      var notes = [];
      if (c.excluded) notes.push("left out of the fit by you");
      else if (flags[i] && flags[i]._skip) notes.push("inside a pregnancy / postpartum / method span");
      if (c.length != null && c.length > LONG_CYCLE_DAYS) notes.push("long cycle");
      if (c.source === "flow") notes.push("start inferred from flow log");
      return E.el("tr", {}, [
        E.el("td", { text: E.prettyDate(c.start) }),
        E.el("td", { text: c.length != null ? c.length + "d" : "—" }),
        E.el("td", { text: pEnd ? (E.daysBetween(c.start, pEnd) + 1) + "d" : "—" }),
        E.el("td", { text: !ov ? "—" : ov.date ? E.prettyDate(ov.date) + " (" + ov.source + ")"
          : "LH " + E.prettyDate(ov.lh) + " vs temp " + E.prettyDate(ov.bbt) + " (signals disagree)" }),
        E.el("td", { text: notes.join("; ") || "" })
      ]);
    });

    // ── prolonged bleeding ─────────────────────────────────────────────
    var episodes = bleedEpisodes(days, b);
    var prolonged = episodes.filter(function (e) { return e.n > PROLONGED_BLEED_DAYS; });

    // ── events ─────────────────────────────────────────────────────────
    var C = window.Epok.Contraception;
    var events = (s.events || []).filter(function (e) {
      return (e.to || "9999-12-31") >= b.from && (e.from || "0000-01-01") <= b.to;
    });
    var eventLines = events.map(function (e) {
      var what = e.type === "contraception" && C && C.BY_ID[e.method] ? "method — " + C.BY_ID[e.method].label.toLowerCase() : e.type;
      return E.el("li", { text: what + ": " + (e.from ? E.prettyDate(e.from) : "start unknown") + " → " +
        (e.to ? E.prettyDate(e.to) : "ongoing") + (e.note ? " (" + e.note + ")" : "") });
    });

    // ── symptoms, phase by detected ovulation where there is one ───────
    var counts = {}, byDetected = 0, byMidpoint = 0;
    function cycleIndexOf(key) {
      for (var i = allCycles.length - 1; i >= 0; i--) if (E.daysBetween(allCycles[i].start, key) >= 0) return i;
      return -1;
    }
    function ovFor(i) {
      if (!(i in ovByIdx)) {
        var c = allCycles[i], next = allCycles[i + 1];
        var det = M ? M.detectOvulation(days, c.start, next ? E.shiftDay(next.start, -1) : E.today()) : null;
        ovByIdx[i] = det && det.date ? det.date : (c.ovulation || null);
      }
      return ovByIdx[i];
    }
    Object.keys(days).forEach(function (key) {
      var d = days[key];
      if (!inRange(key, b) || !d.tags || !d.tags.length) return;
      var i = cycleIndexOf(key);
      if (i < 0) return;
      var c = allCycles[i], day = E.daysBetween(c.start, key) + 1;
      var pe = periodEnd(c, days), periodLen = pe ? E.daysBetween(c.start, pe) + 1 : 5;
      var ov = ovFor(i), phase;
      if (day <= periodLen) phase = "MENSTRUAL";
      else if (ov) { phase = key < ov ? "FOLLICULAR" : "LUTEAL"; byDetected++; }
      else { phase = day <= avgLen / 2 ? "FOLLICULAR" : "LUTEAL"; byMidpoint++; }
      d.tags.forEach(function (t) {
        counts[t] = counts[t] || { total: 0, byPhase: {}, rated: [] };
        counts[t].total++;
        counts[t].byPhase[phase] = (counts[t].byPhase[phase] || 0) + 1;
        if (d.severity && d.severity[t]) counts[t].rated.push(d.severity[t]);
      });
    });
    var labelById = {};
    window.Epok.Tags.ALL.concat(s.customTags || []).forEach(function (t) { labelById[t.id] = t.label; });
    var topTags = Object.keys(counts).sort(function (a, c2) { return counts[c2].total - counts[a].total; }).slice(0, 8);
    var symptomRows = topTags.map(function (id) {
      var c = counts[id];
      var topPhase = Object.keys(c.byPhase).sort(function (a, c2) { return c.byPhase[c2] - c.byPhase[a]; })[0];
      return E.el("tr", {}, [
        E.el("td", { text: labelById[id] || id }),
        E.el("td", { text: String(c.total) }),
        E.el("td", { text: c.rated.length ? mean(c.rated).toFixed(1) + " of 3 (" + plural(c.rated.length, "rated day") + ")" : "not rated" }),
        E.el("td", { text: topPhase + " (" + c.byPhase[topPhase] + "/" + c.total + ")" })
      ]);
    });

    // ── controls (not printed) ─────────────────────────────────────────
    function presetChip(label, v) {
      return E.el("button", { type: "button", class: "chip", "aria-pressed": range.preset === v ? "true" : "false", text: label,
        onclick: function () { range.preset = v; E.refresh(); } });
    }
    var from = E.el("input", { type: "date", class: "text-input", value: range.from || b.from, "aria-label": "Report from",
      onchange: function (e) { range.preset = "custom"; range.from = e.target.value; E.refresh(); } });
    var to = E.el("input", { type: "date", class: "text-input", value: range.to || b.to, "aria-label": "Report to",
      onchange: function (e) { range.preset = "custom"; range.to = e.target.value; E.refresh(); } });
    var controls = E.el("div", { class: "card no-print" }, [
      E.el("p", { class: "micro", text: "RANGE" }),
      E.el("div", { class: "row" }, [presetChip("3 MONTHS", 3), presetChip("6 MONTHS", 6), presetChip("12 MONTHS", 12), presetChip("EVERYTHING", "all"), from, to])
    ]);

    var errLine = mae == null ? "not enough history"
      : "median ±" + mae + "d over " + scored + " past prediction" + (scored === 1 ? "" : "s") +
        (savedDone.length >= 6 ? " (reconstructed; " + savedDone.length + " saved forecasts also settled)"
                               : " (reconstructed from the log — fewer than 6 saved forecasts have settled)");

    var page = E.el("section", { class: "report-page" }, [
      E.el("div", { class: "card__head" }, [
        E.el("div", {}, [
          E.el("h1", { text: "EPOK · CYCLE REPORT" }),
          E.el("p", { class: "small dim", text: E.prettyDate(b.from) + " – " + E.prettyDate(b.to) + " · SELF-REPORTED" })
        ]),
        E.el("button", { type: "button", class: "btn no-print", text: "PRINT", onclick: function () { window.print(); } })
      ]),

      E.el("h2", { text: "SUMMARY" }),
      E.el("p", { class: "small", text:
        "Cycles started in this range: " + cycles.length +
        " · Avg cycle length: " + (lengths.length ? avgLen.toFixed(1) + "d (" + lengths.length + " complete)" : "—") +
        " · Variability (SD): " + (lengths.length >= 2 ? sd(lengths).toFixed(1) + "d" : "—") +
        " · Avg period length: " + (periodLens.length ? mean(periodLens).toFixed(1) + "d (" + periodLens.length + " periods)" : "—") +
        " · Prediction error: " + errLine }),

      E.el("hr", { class: "rule" }),
      E.el("h2", { text: "HOW COMPLETE THIS LOG IS" }),
      E.el("p", { class: "small", text:
        "Over " + plural(span, "day") + ": temperature on " + pct(withBbt, span) + " (" + withBbt +
        (disturbed ? ", " + disturbed + " marked disturbed" : "") + ") · LH tests on " + pct(withLh, span) +
        " · symptoms checked in or tagged on " + pct(watched, span) + (impactBad ? " · " + plural(impactBad, "day") + " affected \"a lot\"" : "") + "." }),
      E.el("p", { class: "small faint", text: "A low figure means the matching pattern, or its absence, cannot be read from this page." }),

      E.el("hr", { class: "rule" }),
      E.el("h2", { text: "CYCLES" + (idxs.length > MAX_ROWS ? " (LATEST " + MAX_ROWS + " OF " + idxs.length + ")" : "") }),
      rows.length ? E.el("table", {}, [
        E.el("thead", {}, [E.el("tr", {}, [
          E.el("th", { text: "START" }), E.el("th", { text: "LENGTH" }),
          E.el("th", { text: "PERIOD LENGTH" }), E.el("th", { text: "OVULATION" }), E.el("th", { text: "NOTES" })
        ])]),
        E.el("tbody", {}, rows)
      ]) : E.el("p", { class: "small dim", text: "No cycle starts in this range." }),

      E.el("hr", { class: "rule" }),
      E.el("h2", { text: "BLEEDING" }),
      E.el("p", { class: "small", text:
        plural(episodes.length, "bleeding episode") + " logged; " + prolonged.length + " lasted more than " + PROLONGED_BLEED_DAYS +
        " days" + (prolonged.length ? ": " + prolonged.map(function (e) {
          return E.prettyDate(e.first) + " (" + e.n + " days)";
        }).join(", ") : "") + "." }),
      E.el("p", { class: "small faint", text: "An episode is a run of consecutive days with any flow logged, spotting included. The " +
        PROLONGED_BLEED_DAYS + "-day line only flags it; whether it matters is for a clinician." }),

      E.el("hr", { class: "rule" }),
      E.el("h2", { text: "EVENTS" }),
      eventLines.length ? E.el("ul", {}, eventLines) : E.el("p", { class: "small dim", text: "None recorded in this range." }),

      E.el("hr", { class: "rule" }),
      E.el("h2", { text: "SYMPTOMS" }),
      symptomRows.length
        ? E.el("div", {}, [
            E.el("table", {}, [
              E.el("thead", {}, [E.el("tr", {}, [
                E.el("th", { text: "SYMPTOM" }), E.el("th", { text: "DAYS" }),
                E.el("th", { text: "SELF-RATED SEVERITY" }), E.el("th", { text: "MOSTLY" })
              ])]),
              E.el("tbody", {}, symptomRows)
            ]),
            E.el("p", { class: "small faint", text: "Phase basis: " + byDetected + " symptom day" + (byDetected === 1 ? "" : "s") +
              " placed from a detected ovulation, " + byMidpoint + " by the average-cycle midpoint (no ovulation detected for that cycle)." })
          ])
        : E.el("p", { class: "small dim", text: "Nothing tagged in this range." }),

      E.el("hr", { class: "rule" }),
      E.el("p", { class: "small faint", text:
        "Generated by epok from self-reported logs. Ovulation dates are derived from logged temperature (3-over-6 rule, " +
        "readings marked disturbed excluded) or LH tests where present, not clinically confirmed. Severity is the user's own " +
        "1–3 rating, not a clinical scale. This page contains no diagnosis and no medication advice." })
    ]);

    return E.el("div", {}, [controls, page]);
  }

  var Report = { id: "report", title: "REPORT", render: render };
  window.Epok = window.Epok || {};
  window.Epok.Views = window.Epok.Views || {};

  window.Epok.Views.Report = Report;
})();

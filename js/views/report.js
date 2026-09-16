/* ==========================================================================
   EPOK · VIEW · REPORT

   Owner: Window C. See PLAN-epok.md § Parallel windows.

     · ONE PAGE    print stylesheet, no PDF library
     · CONTENT     last 12 cycles, summary stats, top symptoms by frequency and phase, ovulation dates
     · HEADER      date range and the words 'self-reported'
     · DERIVED     ovulation dates come from Epok.Model.detectOvulation() against logged BBT/LH —
                   there is no stored "ovulation" write path any more than there is for cycle.end

   Public namespace: Epok.Views.Report
   ========================================================================== */

"use strict";

(function () {
  var E = window.Epok;
  var MAX_CYCLES = 12;

  function mean(xs) { return xs.reduce(function (a, b) { return a + b; }, 0) / xs.length; }
  function sd(xs) {
    if (xs.length < 2) return null;
    var m = mean(xs), s = 0;
    xs.forEach(function (x) { s += (x - m) * (x - m); });
    return Math.sqrt(s / (xs.length - 1));
  }

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

  /* MENSTRUAL/FOLLICULAR/LUTEAL as a phase heuristic, not a diagnosis: no
     ovulation is assumed confirmed just because a phase label is printed —
     the boundary is the population midpoint of this person's own average
     cycle length, same conservative spirit as the model's own priors. */
  function phaseOf(cycleDay, periodLen, avgLen) {
    if (cycleDay <= periodLen) return "MENSTRUAL";
    if (cycleDay <= avgLen / 2) return "FOLLICULAR";
    return "LUTEAL";
  }

  function cycleDayOf(cycles, key) {
    for (var i = cycles.length - 1; i >= 0; i--) {
      if (E.daysBetween(cycles[i].start, key) >= 0) return { idx: i, day: E.daysBetween(cycles[i].start, key) + 1 };
    }
    return null;
  }

  function render() {
    var cycles = E.Store.cycles();
    var days = E.Store.get().days;

    if (!cycles.length) {
      return E.el("div", {}, [
        E.el("h1", { text: "REPORT", style: "margin-bottom:var(--s4)" }),
        E.el("section", { class: "card" }, [E.el("p", { class: "dim", text: "Nothing logged yet — there is no history to report." })])
      ]);
    }

    var withEnd = cycles.map(function (c) { return { c: c, end: periodEnd(c, days) }; });
    var closed = cycles.filter(function (c) { return c.length != null; });
    var lengths = closed.map(function (c) { return c.length; });
    var avgLen = lengths.length ? mean(lengths) : 29.3;
    var periodLens = [];
    withEnd.forEach(function (x) { if (x.end) periodLens.push(E.daysBetween(x.c.start, x.end) + 1); });

    var M = window.Epok.Model;
    var s = E.Store.get();
    var ropts = { conditions: s.profile.conditions, ageBand: s.profile.ageBand, days: s.days };
    var mae = M ? M.predict(cycles, ropts).mae : null;
    var scored = (mae != null && E.Backtest) ? E.Backtest.run(cycles, ropts).n : 0;

    var recentIdx = cycles.map(function (c, i) { return i; }).slice(-MAX_CYCLES).reverse();
    var rows = recentIdx.map(function (i) {
      var c = cycles[i];
      var pEnd = periodEnd(c, days);
      // Ovulation detection needs the WHOLE cycle span, not the period end —
      // c.end (period end / last bleeding day) is only the first few days of
      // it. The next cycle's start bounds it; the still-open last cycle gets
      // the same 45-day horizon Epok.Model.predict() uses internally.
      var cycleEnd = cycles[i + 1] ? E.shiftDay(cycles[i + 1].start, -1) : E.shiftDay(c.start, 45);
      var ov = M ? M.detectOvulation(days, c.start, cycleEnd) : null;
      return E.el("tr", {}, [
        E.el("td", { text: E.prettyDate(c.start) }),
        E.el("td", { text: c.length != null ? c.length + "d" : "—" }),
        E.el("td", { text: pEnd ? (E.daysBetween(c.start, pEnd) + 1) + "d" : "—" }),
        E.el("td", { text: ov ? E.prettyDate(ov.date) + " (" + ov.source + ")" : "—" })
      ]);
    });

    // Top symptoms by frequency, with the phase each mostly clusters in.
    var counts = {}; // tagId -> { total, byPhase: {} }
    Object.keys(days).forEach(function (key) {
      var d = days[key];
      if (!d.tags || !d.tags.length) return;
      var loc = cycleDayOf(cycles, key);
      if (!loc) return;
      var periodLen = periodLens.length ? Math.round(mean(periodLens)) : 5;
      var phase = phaseOf(loc.day, periodLen, avgLen);
      d.tags.forEach(function (t) {
        counts[t] = counts[t] || { total: 0, byPhase: {} };
        counts[t].total++;
        counts[t].byPhase[phase] = (counts[t].byPhase[phase] || 0) + 1;
      });
    });
    var labelById = {};
    window.Epok.Tags.ALL.concat(s.customTags || []).forEach(function (t) { labelById[t.id] = t.label; });
    var topTags = Object.keys(counts).sort(function (a, b) { return counts[b].total - counts[a].total; }).slice(0, 6);

    var symptomRows = topTags.map(function (id) {
      var c = counts[id];
      var topPhase = Object.keys(c.byPhase).sort(function (a, b) { return c.byPhase[b] - c.byPhase[a]; })[0];
      return E.el("tr", {}, [
        E.el("td", { text: labelById[id] || id }),
        E.el("td", { text: String(c.total) }),
        E.el("td", { text: topPhase + " (" + c.byPhase[topPhase] + "/" + c.total + ")" })
      ]);
    });

    var firstDay = Object.keys(days).sort()[0] || cycles[0].start;
    var range = E.prettyDate(firstDay) + " – " + E.prettyDate(E.today());

    var page = E.el("section", { class: "report-page" }, [
      E.el("div", { class: "card__head" }, [
        E.el("div", {}, [
          E.el("h1", { text: "EPOK · CYCLE REPORT" }),
          E.el("p", { class: "small dim", text: range + " · SELF-REPORTED" })
        ]),
        E.el("button", { type: "button", class: "btn no-print", text: "PRINT", onclick: function () { window.print(); } })
      ]),

      E.el("h2", { text: "SUMMARY" }),
      E.el("p", { class: "small", text:
        "Cycles logged: " + cycles.length +
        " · Avg cycle length: " + (lengths.length ? avgLen.toFixed(1) + "d (" + lengths.length + " complete)" : "—") +
        " · Variability (SD): " + (lengths.length >= 2 ? sd(lengths).toFixed(1) + "d" : "—") +
        " · Avg period length: " + (periodLens.length ? mean(periodLens).toFixed(1) + "d (" + periodLens.length + " periods)" : "—") +
        " · Prediction error: " + (mae != null
          ? "median ±" + mae + "d over " + scored + " past prediction" + (scored === 1 ? "" : "s")
          : "not enough history") }),

      E.el("hr", { class: "rule" }),
      E.el("h2", { text: "CYCLES (LAST " + MAX_CYCLES + ")" }),
      E.el("table", {}, [
        E.el("thead", {}, [E.el("tr", {}, [
          E.el("th", { text: "START" }), E.el("th", { text: "LENGTH" }),
          E.el("th", { text: "PERIOD LENGTH" }), E.el("th", { text: "OVULATION" })
        ])]),
        E.el("tbody", {}, rows)
      ]),

      E.el("hr", { class: "rule" }),
      E.el("h2", { text: "TOP SYMPTOMS" }),
      symptomRows.length
        ? E.el("table", {}, [
            E.el("thead", {}, [E.el("tr", {}, [
              E.el("th", { text: "SYMPTOM" }), E.el("th", { text: "COUNT" }), E.el("th", { text: "MOSTLY" })
            ])]),
            E.el("tbody", {}, symptomRows)
          ])
        : E.el("p", { class: "small dim", text: "Nothing tagged yet." }),

      E.el("hr", { class: "rule" }),
      E.el("p", { class: "small faint", text:
        "Generated by epok from self-reported logs. Ovulation dates are derived from logged " +
        "temperature (3-over-6 rule) or LH tests where present, not clinically confirmed." })
    ]);

    return page;
  }

  var Report = { id: "report", title: "REPORT", render: render };
  window.Epok = window.Epok || {};
  window.Epok.Views = window.Epok.Views || {};

  window.Epok.Views.Report = Report;
})();

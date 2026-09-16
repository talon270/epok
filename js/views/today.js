/* ==========================================================================
   EPOK · VIEW · TODAY

   Owner: Window C. See PLAN-epok.md § Parallel windows.

     · DUE         Epok.Reminders.due(), shown only when something is outstanding
     · ONE TAP     four flow chips. The 95% case, and the only thing the model needs.
     · METHOD LOG  taken/missed/placebo for pill, patch, ring. No missed-dose advice.
     · PERIOD START  states the consequence (predicted date, before -> after) inline, before it commits
     · PREDICTION  window, mode, sample size and measured error, all in the same card
     · LOG MORE    the full 9-category tag grid, inline. Not a modal. Plus BBT/LH.
     · IMMEDIATE   every tap writes. No save button.

   Public namespace: Epok.Views.Today
   ========================================================================== */

"use strict";

(function () {
  var E = window.Epok;

  var FLOW_LEVELS = [
    { id: "spotting", label: "SPOTTING" },
    { id: "light",     label: "LIGHT" },
    { id: "medium",    label: "MEDIUM" },
    { id: "heavy",     label: "HEAVY" }
  ];

  function chip(label, pressed, onclick) {
    return E.el("button", {
      type: "button", class: "chip", "aria-pressed": pressed ? "true" : "false",
      text: label, onclick: onclick
    });
  }

  /* ==================================================================
     FLOW
     ================================================================== */

  function flowSection(key, day) {
    var row = E.el("div", { class: "row" });
    FLOW_LEVELS.forEach(function (f) {
      row.appendChild(chip(f.label, day.flow === f.id, function () {
        E.Store.editDay(key, { flow: day.flow === f.id ? null : f.id });
      }));
    });
    return E.el("section", { class: "card" }, [
      E.el("p", { class: "micro", text: "FLOW" }),
      row
    ]);
  }

  /* ==================================================================
     PERIOD START — states the consequence before it commits (A2 guard)
     ================================================================== */

  function periodStartSection(key) {
    var cycles = E.Store.cycles();
    var recorded = cycles.filter(function (c) { return c.start === key; })[0];

    if (recorded) {
      return E.el("section", { class: "card" }, [
        E.el("p", { class: "micro", text: "PERIOD START" }),
        E.el("p", {}, [
          E.el("strong", { text: "Recorded on " + E.prettyDate(key) + "." })
        ]),
        E.el("div", { class: "row" }, [
          E.el("button", {
            type: "button", class: "btn btn--sm", text: "REMOVE",
            onclick: function () { E.Store.clearPeriodStart(key); }
          })
        ])
      ]);
    }

    var preview = E.Store.previewPeriodStart(key);
    var consequence = preview.from
      ? "Corrects the existing start on " + E.prettyDate(preview.from) + " to " + E.prettyDate(key) + "."
      : "Begins a new cycle at " + E.prettyDate(key) + ".";
    var predChange = (preview.predictionBefore || preview.predictionAfter)
      ? "Predicted next start: " +
        (preview.predictionBefore ? E.prettyDate(preview.predictionBefore) : "—") +
        " → " +
        (preview.predictionAfter ? E.prettyDate(preview.predictionAfter) : "—") + "."
      : null;

    return E.el("section", { class: "card" }, [
      E.el("p", { class: "micro", text: "PERIOD START" }),
      E.el("p", { class: "small dim", text: consequence }),
      predChange ? E.el("p", { class: "small" }, [E.el("span", { class: "est", text: "ESTIMATE" }), " " + predChange]) : null,
      E.el("div", { class: "row" }, [
        E.el("button", {
          type: "button", class: "btn btn--accent", text: "MARK PERIOD START",
          onclick: function () { E.Store.setPeriodStart(key); }
        })
      ])
    ]);
  }

  /* ==================================================================
     PREDICTION CARD (B6*) — data contract is Epok.Model.predict()
     ================================================================== */

  function predictionSection() {
    var M = window.Epok.Model;
    if (!M) return null;
    var s = E.Store.get();
    var p = M.predict(E.Store.cycles(), {
      conditions: s.profile.conditions, ageBand: s.profile.ageBand, days: s.days
    });

    if (p.refused) {
      return E.el("section", { class: "card" }, [
        E.el("p", { class: "micro", text: "PREDICTION" }),
        E.el("p", { class: "dim", text: p.reason })
      ]);
    }

    var modeLabel = p.mode === "luteal" ? "LUTEAL" : p.mode === "cycle-length" ? "CYCLE-LENGTH" : "POPULATION";
    // p.n is cycles in the fit; the error comes from fewer scored predictions
    // (25 cycles -> 21 scored). Each number is printed with its own count.
    var scored = (p.mae != null && E.Backtest) ? E.Backtest.run(E.Store.cycles(), {
      conditions: s.profile.conditions, ageBand: s.profile.ageBand, days: s.days
    }).n : null;

    return E.el("section", { class: "card" }, [
      E.el("div", { class: "card__head" }, [
        E.el("p", { class: "micro", text: "PREDICTED NEXT START" }),
        E.el("span", { class: "est", text: "ESTIMATE" })
      ]),
      E.el("p", { class: "hero", text: E.prettyDate(p.nextStart) }),
      E.el("p", { class: "small dim", text: p.window
        ? "Window " + E.prettyDate(p.window[0]) + " – " + E.prettyDate(p.window[1]) + " (80% credible)"
        : "" }),
      E.el("p", { class: "small" }, [
        E.el("span", { class: "micro", text: modeLabel + " · FIT ON " + p.n + " CYCLE" + (p.n === 1 ? "" : "S") +
          (p.mae != null
            ? " · ±" + p.mae + "D MEASURED ERROR" + (scored ? " OVER " + scored + " PAST PREDICTION" + (scored === 1 ? "" : "S") : "")
            : "") })
      ]),
      E.el("p", { class: "small dim", text: p.reason })
    ]);
  }

  /* ==================================================================
     DUE — Epok.Reminders.due(). The half of reminders that works with the
     app closed and on file://: derived from the log, so it clears itself
     the moment the thing is logged.
     ================================================================== */

  function dueSection() {
    var R = window.Epok.Reminders;
    var items = R ? R.due() : [];
    if (!items.length) return null;
    return E.el("section", { class: "card" }, [
      E.el("p", { class: "micro", text: "DUE" }),
      E.el("ul", {}, items.map(function (d) {
        return E.el("li", { text: d.label });
      }))
    ]);
  }

  /* ==================================================================
     METHOD LOG — pill, patch, ring. Records what happened, nothing more:
     a MISSED tap shows NO_GUIDANCE, never advice about what to do.
     ================================================================== */

  function methodSection(key, day) {
    var C = window.Epok.Contraception;
    var id = E.Store.get().profile.contraception;
    var m = C && id ? C.BY_ID[id] : null;
    if (!m || !m.logs) return null;
    var row = E.el("div", { class: "row" });
    m.logs.forEach(function (v) {
      row.appendChild(chip(v.toUpperCase(), day.pill === v, function () {
        E.Store.editDay(key, { pill: day.pill === v ? null : v });
      }));
    });
    return E.el("section", { class: "card" }, [
      E.el("p", { class: "micro", text: m.label }),
      row,
      day.pill === "missed" ? E.el("p", { class: "small dim", text: C.NO_GUIDANCE }) : null
    ]);
  }

  /* ==================================================================
     BBT / LH — quick entry. Chart lives in Insights.
     ================================================================== */

  function bbtLhSection(key, day) {
    var bbtInput = E.el("input", {
      type: "number", step: "0.01", inputmode: "decimal", class: "num-input",
      value: day.bbt == null ? "" : String(day.bbt),
      "aria-label": "Basal body temperature in Celsius",
      onchange: function (e) {
        var v = e.target.value === "" ? null : Number(e.target.value);
        E.Store.editDay(key, { bbt: (v == null || isNaN(v)) ? null : Math.round(v * 100) / 100 });
      }
    });

    var lhRow = E.el("div", { class: "row" }, [
      chip("NEGATIVE", day.lh === "negative", function () {
        E.Store.editDay(key, { lh: day.lh === "negative" ? null : "negative" });
      }),
      chip("POSITIVE", day.lh === "positive", function () {
        E.Store.editDay(key, { lh: day.lh === "positive" ? null : "positive" });
      })
    ]);

    return E.el("section", { class: "card" }, [
      E.el("p", { class: "micro", text: "TEMPERATURE (°C) · LH TEST" }),
      E.el("div", { class: "row", style: "align-items:flex-start" }, [
        E.el("div", { style: "flex:1 1 140px" }, [bbtInput]),
        E.el("div", { style: "flex:2 1 220px" }, [lhRow])
      ])
    ]);
  }

  /* ==================================================================
     LOG MORE — full tag grid, inline
     ================================================================== */

  function tagGrid(key, day) {
    var tags = day.tags || [];
    var body = E.Tags.CATEGORIES.map(function (cat) {
      var opts = E.Tags.byCategory(cat.id);
      if (!opts.length) return null;
      var row = E.el("div", { class: "row" });
      opts.forEach(function (t) {
        var on = tags.indexOf(t.id) >= 0;
        row.appendChild(chip(t.label, on, function () {
          var next = on ? tags.filter(function (x) { return x !== t.id; }) : tags.concat([t.id]);
          E.Store.editDay(key, { tags: next });
        }));
      });
      return E.el("div", { class: "small-block" }, [
        E.el("p", { class: "micro faint", text: cat.label }),
        row
      ]);
    }).filter(Boolean);

    var noteInput = E.el("input", {
      type: "text", value: day.note || "", "aria-label": "Note",
      placeholder: "Note for this day", class: "text-input",
      onchange: function (e) { E.Store.editDay(key, { note: e.target.value }); }
    });

    return E.el("section", { class: "card" }, [
      E.el("p", { class: "micro", text: "LOG MORE" }),
      E.el("div", { class: "tag-grid" }, body),
      E.el("hr", { class: "rule" }),
      E.el("p", { class: "micro faint", text: "NOTE" }),
      noteInput
    ]);
  }

  /* ==================================================================
     RENDER
     ================================================================== */

  function render() {
    var key = E.viewDate();
    var day = E.Store.day(key);

    var frag = E.el("div", {}, [
      E.el("div", { class: "card__head", style: "border:0;margin:0 0 var(--s4)" }, [
        E.el("h1", { text: "TODAY" }),
        E.el("span", { class: "micro dim", text: E.prettyDate(key) })
      ]),
      dueSection(),
      flowSection(key, day),
      methodSection(key, day),
      periodStartSection(key),
      predictionSection(),
      bbtLhSection(key, day),
      tagGrid(key, day)
    ]);
    return frag;
  }

  var Today = { id: "today", title: "TODAY", render: render };
  window.Epok = window.Epok || {};
  window.Epok.Views = window.Epok.Views || {};

  window.Epok.Views.Today = Today;
})();

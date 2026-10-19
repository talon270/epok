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
    var p = M.predict(E.Store.cycles(), E.Store.modelOpts());

    if (p.refused) {
      return E.el("section", { class: "card" }, [
        E.el("p", { class: "micro", text: p.paused ? "PREDICTION PAUSED" : "PREDICTION" }),
        E.el("p", { class: "dim", text: p.reason })
      ]);
    }

    var modeLabel = p.mode === "luteal" ? "LUTEAL" : p.mode === "cycle-length" ? "CYCLE-LENGTH" : "POPULATION";
    // p.n is cycles in the fit; the error comes from fewer scored predictions
    // (25 cycles -> 21 scored). Each number is printed with its own count.
    var scored = (p.mae != null && E.Backtest) ? E.Backtest.run(E.Store.cycles(), E.Store.modelOpts()).n : null;

    return E.el("section", { class: "card" }, [
      E.el("div", { class: "card__head" }, [
        E.el("p", { class: "micro", text: p.expired ? "EXPIRED FORECAST" : "PREDICTED NEXT START" }),
        E.el("span", { class: "est", text: p.expired ? "NO LONGER CURRENT" : "ESTIMATE" })
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
     EVENTS — a one-line way to say "pregnant", "postpartum", "breastfeeding".
     The full list, with dates and medication, is in Settings.
     ================================================================== */

  var EVENT_LABELS = { pregnancy: "PREGNANCY", postpartum: "POSTPARTUM", breastfeeding: "BREASTFEEDING",
                       contraception: "METHOD", medication: "MEDICATION", other: "OTHER" };

  function eventsSection() {
    var s = E.Store.get();
    var open = s.events.filter(function (e) { return e.to == null && e.type !== "contraception"; });
    var rows = open.map(function (e) {
      return E.el("div", { class: "row" }, [
        E.el("span", { class: "small", text: EVENT_LABELS[e.type] + (e.from ? " since " + E.prettyDate(e.from) : "") + (e.note ? " — " + e.note : "") }),
        chip("END TODAY", false, function () { E.Store.endEvent(e.id, E.today()); })
      ]);
    });
    var adds = ["pregnancy", "postpartum", "breastfeeding"].filter(function (t) {
      return !open.some(function (e) { return e.type === t; });
    }).map(function (t) {
      return chip("+ " + EVENT_LABELS[t], false, function () { E.Store.addEvent({ type: t, from: E.today() }); });
    });
    return E.el("section", { class: "card" }, [
      E.el("p", { class: "micro", text: "EVENTS" }),
      rows.length ? E.el("div", {}, rows) : E.el("p", { class: "small dim", text: "None open." }),
      adds.length ? E.el("div", { class: "row" }, adds) : null,
      E.el("p", { class: "small faint", text: "Pregnancy and postpartum pause the forecast and keep those cycles out of the fit; breastfeeding keeps the forecast and says it is less certain. Dates, medication and past spans: Settings." })
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

  var DISTURBED = [
    { id: "illness", label: "ILLNESS" }, { id: "alcohol", label: "ALCOHOL" },
    { id: "poor-sleep", label: "POOR SLEEP" }, { id: "travel", label: "TRAVEL" },
    { id: "early-alarm", label: "EARLY ALARM" }, { id: "other", label: "OTHER" }
  ];

  function bbtLhSection(key, day) {
    var bbtInput = E.el("input", {
      type: "number", step: "0.01", inputmode: "decimal", class: "num-input",
      value: day.bbt == null ? "" : String(day.bbt),
      "aria-label": "Basal body temperature in Celsius",
      onchange: function (e) {
        var v = e.target.value === "" ? null : Number(e.target.value);
        var gone = (v == null || isNaN(v));
        E.Store.editDay(key, gone ? { bbt: null, bbtMeta: null } : { bbt: Math.round(v * 100) / 100 });
      }
    });

    // How the reading was taken. A reading flagged disturbed stays in the log
    // and is left out when epok looks for a rise — and the flag is shown, so
    // an excluded reading is never invisible.
    var meta = day.bbtMeta || { time: null, disturbed: null };
    function setMeta(patch) {
      var next = { time: meta.time, disturbed: meta.disturbed };
      Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
      E.Store.editDay(key, { bbtMeta: (next.time || next.disturbed) ? next : null });
    }
    var metaBlock = day.bbt == null ? null : E.el("div", { class: "small-block" }, [
      E.el("p", { class: "micro faint", text: "HOW IT WAS TAKEN" }),
      E.el("div", { class: "row" }, [
        E.el("input", { type: "time", class: "text-input", value: meta.time || "", "aria-label": "Time of measurement",
          onchange: function (e) { setMeta({ time: e.target.value || null }); } })
      ].concat(DISTURBED.map(function (d) {
        return chip(d.label, meta.disturbed === d.id, function () { setMeta({ disturbed: meta.disturbed === d.id ? null : d.id }); });
      }))),
      E.el("p", { class: "small faint", text: meta.disturbed
        ? "Marked disturbed (" + meta.disturbed.replace("-", " ") + "): kept in your log, left out when epok looks for a temperature rise."
        : "Mark a reading as disturbed if illness, alcohol, poor sleep or travel may have moved it." })
    ]);

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
      ]),
      metaBlock
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
          var sev = {};
          Object.keys(day.severity || {}).forEach(function (id) { if (next.indexOf(id) >= 0) sev[id] = day.severity[id]; });
          E.Store.editDay(key, { tags: next, severity: sev });
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

    // "I looked and there is nothing to log." Without it a day with no tags is
    // unknown, not symptom-free, and Insights cannot compare rates fairly.
    var checkin = E.el("div", { class: "small-block" }, [
      E.el("p", { class: "micro faint", text: "CHECK-IN" }),
      E.el("div", { class: "row" }, [
        chip("CHECKED IN — NO SYMPTOMS TO LOG", !!day.checkin, function () {
          E.Store.editDay(key, { checkin: !day.checkin });
        })
      ]),
      E.el("p", { class: "small faint", text: "Counts this day as one you were watching, so its empty tag list reads as 'none' rather than 'not recorded'." })
    ]);

    // Severity is the user's own 1-3, no clinical scale implied, and it is only
    // asked for tags that are on. Leaving it blank is fine.
    var labelOf = {};
    E.Tags.ALL.concat(E.Tags.visible()).forEach(function (t) { labelOf[t.id] = t.label; });
    var sev = day.severity || {};
    var sevBlock = tags.length ? E.el("div", { class: "small-block" }, [
      E.el("p", { class: "micro faint", text: "HOW BAD (YOUR OWN 1–3, OPTIONAL)" })
    ].concat(tags.map(function (id) {
      return E.el("div", { class: "row" }, [E.el("span", { class: "small", text: labelOf[id] || id })].concat([1, 2, 3].map(function (n) {
        return chip(String(n), sev[id] === n, function () {
          var next = {}; Object.keys(sev).forEach(function (k) { next[k] = sev[k]; });
          if (sev[id] === n) delete next[id]; else next[id] = n;
          E.Store.editDay(key, { severity: next });
        });
      })));
    }))) : null;

    var IMPACT = [{ id: "none", label: "NO EFFECT" }, { id: "some", label: "SOME" }, { id: "a-lot", label: "A LOT" }];
    var impactBlock = E.el("div", { class: "small-block" }, [
      E.el("p", { class: "micro faint", text: "EFFECT ON YOUR DAY" }),
      E.el("div", { class: "row" }, IMPACT.map(function (m) {
        return chip(m.label, day.impact === m.id, function () { E.Store.editDay(key, { impact: day.impact === m.id ? null : m.id }); });
      }))
    ]);

    // Completeness: of the last 14 days, how many were actually watched.
    var watched = 0;
    for (var back = 0; back < 14; back++) {
      var dd = E.Store.get().days[E.shiftDay(key, -back)];
      if (dd && (dd.checkin || (dd.tags && dd.tags.length))) watched++;
    }

    return E.el("section", { class: "card" }, [
      E.el("p", { class: "micro", text: "LOG MORE" }),
      checkin,
      sevBlock,
      impactBlock,
      E.el("p", { class: "small faint", text: "Symptom record: " + watched + " of the last 14 days checked in or tagged." }),
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
      eventsSection(),
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

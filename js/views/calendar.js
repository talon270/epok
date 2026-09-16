/* ==========================================================================
   EPOK · VIEW · CALENDAR

   Owner: Window C. See PLAN-epok.md § Parallel windows; rebuilt per
   PLAN-calendar.md.

     · MONTH GRID  period days filled by flow level, fertility tinted, the
                   predicted window as an inset dashed outline — every marker
                   INSIDE its cell, so none can be read as the next row's
     · HISTORY     finished cycles carry their ovulation and fertile days too,
                   from Epok.Model.history(); the open cycle from fertility()
     · SELECT      a tap selects a day and shows it in the detail panel. It
                   does NOT change the logging date — LOG THIS DAY does that,
                   and hands off to Today (which carries the not-today banner)
     · LEGEND      only what the month on screen actually draws
     · FERTILITY   only when profile.fertilityVisible; never a hard window,
                   never claims "closed" (A6 guard lives in the model)

   Public namespace: Epok.Views.Calendar
   ========================================================================== */

"use strict";

(function () {
  var E = window.Epok;

  var DOW = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
  var WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTH_NAMES = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
    "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
  var OV_SOURCE = { bbt: "BBT (3-over-6 rule)", lh: "a positive LH test", both: "BBT and a positive LH test" };

  // Below this width the detail panel sits under the grid, so a tap has to
  // bring it into view. Matches the media query in css/views.css.
  var RAIL_MIN_PX = 1100;

  // Module-local, not persisted: reopening the app starts on today's month
  // with the logging date selected.
  var shown = null;     // { y, m } — m is 0-indexed
  var selected = null;  // "YYYY-MM-DD"

  function pad2(n) { return String(n).padStart(2, "0"); }
  function keyFor(y, m, d) { return y + "-" + pad2(m + 1) + "-" + pad2(d); }
  function monthOf(key) { var p = key.split("-"); return { y: Number(p[0]), m: Number(p[1]) - 1 }; }
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function leadIndex(y, m) { return (new Date(y, m, 1).getDay() + 6) % 7; }   // Monday-first
  function weekday(key) { var p = key.split("-"); return WEEKDAY[new Date(+p[0], +p[1] - 1, +p[2]).getDay()]; }

  /* Re-render in place. E.show() scrolls to the top, which on a phone throws
     away the panel a tap was meant to reveal. */
  function rerender(focusKey) {
    var main = document.getElementById("main");
    if (!main) return;
    main.replaceChildren(render());
    if (!focusKey) return;
    var cell = main.querySelector('.cal-day[data-date="' + focusKey + '"]');
    if (cell) cell.focus({ preventScroll: true });
    if (window.innerWidth < RAIL_MIN_PX) {
      var panel = main.querySelector(".cal-detail");
      if (panel) panel.scrollIntoView({ block: "nearest" });
    }
  }

  function nav(delta) {
    var m = shown.m + delta, y = shown.y;
    if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
    shown = { y: y, m: m };
    rerender();
  }

  /* Everything the model says about each date, gathered once per render. */
  function estimates(s, cycles) {
    var M = window.Epok.Model;
    var out = { pred: null, predWin: null, info: {}, horizon: null, caveat: "", fertilityOn: s.profile.fertilityVisible !== false };
    if (!M) return out;
    var opts = { conditions: s.profile.conditions, ageBand: s.profile.ageBand, days: s.days };

    out.pred = M.predict(cycles, { conditions: opts.conditions, ageBand: opts.ageBand, days: opts.days, noMae: true });
    if (!out.pred.refused) { out.predWin = out.pred.window; out.horizon = out.pred.window[1]; }
    if (!out.fertilityOn) return out;

    function note(date) { return out.info[date] || (out.info[date] = {}); }
    M.history(cycles, opts).forEach(function (h) {
      h.bands.forEach(function (b) { var n = note(b.date); n.band = b.band; n.basis = h.confirmed ? "confirmed" : "past"; });
      note(h.ovulation.date).ov = { confirmed: h.confirmed, source: h.ovulation.source, basis: "past" };
    });
    var f = M.fertility(cycles, opts);
    f.bands.forEach(function (b) { var n = note(b.date); n.band = b.band; n.basis = f.confirmed ? "confirmed" : "open"; });
    if (f.ovulation) note(f.ovulation.date).ov = { confirmed: f.confirmed, source: f.ovulation.source, basis: "open" };
    if (f.bands.length) {
      var last = f.bands[f.bands.length - 1].date;
      if (!out.horizon || last > out.horizon) out.horizon = last;
    }
    // The model's own caveat sentence, so the wording cannot drift from it.
    var at = f.reason.indexOf("This is an estimate");
    out.caveat = at >= 0 ? f.reason.slice(at) : f.reason;
    return out;
  }

  function cycleDay(cycles, key) {
    for (var i = cycles.length - 1; i >= 0; i--) {
      var n = E.daysBetween(cycles[i].start, key);
      if (n >= 0) return n + 1;
    }
    return null;
  }

  function inWindow(win, key) {
    return !!win && E.daysBetween(win[0], key) >= 0 && E.daysBetween(key, win[1]) >= 0;
  }

  function hasOtherData(day) {
    return !!day && ((day.tags && day.tags.length) || day.bbt != null || day.lh != null ||
      day.pill != null || (day.note && day.note.trim()));
  }

  function ariaLabel(key, ctx) {
    var parts = [weekday(key) + " " + E.prettyDate(key)];
    if (ctx.isToday) parts.push("today");
    if (ctx.cd) parts.push("cycle day " + ctx.cd);
    if (ctx.day && ctx.day.flow) parts.push(ctx.day.flow + " flow");
    if (hasOtherData(ctx.day)) parts.push("other data logged");
    if (ctx.est && ctx.est.band === "peak") parts.push("peak fertility, estimate");
    else if (ctx.est && ctx.est.band === "elevated") parts.push("fertile, estimate");
    if (ctx.est && ctx.est.ov) parts.push(ctx.est.ov.confirmed ? "confirmed ovulation" : "estimated ovulation");
    if (ctx.predicted) parts.push("predicted period window, estimate");
    return parts.join(", ");
  }

  /* ------------------------------------------------------------------
     DETAIL PANEL
     ------------------------------------------------------------------ */

  function tagLabel(id) {
    var all = (E.Tags ? E.Tags.ALL : []).concat(E.Store.get().customTags || []);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i].label;
    return id;
  }

  function kv(label, value) {
    return E.el("div", { class: "cal-kv" }, [
      E.el("span", { class: "micro", text: label }),
      E.el("span", { text: value })
    ]);
  }

  function detailPanel(key, s, cycles, est) {
    var today = E.today();
    var day = s.days[key];
    var future = E.daysBetween(key, today) < 0;
    var cd = cycleDay(cycles, key);
    var info = est.info[key];
    var predicted = inWindow(est.predWin, key);
    // Past the predicted start, a cycle-day count describes a period that
    // has probably already begun; it is left out rather than shown wrong.
    var showCd = cd && !(future && est.predWin && E.daysBetween(est.predWin[0], key) >= 0);

    var body = [
      E.el("div", { class: "card__head" }, [
        E.el("h2", { text: weekday(key).slice(0, 3).toUpperCase() + " " + E.prettyDate(key).toUpperCase() }),
        key === today ? E.el("span", { class: "micro", text: "TODAY" }) : null
      ]),
      E.el("p", { class: "small dim", text: showCd
        ? "Cycle day " + cd + (future ? ", if your period has not started by then." : ".")
        : cd ? "No cycle day — the predicted period window starts on or before this date."
             : "Before your first logged period." })
    ];

    var logged = [];
    if (day) {
      if (day.flow) logged.push(kv("FLOW", day.flow));
      if (day.tags && day.tags.length) logged.push(kv("TAGS", day.tags.map(tagLabel).join(", ")));
      if (day.bbt != null) logged.push(kv("BBT", day.bbt.toFixed(2) + " °C"));
      if (day.lh != null) logged.push(kv("LH", day.lh));
      if (day.pill != null) logged.push(kv("PILL", day.pill));
      if (day.note && day.note.trim()) logged.push(kv("NOTE", day.note));
    }
    body.push(E.el("p", { class: "micro cal-detail__sub", text: "LOGGED" }));
    body.push(logged.length ? E.el("div", { class: "cal-kvs" }, logged)
      : E.el("p", { class: "small faint", text: future ? "Nothing to log on a future date." : "Nothing logged." }));

    var lines = [];
    if (predicted) {
      lines.push("Inside the predicted window for your next period, " + E.prettyDate(est.predWin[0]) +
        " – " + E.prettyDate(est.predWin[1]) + " (80% credible).");
    }
    if (info && info.band) {
      var how = info.basis === "confirmed" ? "from a confirmed ovulation"
        : info.basis === "past" ? "looking back from the period that followed"
        : "from the predicted next start, so as uncertain as that prediction";
      lines.push(info.band === "peak" ? "Peak fertility — " + how + "."
        : info.band === "elevated" ? "Fertile — " + how + "."
        : "Low fertility — " + how + ". Low is not zero.");
    }
    if (info && info.ov) {
      lines.push(info.ov.confirmed
        ? "Ovulation confirmed by " + (OV_SOURCE[info.ov.source] || info.ov.source) + "."
        : info.ov.basis === "past"
          ? "Estimated ovulation: the next period's start minus your luteal phase."
          : "Estimated ovulation: the predicted next start minus your luteal phase.");
      if (info.band !== "peak") lines.push("Fertility peaks one to two days before ovulation, so this day is not the peak.");
    }
    if (future && est.horizon && key > est.horizon) lines.push("No forecast for this date — epok predicts one cycle ahead.");
    if (est.pred && est.pred.refused && !(info && info.band)) lines.push(est.pred.reason);

    if (lines.length) {
      body.push(E.el("div", { class: "cal-detail__head" }, [
        E.el("p", { class: "micro cal-detail__sub", text: "ESTIMATES" }),
        (predicted || (info && (info.band || (info.ov && !info.ov.confirmed)))) ? E.el("span", { class: "est", text: "ESTIMATE" }) : null
      ]));
      lines.forEach(function (t) { body.push(E.el("p", { class: "small", text: t })); });
      if (info && (info.band || info.ov) && est.caveat) body.push(E.el("p", { class: "small faint", text: est.caveat }));
    }

    if (!future) {
      body.push(E.el("div", { class: "row cal-detail__act" }, [
        E.el("button", {
          type: "button", class: "btn btn--accent",
          text: key === today ? "LOG TODAY" : "LOG THIS DAY",
          onclick: function () { E.setViewDate(key); E.show("today"); }
        })
      ]));
    }

    return E.el("aside", { class: "card cal-detail", "aria-live": "polite" }, body);
  }

  /* ------------------------------------------------------------------
     RENDER
     ------------------------------------------------------------------ */

  function render() {
    var today = E.today();
    if (!shown) shown = monthOf(today);
    if (!selected) selected = E.viewDate();

    var s = E.Store.get();
    var cycles = E.Store.cycles();
    var est = estimates(s, cycles);
    var FLOW = E.Store.FLOW;
    var starts = {};
    cycles.forEach(function (c) { starts[c.start] = true; });

    var seen = { period: false, fertile: false, peak: false, ovEst: false, ovConf: false, predicted: false, other: false, today: false };

    var grid = E.el("div", { class: "cal-grid", role: "group", "aria-label": MONTH_NAMES[shown.m] + " " + shown.y });
    DOW.forEach(function (d) { grid.appendChild(E.el("div", { class: "cal-dow", "aria-hidden": "true", text: d })); });
    for (var i = 0; i < leadIndex(shown.y, shown.m); i++) grid.appendChild(E.el("div", { class: "cal-day is-empty" }));

    var n = daysInMonth(shown.y, shown.m);
    for (var d = 1; d <= n; d++) {
      var key = keyFor(shown.y, shown.m, d);
      var day = s.days[key];
      var info = est.info[key];
      var predicted = inWindow(est.predWin, key);
      var cd = cycleDay(cycles, key);

      var cls = "cal-day";
      var level = day && day.flow ? FLOW.indexOf(day.flow) + 1 : 0;
      if (level) { cls += " cal-day--period-" + level; seen.period = true; }
      else if (info && info.band === "peak") { cls += " cal-day--peak"; seen.peak = true; }
      else if (info && info.band === "elevated") { cls += " cal-day--fertile"; seen.fertile = true; }
      if (predicted) { cls += " is-predicted"; seen.predicted = true; }
      if (key === today) { cls += " is-today"; seen.today = true; }
      if (key === selected) cls += " is-selected";

      var ov = info && info.ov;
      if (ov) seen[ov.confirmed ? "ovConf" : "ovEst"] = true;
      var other = hasOtherData(day);
      if (other) seen.other = true;
      // Cycle day only where it orients you: each period's first day, and today.
      var cdText = starts[key] ? "CD1" : key === today && cd ? "CD" + cd : "";

      grid.appendChild(E.el("button", {
        type: "button", class: cls, "data-date": key,
        "aria-pressed": key === selected ? "true" : "false",
        "aria-label": ariaLabel(key, { isToday: key === today, cd: E.daysBetween(key, today) >= 0 ? cd : null, day: day, est: info, predicted: predicted }),
        onclick: function (e) {
          selected = e.currentTarget.getAttribute("data-date");
          rerender(selected);
        }
      }, [
        E.el("span", { class: "cal-day__top" }, [
          E.el("span", { class: "cal-day__num", text: String(d) }),
          ov ? E.el("span", { class: "cal-day__ov" + (ov.confirmed ? "" : " is-estimated"), text: "OV" }) : null
        ]),
        E.el("span", { class: "cal-day__bottom" }, [
          E.el("span", { class: "cal-day__cd", text: cdText }),
          other ? E.el("span", { class: "cal-dot" }) : null
        ])
      ]));
    }

    // Close the last week, or the grid's line colour shows through as a slab.
    var trailing = (7 - (leadIndex(shown.y, shown.m) + n) % 7) % 7;
    for (var t = 0; t < trailing; t++) grid.appendChild(E.el("div", { class: "cal-day is-empty" }));

    var legendItems = [
      seen.period && legendItem(E.el("span", { class: "cal-swatch cal-day--period-3" }), "PERIOD — DARKER IS HEAVIER"),
      seen.fertile && legendItem(E.el("span", { class: "cal-swatch cal-day--fertile" }), "FERTILE (ESTIMATE)"),
      seen.peak && legendItem(E.el("span", { class: "cal-swatch cal-day--peak" }), "PEAK FERTILITY (ESTIMATE)"),
      seen.ovEst && legendItem(E.el("span", { class: "cal-day__ov is-estimated", text: "OV" }), "OVULATION, DASHED = ESTIMATE"),
      seen.ovConf && legendItem(E.el("span", { class: "cal-day__ov", text: "OV" }), "OVULATION, CONFIRMED"),
      seen.predicted && legendItem(E.el("span", { class: "cal-swatch cal-swatch--predicted" }), "PREDICTED PERIOD WINDOW (ESTIMATE)"),
      seen.other && legendItem(E.el("span", { class: "cal-dot" }), "OTHER DATA LOGGED"),
      seen.today && legendItem(E.el("span", { class: "cal-swatch cal-swatch--today" }), "TODAY")
    ].filter(Boolean);

    var notes = [];
    var monthEnd = keyFor(shown.y, shown.m, n);
    if (est.pred && est.pred.refused) notes.push(est.pred.reason);
    else if (est.horizon && monthEnd > est.horizon && E.daysBetween(today, monthEnd) > 0) {
      notes.push("No forecast after " + E.prettyDate(est.horizon) + " — epok predicts one cycle ahead.");
    }
    if (!est.fertilityOn) notes.push("Fertile days and ovulation are hidden. Turn on SHOW FERTILITY ESTIMATES in Settings › Appearance.");

    var foot = E.el("div", { class: "cal-foot" }, [
      legendItems.length ? E.el("div", { class: "cal-legend small dim" }, legendItems)
        : E.el("p", { class: "small faint", text: "Nothing logged or estimated in this month." })
    ].concat(notes.map(function (t) { return E.el("p", { class: "small dim", text: t }); })));

    var nav_ = E.el("div", { class: "cal-nav" }, [
      E.el("h1", { text: MONTH_NAMES[shown.m] + " " + shown.y }),
      E.el("div", { class: "cal-nav__ctl" }, [
        E.el("button", { type: "button", class: "btn btn--sm", text: "‹ PREV", "aria-label": "Previous month", onclick: function () { nav(-1); } }),
        E.el("button", {
          type: "button", class: "btn btn--sm", text: "TODAY",
          onclick: function () { shown = monthOf(today); selected = today; rerender(today); }
        }),
        E.el("button", { type: "button", class: "btn btn--sm", text: "NEXT ›", "aria-label": "Next month", onclick: function () { nav(1); } })
      ])
    ]);

    return E.el("div", { class: "cal" }, [
      nav_,
      E.el("div", { class: "cal-layout" }, [
        E.el("section", { class: "card cal-card" }, [grid, foot]),
        detailPanel(selected, s, cycles, est)
      ])
    ]);
  }

  function legendItem(mark, text) {
    return E.el("span", { class: "cal-legend__item" }, [mark, text]);
  }

  var Calendar = { id: "calendar", title: "CALENDAR", render: render };
  window.Epok = window.Epok || {};
  window.Epok.Views = window.Epok.Views || {};

  window.Epok.Views.Calendar = Calendar;
})();

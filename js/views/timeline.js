/* ==========================================================================
   EPOK · TIMELINE VIEW

     · CYCLES      every cycle, newest first: where its start came from, its
                   length, its bleed, what was charted, and what looks off
     · CORRECT     move a start, leave a cycle out of the fit, remove a start —
                   each states its consequence first and registers an undo
     · NEVER       edits or deletes a start by itself. A long cycle is flagged
                   with both readings (a missed entry, or a real long cycle)

   The period start is the only date the model consumes, so this is the one
   screen where a wrong one can be found and fixed in place.

   Public namespace: Epok.Views.Timeline
   ========================================================================== */

"use strict";

(function () {
  var E = window.Epok;

  // Above LONG a gap is more often a missed entry than a real cycle, but not
  // always — hence a flag with both readings, never an edit. Below SHORT it is
  // more likely a duplicate start. Prompts, not diagnoses.
  var LONG_CYCLE_DAYS = 45;
  var SHORT_CYCLE_DAYS = 21;

  var moving = null;       // the start whose move form is open
  var splitting = null;    // the start whose "add a start inside" form is open
  var notice = null;       // { start, text, bad } — inline result of the last action

  function btn(label, onclick, cls) {
    return E.el("button", { type: "button", class: "chip" + (cls ? " " + cls : ""), text: label, onclick: onclick });
  }

  function sourceLabel(c) {
    return c.source === "flow" ? "INFERRED FROM YOUR FLOW LOG" : "MARKED BY YOU";
  }

  function facts(c, next, days) {
    var end = next ? E.shiftDay(next.start, -1) : E.today();
    var span = Math.max(0, E.daysBetween(c.start, end));
    var bleed = 0, spotting = 0, bbt = 0, lh = 0, k, d, streak = true;
    for (k = 0; k <= span; k++) {
      d = days[E.shiftDay(c.start, k)];
      if (!d) { streak = false; continue; }
      if (d.flow === "spotting") spotting++;
      else if (d.flow && streak) bleed++;
      else if (!d.flow) streak = false;
      if (typeof d.bbt === "number") bbt++;
      if (d.lh) lh++;
    }
    return { bleed: bleed, spotting: spotting, bbt: bbt, lh: lh, days: span + 1 };
  }

  function lengthText(c, next) {
    if (next) return c.length + " days";
    var n = E.daysBetween(c.start, E.today());
    return n < 0 ? "—" : "open — day " + (n + 1);
  }

  function cycleCard(cs, i, flags, days) {
    var c = cs[i], next = cs[i + 1], prev = cs[i - 1];
    var f = facts(c, next, days);
    var skipped = flags[i] && flags[i]._skip;

    var badges = [E.el("span", { class: "micro", text: sourceLabel(c) })];
    if (!next) badges.push(E.el("span", { class: "micro", text: "OPEN" }));
    if (c.excluded) badges.push(E.el("span", { class: "est", text: "LEFT OUT OF THE FIT" }));
    else if (skipped) badges.push(E.el("span", { class: "est", text: "INSIDE AN EVENT SPAN — NOT FITTED" }));

    var lines = [
      E.el("p", { class: "small", text:
        "Length " + lengthText(c, next) + " · bleeding " + (f.bleed ? f.bleed + " day" + (f.bleed === 1 ? "" : "s") : "not logged") +
        (f.spotting ? " · " + f.spotting + " spotting day" + (f.spotting === 1 ? "" : "s") : "") })
    ];
    lines.push(E.el("p", { class: "small dim", text:
      "Charted: temperature on " + f.bbt + " of " + f.days + " days · " + f.lh + " LH test" + (f.lh === 1 ? "" : "s") + "." }));

    if (next && c.length > LONG_CYCLE_DAYS) {
      lines.push(E.el("p", { class: "small", text:
        "LONG — " + c.length + " days. Either a period was not logged inside it (a missed entry) or this was a real long cycle. " +
        "epok cannot tell which, so nothing is changed. If a start is missing, add it below; if it was real, you can leave this cycle out of the fit." }));
    } else if (next && c.length < SHORT_CYCLE_DAYS) {
      lines.push(E.el("p", { class: "small", text:
        "SHORT — " + c.length + " days. Possibly a duplicate start, or spotting marked as a period. Move or remove a start if so." }));
    }

    var acts = [];
    acts.push(btn(moving === c.start ? "CANCEL MOVE" : "MOVE START", function () {
      moving = moving === c.start ? null : c.start; splitting = null; notice = null; E.refresh();
    }));
    if (next) {
      acts.push(btn(c.excluded ? "COUNT IN THE FIT" : "LEAVE OUT OF THE FIT", function () {
        var r = E.Store.setCycleExcluded(c.start, !c.excluded);
        notice = r.ok ? null : { start: c.start, text: r.error, bad: true };
      }));
      acts.push(btn(splitting === c.start ? "CANCEL" : "ADD A MISSED START INSIDE", function () {
        splitting = splitting === c.start ? null : c.start; moving = null; notice = null; E.refresh();
      }));
    }
    acts.push(btn("REMOVE THIS START", function () {
      E.Store.clearPeriodStart(c.start);
    }));

    var body = [
      E.el("div", { class: "card__head" }, [
        E.el("p", { class: "micro", text: "CYCLE " + (i + 1) }),
        E.el("span", { class: "small", text: E.prettyDate(c.start) })
      ]),
      E.el("div", { class: "row" }, badges)
    ].concat(lines);

    if (moving === c.start) body.push(moveForm(cs, i));
    if (splitting === c.start && next) body.push(splitForm(c, next));
    body.push(E.el("div", { class: "row" }, acts));
    body.push(removeNote(cs, i));
    if (notice && notice.start === c.start) {
      body.push(E.el("p", { class: "small", role: "status", text: notice.text }));
    }
    return E.el("section", { class: "card", "data-cycle": c.start }, body);
  }

  /* What removing a start does, stated before it is done. */
  function removeNote(cs, i) {
    var c = cs[i], prev = cs[i - 1], next = cs[i + 1];
    if (!prev && !next) return E.el("p", { class: "small faint", text: "Removing this leaves no cycles logged." });
    var text;
    if (prev && next) text = "Removing this start merges it with the cycle before: " + prev.length + " + " + c.length +
      " days becomes one cycle of " + (prev.length + c.length) + " days.";
    else if (prev) text = "Removing this start reopens the cycle before it, which becomes the open cycle (it was " + prev.length + " days).";
    else text = "Removing this start drops its " + c.length + "-day cycle from the record.";
    return E.el("p", { class: "small faint", text: text });
  }

  function moveForm(cs, i) {
    var c = cs[i], prev = cs[i - 1], next = cs[i + 1];
    var input = E.el("input", { type: "date", class: "text-input", value: c.start, "aria-label": "New start date", max: E.today() });
    var cons = E.el("p", { class: "small dim", text: "Pick a date to see what it changes." });
    function show() {
      var v = input.value;
      if (!v || v === c.start) { cons.textContent = "Pick a date to see what it changes."; return; }
      var parts = [];
      if (prev) parts.push("the cycle before goes from " + prev.length + " to " + E.daysBetween(prev.start, v) + " days");
      if (next) parts.push("this cycle goes from " + c.length + " to " + E.daysBetween(v, next.start) + " days");
      cons.textContent = "Moving to " + E.prettyDate(v) + ": " + (parts.join(", and ") || "no length changes") + ".";
    }
    input.addEventListener("input", show);
    return E.el("div", { class: "field" }, [
      E.el("span", { class: "micro field__label", text: "NEW START DATE" }),
      E.el("div", { class: "row" }, [input, btn("MOVE", function () {
        var r = E.Store.moveStart(c.start, input.value);
        if (r.ok) { moving = null; notice = null; }
        else notice = { start: c.start, text: r.error, bad: true };
        E.refresh();
      })]),
      cons
    ]);
  }

  function splitForm(c, next) {
    var lo = E.shiftDay(c.start, 8), hi = E.shiftDay(next.start, -8);
    var input = E.el("input", { type: "date", class: "text-input", value: "", "aria-label": "Missed start date", min: lo, max: hi });
    return E.el("div", { class: "field" }, [
      E.el("span", { class: "micro field__label", text: "A PERIOD THAT WAS NEVER LOGGED" }),
      E.el("div", { class: "row" }, [input, btn("ADD START", function () {
        var k = input.value;
        if (!k || k < lo || k > hi) {
          notice = { start: c.start, text: "Choose a date at least 8 days after " + E.prettyDate(c.start) +
            " and 8 days before the next start, " + E.prettyDate(next.start) + " — closer than that it would correct a neighbouring start, not add one.", bad: true };
        } else { splitting = null; notice = null; E.Store.setPeriodStart(k); return; }
        E.refresh();
      })]),
      E.el("p", { class: "small dim", text: "Splits this " + c.length + "-day cycle in two. Both new lengths are shown on the cards afterwards." })
    ]);
  }

  function render() {
    var s = E.Store.get();
    var cs = E.Store.cycles();
    if (!cs.length) {
      return E.el("div", {}, [
        E.el("h1", { text: "TIMELINE", style: "margin-bottom:var(--s4)" }),
        E.el("section", { class: "card" }, [
          E.el("p", { class: "dim", text: "No cycles yet. Mark a period start on Today and it appears here." })
        ])
      ]);
    }
    var M = window.Epok.Model;
    var flags = M && M.flagCycles ? M.flagCycles(cs, s.events) : cs;
    var out = flags.filter(function (c, i) { return typeof cs[i].length === "number" && (c._skip || cs[i].excluded); }).length;
    var inferred = cs.filter(function (c) { return c.source === "flow"; }).length;

    var head = E.el("section", { class: "card" }, [
      E.el("p", { class: "micro", text: "SUMMARY" }),
      E.el("p", { class: "small", text: cs.length + " cycle" + (cs.length === 1 ? "" : "s") + " · " + inferred +
        " inferred from your flow log · " + out + " not in the fit." }),
      E.el("p", { class: "small dim", text: "The model learns only from period starts, so a wrong one here moves every forecast. " +
        "Changes ask nothing and can be undone from the banner at the bottom." })
    ]);

    var cards = [];
    for (var i = cs.length - 1; i >= 0; i--) cards.push(cycleCard(cs, i, flags, s.days));
    return E.el("div", {}, [E.el("h1", { text: "TIMELINE", style: "margin-bottom:var(--s4)" }), head].concat(cards));
  }

  var Timeline = { id: "timeline", title: "TIMELINE", render: render };
  window.Epok = window.Epok || {};
  window.Epok.Views = window.Epok.Views || {};
  window.Epok.Views.Timeline = Timeline;
})();

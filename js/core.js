/* ==========================================================================
   EPOK · CORE

   Owner: Window A. See PLAN-epok.md § Parallel windows.

     · DATE HELPERS  local-time YYYY-MM-DD keys, configurable day boundary (never UTC)
     · VIEW DATE     the logging day, with the persistent not-today banner
     · ROUTER        registerView / show / refresh
     · UI            el, toast, banner, undo. No modals, no confirm()
     · THEME         4 palettes x light/dark, applied as data attributes

   Public namespace: window.Epok
   ========================================================================== */

"use strict";

(function () {
  /* ------------------------------------------------------------------
     CONSTANTS
     ------------------------------------------------------------------ */

  // Every date key in the app derives from this one setting. Bleed at 23:00,
  // log it at 00:20, and it still lands on the right day.
  var DAY_BOUNDARY_DEFAULT = 4;   // hours past midnight, settable 0-6
  var SCHEMA_VERSION = 2;   // v2 added profile.reminders — see storage.js MIGRATIONS

  var THEMES = ["quasar", "arasaka", "chernobyl", "monolith"];
  var MODES  = ["dark", "light", "system"];

  var TOAST_MS = 3200;
  // Undo outlives a toast deliberately: a toast is news, an undo is a decision,
  // and the decision needs time to be read and acted on.
  var UNDO_MS  = 9000;

  var KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

  /* ------------------------------------------------------------------
     MODULE STATE
     ------------------------------------------------------------------ */

  var boundaryHour = DAY_BOUNDARY_DEFAULT;
  var VIEW_DATE = null;          // null means "today". Never persisted — see setViewDate.
  var VIEWS = {};                // id -> { title, render, refresh }
  var ORDER = [];                // registration order; the rail renders this
  var ACTIVE = null;
  var undoTimer = null;

  /* ==================================================================
     1. DATES — local time, never UTC
     ================================================================== */

  function pad2(n) { return String(n).padStart(2, "0"); }

  /* The raw calendar key for a Date. Boundary-free on purpose: every helper
     that converts a key back into a key (shiftDay, prettyDate) must go through
     this one, because a parsed key is midnight local and a boundary-aware
     conversion would silently walk it back a day. That is exactly the
     misdating failure PLAN A2 names. */
  function keyOf(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function parseYmd(key) {
    var p = String(key).split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function isKey(key) { return KEY_RE.test(String(key)) && !isNaN(parseYmd(key)); }

  /* The logging-day key for a moment in time, honouring the rollover hour.
     With boundary 4, anything between midnight and 03:59 belongs to the day
     that just ended. */
  function ymd(d) {
    d = d ? new Date(d.getTime ? d.getTime() : d) : new Date();
    if (boundaryHour > 0 && d.getHours() < boundaryHour) d.setDate(d.getDate() - 1);
    return keyOf(d);
  }

  function today() { return ymd(new Date()); }

  /* The real calendar date, for the few things that genuinely mean it:
     reminder scheduling and anything compared against wall-clock time. */
  function calendarToday() { return keyOf(new Date()); }

  /* n days after `key`; n may be negative to move back. */
  function shiftDay(key, n) {
    var d = parseYmd(key);
    d.setDate(d.getDate() + n);
    return keyOf(d);
  }

  /* b - a, in whole days. Rounded because a DST boundary makes the raw
     millisecond difference 23 or 25 hours, not 24. */
  function daysBetween(a, b) {
    return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
  }

  /* The month names are a fixed table, not toLocaleDateString: en-GB now
     abbreviates September as "Sept", which breaks the column alignment that a
     mono instrument depends on, and changes with the browser's ICU version. */
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /* "14 Sep 2026". The year is always shown: this app browses years of
     history, and "14 Sep" alone collides across them. */
  function prettyDate(key) {
    var d = parseYmd(key);
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  }

  function relDay(key) {
    var n = daysBetween(key, today());   // positive = key is in the past
    if (n === 0) return "today";
    if (n === 1) return "yesterday";
    if (n === -1) return "tomorrow";
    if (n > 0) return n + " days ago";
    return "in " + (-n) + " days";
  }

  /* Storage owns the profile, and storage loads after core — so it hands the
     boundary down here once state is read. Internal to Window A; not a
     cross-window interface, which is why it is underscored. */
  function _setDayBoundary(h) {
    h = Number(h);
    boundaryHour = (h >= 0 && h <= 6) ? Math.floor(h) : DAY_BOUNDARY_DEFAULT;
  }
  function _dayBoundary() { return boundaryHour; }

  /* ==================================================================
     2. THE LOGGING DATE
     ------------------------------------------------------------------
     Views log to viewDate(), not today(). It normally IS today, but the
     calendar can point it at any past day.

     Deliberately NOT persisted across reloads: waking up tomorrow still
     editing last Tuesday is a quiet way to corrupt a month of data.
     ================================================================== */

  function viewDate() { return VIEW_DATE || today(); }
  function isBackfilling() { return !!VIEW_DATE && VIEW_DATE !== today(); }

  function setViewDate(key) {
    if (!key || key === today()) VIEW_DATE = null;
    else if (isKey(key)) {
      // The future has nothing to log.
      VIEW_DATE = daysBetween(key, today()) < 0 ? null : key;
    }
    updateBackfillBanner();
    refresh();
  }

  function updateBackfillBanner() {
    if (!isBackfilling()) { clearBanner("not-today"); return; }
    var msg = el("span", { class: "banner__msg" }, [
      el("strong", { text: "Logging " + prettyDate(viewDate()) }),
      el("span", { text: " — not today (" + relDay(viewDate()) + ")." })
    ]);
    var back = el("button", {
      type: "button", class: "btn btn--sm", text: "BACK TO TODAY",
      onclick: function () { setViewDate(null); }
    });
    banner("not-today", el("span", { class: "banner__row" }, [msg, back]), { tone: "warn" });
  }

  /* ==================================================================
     3. ROUTER
     ================================================================== */

  function registerView(id, spec) {
    if (VIEWS[id]) { ORDER.splice(ORDER.indexOf(id), 1); }
    VIEWS[id] = spec || {};
    ORDER.push(id);
    renderRail();
  }

  function renderRail() {
    var rail = document.getElementById("rail");
    if (!rail) return;
    rail.textContent = "";
    rail.appendChild(el("div", { class: "rail__brand" }, [
      el("span", { class: "rail__mark", text: "EPOK" }),
      el("span", { class: "rail__sub", text: "cycle log" })
    ]));
    var nav = el("div", { class: "rail__nav" });
    ORDER.forEach(function (id) {
      nav.appendChild(el("button", {
        type: "button",
        class: "rail__item" + (id === ACTIVE ? " is-active" : ""),
        "data-view": id,
        text: VIEWS[id].title || id.toUpperCase(),
        onclick: function () { show(id); }
      }));
    });
    rail.appendChild(nav);
  }

  function show(id) {
    if (!VIEWS[id]) id = ORDER[0];
    if (!id) return;
    ACTIVE = id;
    var main = document.getElementById("main");
    if (!main) return;
    main.textContent = "";
    var node;
    try {
      node = VIEWS[id].render ? VIEWS[id].render() : null;
    } catch (e) {
      // A view that throws must not take the shell with it — the rail has to
      // stay usable so the log is still reachable.
      node = el("section", { class: "card card--danger" }, [
        el("p", { class: "micro", text: "VIEW ERROR" }),
        el("p", { text: String(e && e.message || e) })
      ]);
      if (window.console) console.error("[epok] view " + id + " failed to render", e);
    }
    main.appendChild(node || el("section", { class: "card" }, [
      el("p", { class: "micro", text: "EMPTY" })
    ]));
    if (location.hash.slice(1) !== id) location.hash = id;
    renderRail();
    window.scrollTo(0, 0);
  }

  function refresh() {
    if (!ACTIVE) return;
    var spec = VIEWS[ACTIVE];
    if (spec && typeof spec.refresh === "function") { spec.refresh(); return; }
    show(ACTIVE);
  }

  function activeView() { return ACTIVE; }

  /* ==================================================================
     4. UI PRIMITIVES — no modals, no confirm()
     ================================================================== */

  function append(node, children) {
    if (children == null) return;
    if (!Array.isArray(children)) children = [children];
    children.forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    });
  }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class" || k === "className") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "dataset") Object.keys(v).forEach(function (d) { n.dataset[d] = v[d]; });
      else if (k.slice(0, 2) === "on" && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v === true ? "" : v);
    });
    append(n, children);
    return n;
  }

  function toast(message) {
    var host = document.getElementById("toasts");
    if (!host) return;
    var t = el("div", { class: "toast", role: "status" }, message);
    host.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, TOAST_MS);
  }

  /* One banner per id. Persistent until cleared — that is the point: a banner
     is for a state the user needs to keep seeing, not an event. `message` may
     be a string or a node. */
  function banner(id, message, opts) {
    var host = document.getElementById("banners");
    if (!host) return;
    clearBanner(id);
    var tone = (opts && opts.tone) || "info";
    host.appendChild(el("div", {
      class: "banner banner--" + tone,
      "data-banner": id,
      role: tone === "info" ? "status" : "alert"
    }, message));
  }

  function clearBanner(id) {
    var host = document.getElementById("banners");
    if (!host) return;
    var n = host.querySelector('[data-banner="' + id + '"]');
    if (n) n.parentNode.removeChild(n);
  }

  /* Reversibility over confirmation dialogs: the change happens, and this is
     how it is taken back. Only one undo is live at a time — a stack of them is
     a stack of decisions nobody can reason about. */
  function undo(label, restoreFn) {
    var host = document.getElementById("toasts");
    if (!host) return;
    var existing = host.querySelector(".undo");
    if (existing) existing.parentNode.removeChild(existing);
    if (undoTimer) clearTimeout(undoTimer);

    var node = el("div", { class: "undo", role: "status" });
    node.appendChild(el("span", { class: "undo__label", text: label }));
    node.appendChild(el("button", {
      type: "button", class: "btn btn--sm btn--accent", text: "UNDO",
      onclick: function () {
        if (node.parentNode) node.parentNode.removeChild(node);
        if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
        try { restoreFn(); } catch (e) { if (window.console) console.error("[epok] undo failed", e); }
        toast("Undone.");
      }
    }));
    host.appendChild(node);
    undoTimer = setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
      undoTimer = null;
    }, UNDO_MS);
  }

  /* ==================================================================
     5. THEME
     ================================================================== */

  function setTheme(name) {
    if (THEMES.indexOf(name) < 0) name = THEMES[0];
    document.documentElement.setAttribute("data-theme", name);
    if (window.Epok && window.Epok.Store && window.Epok.Store.setProfile) {
      window.Epok.Store.setProfile({ theme: name });
    }
  }

  function setMode(mode) {
    if (MODES.indexOf(mode) < 0) mode = "dark";
    // "system" stamps nothing, so the prefers-color-scheme rules decide.
    if (mode === "system") document.documentElement.removeAttribute("data-mode");
    else document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.setAttribute("data-mode-pref", mode);
    if (window.Epok && window.Epok.Store && window.Epok.Store.setProfile) {
      window.Epok.Store.setProfile({ mode: mode });
    }
  }

  /* ==================================================================
     EXPORT
     ================================================================== */

  var Epok = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    SECURE: window.isSecureContext === true,
    THEMES: THEMES,
    MODES: MODES,

    ymd: ymd, today: today, calendarToday: calendarToday,
    shiftDay: shiftDay, daysBetween: daysBetween,
    prettyDate: prettyDate, relDay: relDay, isKey: isKey,

    viewDate: viewDate, setViewDate: setViewDate, isBackfilling: isBackfilling,

    registerView: registerView, show: show, refresh: refresh, activeView: activeView,

    el: el, toast: toast, banner: banner, clearBanner: clearBanner, undo: undo,

    setTheme: setTheme, setMode: setMode,

    _setDayBoundary: _setDayBoundary, _dayBoundary: _dayBoundary
  };

  window.Epok = window.Epok || {};
  Object.keys(Epok).forEach(function (k) { window.Epok[k] = Epok[k]; });
})();

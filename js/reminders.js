/* ==========================================================================
   EPOK · REMINDERS

   Owner: Window A. See PLAN-epok.md § Parallel windows.

     · CAPABILITY  detected by what actually works, not by isSecureContext
     · SECURE      file:// cannot hold notification permission. Says so inline, names ./serve.sh.
     · SCHEDULING  predicted start, PMS window, daily pill. Quiet hours respected.
     · NEVER SILENT  every reminder is a ticked checkbox with its reasoning attached.

   Public namespace: Epok.Reminders
   ========================================================================== */

"use strict";

(function () {
  var E = window.Epok;

  var SERVE_CMD = "./serve.sh";
  var SERVE_URL = "http://localhost:8731";

  /* Chromium reports file:// as a SECURE context — isSecureContext is true
     there and crypto.subtle works. It is the URL *scheme* that blocks
     notifications and service workers, not trustworthiness, so detecting on
     Epok.SECURE would report reminders as available and then silently never
     fire one. Measured, not assumed: on file:// the origin is "null",
     Notification.permission is "denied" and cannot be raised, and
     serviceWorker.register() throws "The URL protocol of the current origin
     ('null') is not supported". */
  function onFileScheme() { return location.protocol === "file:"; }

  function available() {
    if (onFileScheme()) {
      return { ok: false, reason:
        "Reminders need epok to be served over http, and this copy is open straight from the " +
        "filesystem. Run " + SERVE_CMD + " in the epok folder, then open " + SERVE_URL + ". " +
        "Everything else — logging, predictions, export, the PIN — works from file:// " +
        "exactly as it does here." };
    }
    if (!("Notification" in window)) {
      return { ok: false, reason: "This browser has no notification support, so epok cannot remind you of anything." };
    }
    if (Notification.permission === "denied") {
      return { ok: false, reason:
        "Notifications are blocked for this page in your browser's site settings. epok cannot " +
        "switch them back on for you — that has to be changed in the browser." };
    }
    return { ok: true, reason: Notification.permission === "granted"
      ? "" : "epok will ask for notification permission the first time you switch a reminder on." };
  }

  function swSupported() {
    return !onFileScheme() && "serviceWorker" in navigator;
  }

  /* ==================================================================
     CONSTANTS
     ================================================================== */

  // A day's notice, not an hour's: the point is to have supplies before the
  // day, and an alert at 9pm on the day itself is news, not a reminder.
  var START_NOTICE_DAYS = 1;
  // Three days is where the app's own symptom clustering is densest. It is a
  // starting point offered with its reasoning, not a fact about anyone.
  var PMS_DAYS_BEFORE = 3;

  var TIMERS = [];

  /* ==================================================================
     PERMISSION
     ================================================================== */

  function request() {
    var a = available();
    if (!a.ok) return Promise.resolve(false);
    if (Notification.permission === "granted") return Promise.resolve(true);
    return Notification.requestPermission().then(function (p) { return p === "granted"; });
  }

  function granted() {
    return ("Notification" in window) && Notification.permission === "granted";
  }

  /* ==================================================================
     QUIET HOURS
     ------------------------------------------------------------------
     A reminder that wakes someone at 03:00 gets the notifications switched
     off entirely, and then none of them work. Anything landing inside the
     quiet span is moved to the moment it ends, never dropped.
     ================================================================== */

  function quiet() {
    var q = E.Store.get().profile.quietHours;
    return (Array.isArray(q) && q.length === 2) ? q : [22, 8];
  }

  function inQuiet(hour) {
    var q = quiet(), from = q[0], to = q[1];
    return from < to ? (hour >= from && hour < to) : (hour >= from || hour < to);
  }

  function outOfQuiet(when) {
    if (!inQuiet(when.getHours())) return when;
    var to = quiet()[1];
    var d = new Date(when.getTime());
    // Past the end hour today means the quiet span runs over midnight.
    if (d.getHours() >= to) d.setDate(d.getDate() + 1);
    d.setHours(to, 0, 0, 0);
    return d;
  }

  function atTime(key, hhmm) {
    var parts = String(hhmm || "21:00").split(":");
    var d = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
    d.setHours(Number(parts[0]) || 0, Number(parts[1]) || 0, 0, 0);
    return d;
  }

  /* ==================================================================
     WHAT THE APP KNOWS
     ================================================================== */

  function prediction() {
    var M = window.Epok.Model;
    if (!M || typeof M.predict !== "function") return null;
    var s = E.Store.get();
    try {
      var p = M.predict(E.Store.cycles(), {
        conditions: s.profile.conditions, ageBand: s.profile.ageBand, days: s.days
      });
      return (p && p.nextStart && !p.refused) ? p : null;
    } catch (e) { return null; }
  }

  function method() {
    var C = window.Epok.Contraception;
    var id = E.Store.get().profile.contraception;
    return (C && id && C.BY_ID[id]) || null;
  }

  function isPill() { var m = method(); return !!m && m.kind === "pill"; }

  /* ==================================================================
     SUGGESTIONS
     ------------------------------------------------------------------
     Every one carries the sentence that explains why it is being offered,
     because "suggest, explain, let it be unticked" needs the explanation to
     live next to the checkbox. The settings view renders these pre-ticked
     and writes nothing until the user accepts.
     ================================================================== */

  function suggestions() {
    var p = prediction();
    var m = method();
    var out = [{
      id: "predictedStart",
      label: "PERIOD DUE",
      reason: p
        ? "A day before the predicted start (" + E.prettyDate(p.nextStart) + "), from " +
          p.n + " logged cycle" + (p.n === 1 ? "" : "s") + "."
        : "A day before each predicted start. epok cannot predict one yet, so this stays quiet " +
          "until it can.",
      applies: true
    }, {
      id: "pms",
      label: "PMS WINDOW",
      reason: PMS_DAYS_BEFORE + " days before the predicted start, which is where your logged " +
              "symptoms cluster. Nothing about this is a diagnosis — it is a date, not a claim.",
      applies: true
    }];

    if (m && m.kind === "pill") {
      out.push({
        id: "pill",
        label: "DAILY PILL",
        reason: m.windowHours <= 3
          ? "Once a day at the time you set. " + m.label + " has a " + m.windowHours +
            "-hour window, so this reminder is sharper than it would be for a combined pill."
          : "Once a day at the time you set. " + m.label + " has roughly a " + m.windowHours +
            "-hour window.",
        applies: true
      });
    }
    return out;
  }

  /* ==================================================================
     SCHEDULING
     ================================================================== */

  function enabled(id) {
    var r = E.Store.get().profile.reminders || {};
    return E.Store.get().profile.remindersOn === true && r[id] === true;
  }

  /* The next moment each enabled reminder should fire, or null. Times are
     local, and every one is pushed out of the quiet span before it is used. */
  function nextMoments() {
    var s = E.Store.get();
    var r = s.profile.reminders || {};
    var out = [];
    var p = prediction();

    if (enabled("predictedStart") && p) {
      out.push({ id: "predictedStart", label: "Your period is predicted to start tomorrow.", ref: p.nextStart,
                 at: outOfQuiet(atTime(E.shiftDay(p.nextStart, -START_NOTICE_DAYS), "18:00")) });
    }
    if (enabled("pms") && p) {
      out.push({ id: "pms", label: "You are " + PMS_DAYS_BEFORE + " days from your predicted start.",
                 ref: p.nextStart,
                 at: outOfQuiet(atTime(E.shiftDay(p.nextStart, -PMS_DAYS_BEFORE), "18:00")) });
    }
    if (enabled("pill") && isPill()) {
      var when = outOfQuiet(atTime(E.today(), r.pillTime));
      // Already logged today means the next one worth firing is tomorrow's.
      if (when.getTime() <= Date.now() || E.Store.day(E.today()).pill != null) {
        when = outOfQuiet(atTime(E.shiftDay(E.today(), 1), r.pillTime));
      }
      out.push({ id: "pill", label: "Pill — " + (method().label.toLowerCase()) + ".", at: when });
    }
    return out;
  }

  function fire(id, label) {
    if (!granted()) return;
    try { new Notification("epok", { body: label, tag: id, icon: "icons/icon-192.png" }); }
    catch (e) { if (window.console) console.warn("[epok] notification failed", e); }
  }

  function clear() {
    TIMERS.forEach(clearTimeout);
    TIMERS = [];
  }

  /* setTimeout overflows past ~24.8 days and fires immediately, so nothing
     further out than a day is armed here; the next open re-arms it. */
  var MAX_AHEAD_MS = 24 * 3600 * 1000;

  /* A timer is armed hours before it fires, and the log can change in
     between. Re-checked at fire time against logged data, so a pill taken at
     20:00 or a period that arrived early never produces a stale notification. */
  function stillDue(m) {
    if (!enabled(m.id)) return false;
    if (m.id === "pill") return isPill() && E.Store.day(E.today()).pill == null;
    var p = prediction();
    return !!p && p.nextStart === m.ref;
  }

  function schedule() {
    clear();
    if (!available().ok || !granted()) return;
    nextMoments().forEach(function (m) {
      var delay = m.at.getTime() - Date.now();
      if (delay <= 0 || delay > MAX_AHEAD_MS) return;
      TIMERS.push(setTimeout(function () {
        if (stillDue(m)) fire(m.id, m.label);
        schedule();
      }, delay));
    });
  }

  /* ==================================================================
     THE IN-APP LIST
     ------------------------------------------------------------------
     There is no push server and no backend, so a notification only fires
     while epok is open. This is the half that works regardless: what was
     due and has not been acted on, derived entirely from logged data, so it
     clears itself the moment the thing is logged. No acknowledgement
     bookkeeping, and nothing to get out of step.
     ================================================================== */

  function due() {
    var s = E.Store.get();
    var r = s.profile.reminders || {};
    var today = E.today();
    var out = [];
    var p = prediction();

    if (s.profile.remindersOn && p) {
      var cs = E.Store.cycles();
      var last = cs.length ? cs[cs.length - 1].start : null;
      // Logging the start is what clears it. Nothing else needs to.
      var unlogged = !last || E.daysBetween(last, p.nextStart) > 0;
      var noticeDay = E.shiftDay(p.nextStart, -START_NOTICE_DAYS);
      var pmsDay = E.shiftDay(p.nextStart, -PMS_DAYS_BEFORE);

      if (r.predictedStart && unlogged && E.daysBetween(noticeDay, today) >= 0) {
        out.push({ id: "predictedStart", at: noticeDay,
                   label: "Period predicted for " + E.prettyDate(p.nextStart) + "." });
      } else if (r.pms && unlogged && E.daysBetween(pmsDay, today) >= 0) {
        out.push({ id: "pms", at: pmsDay,
                   label: PMS_DAYS_BEFORE + " days from your predicted start." });
      }
    }

    if (s.profile.remindersOn && r.pill && isPill() && E.Store.day(today).pill == null) {
      var when = atTime(today, r.pillTime);
      if (when.getTime() <= Date.now()) {
        out.push({ id: "pill", at: today, label: "Today's pill is not logged." });
      }
    }
    return out;
  }

  /* Nothing silently missing: what is on, when it will next fire, and what is
     stopping it if it will not. */
  function status() {
    var a = available();
    var moments = {};
    nextMoments().forEach(function (m) { moments[m.id] = m.at; });
    return suggestions().map(function (sg) {
      var on = enabled(sg.id);
      var blocked = null;
      if (on && !a.ok) blocked = a.reason;
      else if (on && !granted()) blocked = "epok does not have notification permission yet.";
      else if (on && !moments[sg.id]) {
        blocked = sg.id === "pill"
          ? "No pill method is selected."
          : "epok has no prediction to schedule against yet.";
      }
      return { id: sg.id, label: sg.label, on: on,
               scheduledFor: moments[sg.id] || null, blocked: blocked };
    });
  }

  var Reminders = {
    SERVE_CMD: SERVE_CMD,
    SERVE_URL: SERVE_URL,
    START_NOTICE_DAYS: START_NOTICE_DAYS,
    PMS_DAYS_BEFORE: PMS_DAYS_BEFORE,

    available: available,
    swSupported: swSupported,
    request: request,
    suggestions: suggestions,
    schedule: schedule,
    clear: clear,
    due: due,
    status: status,
    inQuiet: inQuiet,
    outOfQuiet: outOfQuiet,

    // Window A internals, exposed for tools/verify.py only.
    _nextMoments: nextMoments,
    _stillDue: stillDue
  };

  window.Epok = window.Epok || {};
  window.Epok.Reminders = Reminders;
})();

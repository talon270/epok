/* ==========================================================================
   EPOK · STORAGE

   Owner: Window A. See PLAN-epok.md § Parallel windows.

     · SCHEMA        one key, epok.state.v1, integer SCHEMA_VERSION
     · MIGRATION     every bump ships its migration in the same change
     · WRITE-THROUGH previous state kept at epok.state.prev before every overwrite
     · PERIOD STARTS their own path, because they are the model's only input
     · EVENTS        dated spans (pregnancy, postpartum, a method, a medication) the model reads
     · PROVENANCE    every start is "manual" or "flow"; only flow-inferred ones are ever
                     moved or removed by the app, and a rejected inference stays rejected
     · PORTABILITY   JSON backup (encrypted if the PIN is on) + plaintext CSV
     · CUSTOM TAGS   add/remove; removal refused while a logged day carries one

   Public namespace: Epok.Store
   ========================================================================== */

"use strict";

(function () {
  var E = window.Epok;

  /* ------------------------------------------------------------------
     CONSTANTS
     ------------------------------------------------------------------ */

  var KEY      = "epok.state.v1";
  var PREV_KEY = "epok.state.prev";   // A1 guard: a failed migration is recoverable

  // A burst of taps on the tag grid is one write, not thirty. Short enough
  // that closing the tab straight after a tap still lands it.
  var SAVE_DEBOUNCE_MS = 200;

  var SCHEMA_VERSION = E.SCHEMA_VERSION;

  var CONDITIONS    = ["pcos", "endometriosis", "thyroid", "perimenopause"];
  var FLOW          = ["spotting", "light", "medium", "heavy"];
  var CONTRACEPTION = ["none", "combined-21-7", "combined-24-4", "continuous",
                       "pop", "patch", "ring", "injection", "iud", "implant"];

  var STATE = null;
  var saveTimer = null;

  /* ==================================================================
     1. SHAPE
     ================================================================== */

  function blankProfile() {
    return {
      created: E.calendarToday(),
      ageBand: null,
      conditions: [],
      goal: null,
      contraception: null,
      contraceptionStart: null,
      contraceptionExpiry: null,
      dayBoundaryHour: 4,
      theme: "quasar",
      mode: "dark",
      fertilityVisible: true,
      hiddenTags: [],
      remindersOn: false,
      quietHours: [22, 8],
      // v2. Every one defaults to OFF: a reminder the user did not ask for is
      // exactly the silent configuration this app refuses to do. The settings
      // view offers them pre-ticked WITH their reasoning, and writes nothing
      // until the user accepts.
      reminders: {
        predictedStart: false,
        pms: false,
        pill: false,
        pillTime: "21:00"
      }
    };
  }

  // checkin (v3): the user said "I looked, nothing to log". It is what lets a
  // day with no tags count as a day WITHOUT symptoms rather than a day with
  // unknown ones — see insights.js correlationsSection.
  // v4: severity is {tagId: 1..3}, self-rated, no clinical scale implied.
  // impact is how much the day was affected. bbtMeta is {time, disturbed} for
  // the day's temperature — a disturbed reading is kept but not used to call
  // a rise.
  function blankDay() {
    return { flow: null, tags: [], bbt: null, lh: null, pill: null, note: "", checkin: false,
             severity: {}, impact: null, bbtMeta: null };
  }

  function blankState() {
    return {
      v: SCHEMA_VERSION,
      profile: blankProfile(),
      days: {},
      cycles: [],
      customTags: [],
      predictions: [],
      events: [],
      meta: { lastOpened: E.calendarToday(), onboarded: false, rejectedStarts: [] }
    };
  }

  /* A day with nothing in it has no key. Keeping the map sparse is what makes
     a year of history a few kilobytes instead of a few hundred. */
  function isEmptyDay(d) {
    if (!d) return true;
    return d.flow == null && d.bbt == null && d.lh == null && d.pill == null && !d.checkin && d.impact == null &&
           !(d.note && d.note.trim()) && !(d.tags && d.tags.length);
  }

  /* Fills in any field added in a later version. Cheap insurance against a
     view reading `undefined` off a day written by an older build. */
  function normaliseDay(d) {
    var base = blankDay();
    Object.keys(base).forEach(function (k) { if (!(k in d)) d[k] = base[k]; });
    if (!Array.isArray(d.tags)) d.tags = [];
    if (!d.severity || typeof d.severity !== "object") d.severity = {};
    return d;
  }

  function normalise(state) {
    var base = blankState();
    Object.keys(base).forEach(function (k) { if (!(k in state)) state[k] = base[k]; });
    var bp = blankProfile();
    Object.keys(bp).forEach(function (k) { if (!(k in state.profile)) state.profile[k] = bp[k]; });
    // Nested, so the shallow backfill above does not reach it.
    Object.keys(bp.reminders).forEach(function (k) {
      if (!(k in state.profile.reminders)) state.profile.reminders[k] = bp.reminders[k];
    });
    if (!state.days || typeof state.days !== "object") state.days = {};
    Object.keys(state.days).forEach(function (k) { normaliseDay(state.days[k]); });
    ["cycles", "customTags", "predictions", "events"].forEach(function (k) {
      if (!Array.isArray(state[k])) state[k] = [];
    });
    if (!state.meta || typeof state.meta !== "object") state.meta = {};
    if (!Array.isArray(state.meta.rejectedStarts)) state.meta.rejectedStarts = [];
    state.cycles.forEach(function (c) {
      if (c.source !== "flow") c.source = "manual";
      if (typeof c.excluded !== "boolean") c.excluded = false;
    });
    sortCycles(state);
    return state;
  }

  /* ==================================================================
     2. MIGRATION
     ------------------------------------------------------------------
     One function per version step, applied in order. v1 is the first
     schema, so there is nothing to run yet — but the path exists from day
     one, because the change that needs it is the change that must not also
     be the change that invents it.
     ================================================================== */

  var MIGRATIONS = {
    /* v1 -> v2: per-reminder toggles. A single remindersOn boolean could not
       express "remind me when a period is due but not about PMS", and a
       checkbox per reminder is the only shape that lets one be left unticked.
       Everything is added switched OFF, including for someone who already had
       remindersOn true — inheriting a reminder nobody chose is the failure
       this whole design exists to avoid. */
    2: function (s) {
      var r = (s.profile && s.profile.reminders) || {};
      s.profile.reminders = {
        predictedStart: r.predictedStart === true,
        pms: r.pms === true,
        pill: r.pill === true,
        pillTime: typeof r.pillTime === "string" ? r.pillTime : "21:00"
      };
      s.v = 2;
      return s;
    },

    /* v2 -> v3: where a period start came from, and a way to say "no symptoms
       today". Every existing start becomes "manual": a v2 build could not tell
       a start the user marked from one it inferred out of the flow log, and the
       only safe reading is that the user owns all of them — the app only ever
       moves or removes starts it can prove it inferred, so nothing already
       saved can be touched by this change. Purely additive. */
    3: function (s) {
      (s.cycles || []).forEach(function (c) { if (c.source !== "flow") c.source = "manual"; });
      s.meta = s.meta || {};
      if (!Array.isArray(s.meta.rejectedStarts)) s.meta.rejectedStarts = [];
      Object.keys(s.days || {}).forEach(function (k) {
        if (s.days[k] && typeof s.days[k].checkin !== "boolean") s.days[k].checkin = false;
      });
      s.v = 3;
      return s;
    },

    /* v3 -> v4: events, severity, temperature notes, and a way to leave a cycle
       out of the fit. Purely additive. The one derived thing is the current
       contraception method: it becomes an OPEN event, so the span is on record
       the day the method is later changed (before, stopping a method erased
       that its cycles were not natural ones). profile.contraception and
       contraceptionStart are left exactly as they were — read, never moved —
       so rolling back to a v3 build loses nothing. */
    4: function (s) {
      s.events = Array.isArray(s.events) ? s.events : [];
      var p = s.profile || {};
      if (p.contraception && !s.events.some(function (e) { return e.type === "contraception" && e.to == null; })) {
        s.events.push({ id: "ev-migrated-" + p.contraception, type: "contraception", method: p.contraception,
                        from: p.contraceptionStart || null, to: null, note: "" });
      }
      (s.cycles || []).forEach(function (c) { if (typeof c.excluded !== "boolean") c.excluded = false; });
      Object.keys(s.days || {}).forEach(function (k) {
        var d = s.days[k]; if (!d) return;
        if (!d.severity || typeof d.severity !== "object") d.severity = {};
        if (!("impact" in d)) d.impact = null;
        if (!("bbtMeta" in d)) d.bbtMeta = null;
      });
      s.v = 4;
      return s;
    }
  };

  function migrate(state) {
    var from = Number(state.v) || 0;

    /* Migrations run BEFORE normalise(), because a migration has to see the
       old shape to convert it. That means they receive genuinely arbitrary
       data — including a pre-versioned state that never had a profile at all.
       Guaranteeing the containers here, once, is why no individual migration
       has to defend itself against a missing one. Found by running:
       a state with no `v` and no `profile` crashed migration 2 and silently
       loaded blank. */
    if (!state.profile || typeof state.profile !== "object") state.profile = {};
    if (!state.days || typeof state.days !== "object") state.days = {};
    if (!state.meta || typeof state.meta !== "object") state.meta = {};
    ["cycles", "customTags", "predictions", "events"].forEach(function (k) {
      if (!Array.isArray(state[k])) state[k] = [];
    });

    if (from > SCHEMA_VERSION) {
      // Newer data than this build understands. Refusing beats guessing:
      // a partial read written back would truncate real history.
      throw new Error("state is schema v" + from + ", this build understands v" + SCHEMA_VERSION);
    }
    for (var v = from + 1; v <= SCHEMA_VERSION; v++) {
      if (MIGRATIONS[v]) state = MIGRATIONS[v](state);
    }
    state.v = SCHEMA_VERSION;
    return state;
  }

  /* ==================================================================
     3. LOAD / SAVE
     ================================================================== */

  function readRaw(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  /* An encrypted state is a JSON envelope with an `enc` marker rather than a
     `v`. Detecting it by shape (not by a separate flag key) means a copied or
     restored localStorage can never disagree with itself about whether the
     data is sealed. */
  function isSealed(raw) {
    if (!raw || raw.charAt(0) !== "{") return false;
    try { var o = JSON.parse(raw); return !!(o && o.enc === 1 && o.ct); }
    catch (e) { return false; }
  }

  function tryParse(raw) {
    if (!raw) return null;
    var parsed = JSON.parse(raw);         // caller catches
    if (!parsed || typeof parsed !== "object") throw new Error("state is not an object");
    return normalise(migrate(parsed));
  }

  function load() {
    var raw = readRaw(KEY);
    if (!raw) { STATE = blankState(); applyProfile(); return STATE; }

    /* Sealed data must never be loaded as if it were state. Boot checks
       Epok.Lock first, so reaching here with a sealed blob means something
       went wrong — refuse, loudly, and write nothing. */
    if (isSealed(raw)) {
      STATE = blankState();
      STATE.__readonly = true;
      E.banner("locked",
        "Your data is encrypted and this session has no key. Nothing has been changed. " +
        "Reload and enter your PIN.", { tone: "danger" });
      applyProfile();
      return STATE;
    }

    try {
      STATE = tryParse(raw);
    } catch (err) {
      // A1 guard. The live copy is unreadable; the last committed one may not
      // be. Falling back is silent recovery, so it gets a persistent banner —
      // the user has to know the app is not showing them their newest day.
      var prev = null;
      try { prev = tryParse(readRaw(PREV_KEY)); } catch (e2) { prev = null; }
      if (prev) {
        STATE = prev;
        E.banner("recovered",
          "Your saved data could not be read (" + err.message + "). epok has fallen back to " +
          "the previous save. Export a backup before logging anything else.",
          { tone: "danger" });
      } else {
        STATE = blankState();
        E.banner("recovered",
          "Your saved data could not be read (" + err.message + ") and there is no recoverable " +
          "previous save. Nothing has been overwritten yet — do not log anything until you " +
          "have copied epok.state.v1 out of this browser's local storage.",
          { tone: "danger" });
        // Loading blank must not be allowed to overwrite the unreadable
        // original, or the recovery advice above becomes a lie.
        STATE.__readonly = true;
      }
    }
    applyProfile();
    return STATE;
  }

  function commit(text) {
    try {
      var current = readRaw(KEY);
      // Write-through, before the overwrite. One extra setItem per save is
      // what turns every schema mistake into a recoverable one.
      if (current) localStorage.setItem(PREV_KEY, current);
      localStorage.setItem(KEY, text);
      // Opt-in sync (js/sync.js) follows saves; with it off this is a no-op.
      if (Store._onSaved) { try { Store._onSaved(); } catch (e2) { /* sync must never break a save */ } }
    } catch (e) {
      E.banner("storage-full",
        "epok could not save (" + (e && e.name || "error") + "). Your last changes are only in " +
        "this tab. Export a backup now.", { tone: "danger" });
    }
  }

  function serialise() {
    return JSON.stringify(STATE, function (k, v) { return k === "__readonly" ? undefined : v; });
  }

  /* ==================================================================
     3b. FORECAST SNAPSHOTS
     ------------------------------------------------------------------
     state.predictions has been in the schema since v1 and nothing wrote it, so
     the "past predictions" the app showed were always retrospective
     reconstructions. This writes the forecast that was actually on screen:
     when a cycle first has one, and whenever the evidence moves it. One per
     cycle per day (a later one the same day replaces it). When the next period
     is logged, the snapshot is settled against what happened — signed days
     (positive = forecast later than the real start) and inside/outside the window.
     ================================================================== */

  function snapshotForecast() {
    var M = window.Epok && window.Epok.Model;
    if (!M || !STATE || STATE.__readonly) return;
    var cs = sortCycles(STATE), preds = STATE.predictions, i;

    preds.forEach(function (sn) {
      if (sn.actual != null || sn.void) return;
      var at = -1;
      for (i = 0; i < cs.length; i++) if (cs[i].start === sn.anchor) at = i;
      if (at < 0) { sn.void = true; return; }                  // that start was moved or removed
      if (cs[at + 1]) {
        sn.actual = cs[at + 1].start;
        sn.errorDays = E.daysBetween(sn.actual, sn.nextStart);
        sn.inWindow = !!sn.window && sn.actual >= sn.window[0] && sn.actual <= sn.window[1];
      }
    });

    if (!cs.length) return;
    var o = modelOpts(); o.noMae = true;
    var p;
    try { p = M.predict(cs, o); } catch (e) { return; }
    if (!p || p.refused || !p.nextStart || p.expired) return;

    var anchor = cs[cs.length - 1].start, today = E.calendarToday();
    var mine = preds.filter(function (sn) { return sn.anchor === anchor && !sn.void; });
    var last = mine[mine.length - 1];
    if (last && last.nextStart === p.nextStart && last.window && last.window[0] === p.window[0] &&
        last.window[1] === p.window[1]) return;
    var rec = {
      madeOn: today, anchor: anchor, nextStart: p.nextStart, window: p.window, mode: p.mode, n: p.n,
      modelVersion: M.MODEL_VERSION || 0, inputRev: cs.length + ":" + anchor + ":" + p.n,
      actual: null, errorDays: null, inWindow: null
    };
    if (last && last.madeOn === today && last.actual == null) preds[preds.indexOf(last)] = rec;
    else preds.push(rec);
  }

  function writeNow() {
    if (!STATE) return;
    if (STATE.__readonly) return;
    snapshotForecast();
    var next;
    try { next = serialise(); }
    catch (e) { E.toast("Could not serialise state."); return; }

    /* With the PIN on, the write goes through AES-GCM, which is async. The
       cost of that is a window of up to SAVE_DEBOUNCE_MS plus one encryption
       in which a tab killed outright loses the last tap. It is stated here
       rather than hidden: the alternative is plaintext at rest, which is the
       thing the PIN exists to prevent. */
    if (Store._cipher) {
      return Store._cipher(next).then(commit).catch(function (err) {
        E.banner("storage-full",
          "epok could not encrypt your last change (" + (err && err.message || err) + "). " +
          "It is only in this tab. Export a backup now.", { tone: "danger" });
      });
    }
    commit(next);
  }

  /* Handed the decrypted plaintext by Epok.Lock after a successful unlock.
     Window A internal; boot is the only caller. */
  function _adopt(text) {
    STATE = tryParse(text);
    applyProfile();
    return STATE;
  }

  /* The plaintext the lock screen seals when encryption is switched on, and
     the plaintext restored when it is switched off. */
  function _plaintext() { return serialise(); }

  function save() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; writeNow(); }, SAVE_DEBOUNCE_MS);
  }

  /* Returns a promise that settles once the write has actually landed, which
     with the PIN on means once AES-GCM has finished. Export calls this first;
     without it an exported file can lag the last few hundred milliseconds of
     edits, and a backup that quietly omits today's log is worse than no
     backup. */
  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    return writeNow() || Promise.resolve();
  }

  /* The profile carries settings core needs but cannot read for itself,
     because core loads first. */
  function applyProfile() {
    E._setDayBoundary(STATE.profile.dayBoundaryHour);
    E.setTheme(STATE.profile.theme);
    E.setMode(STATE.profile.mode);
  }

  /* ==================================================================
     4. DAYS
     ================================================================== */

  function get() { return STATE || load(); }

  function day(key) {
    var s = get();
    return s.days[key || E.viewDate()] || blankDay();
  }

  function editDay(key, patch) {
    var s = get();
    key = key || E.viewDate();
    if (!E.isKey(key)) { E.toast("Refused: " + key + " is not a date."); return; }
    var d = s.days[key] || blankDay();
    Object.keys(patch).forEach(function (k) { d[k] = patch[k]; });
    normaliseDay(d);
    if (isEmptyDay(d)) delete s.days[key];
    else s.days[key] = d;
    save();
    E.refresh();
    // Logging flow is how a period is noticed; extract its start rather than
    // also requiring MARK PERIOD START for the same day. Runs on a CLEARED
    // flow too: otherwise an inferred start outlived the only day that
    // justified it.
    if ("flow" in patch) deriveCyclesFromFlow();
  }

  /* ==================================================================
     5. CYCLES
     ================================================================== */

  function sortCycles(s) {
    s.cycles.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
    // length is days to the NEXT start, so it is derived, never typed. Only
    // the last cycle may be open.
    for (var i = 0; i < s.cycles.length; i++) {
      var c = s.cycles[i], next = s.cycles[i + 1];
      c.length = next ? E.daysBetween(c.start, next.start) : null;
    }
    return s.cycles;
  }

  function cycles() { return sortCycles(get()); }

  function currentCycleDay() {
    var cs = cycles();
    if (!cs.length) return null;
    var last = cs[cs.length - 1];
    var n = E.daysBetween(last.start, E.today());
    return n < 0 ? null : n + 1;
  }

  /* ==================================================================
     6. PERIOD STARTS
     ------------------------------------------------------------------
     The only date the model consumes, so it gets its own path rather than
     riding in on editDay(). Two guards live here:

       · a start inside MERGE_WINDOW_DAYS of an existing one is a CORRECTION
         to that start, never a second cycle. Bleeding that restarts within a
         week is the same period; letting a stray tap mint a 4-day "cycle"
         would poison every prediction that follows it.
       · nothing commits without an undo, and preview() hands the view the
         consequence BEFORE it commits, so the view can state it inline
         instead of asking a modal question.
     ================================================================== */

  var MERGE_WINDOW_DAYS = 7;

  // source: "manual" (user marked or moved it) or "flow" (inferred from the
  // flow log, and the only kind the app may later move or remove).
  function blankCycle(start, source) {
    return { start: start, end: null, length: null, ovulation: null, ovulationSource: null,
             source: source || "manual", excluded: false };
  }

  /* The existing start this key would correct, or null if it is a new cycle. */
  function startNear(key) {
    var cs = cycles(), best = null, bestGap = Infinity;
    for (var i = 0; i < cs.length; i++) {
      var gap = Math.abs(E.daysBetween(cs[i].start, key));
      if (gap === 0) return cs[i];
      if (gap <= MERGE_WINDOW_DAYS && gap < bestGap) { best = cs[i]; bestGap = gap; }
    }
    return best;
  }

  /* Window B owns the model and may not have landed yet. A missing engine
     means "no prediction to show", never a thrown boot. */
  /* The one place the model's inputs are assembled. Every view used to build
     {conditions, ageBand, days} for itself, which is how contraception and the
     as-of date came to be missing from all of them at once. */
  function modelOpts() {
    var p = get().profile, C = E.Contraception;
    var m = p.contraception && C && C.BY_ID[p.contraception];
    return {
      conditions: p.conditions, ageBand: p.ageBand, days: get().days,
      events: get().events,
      asOf: E.today(),
      contraception: p.contraception
        ? { id: p.contraception, label: m ? m.label : p.contraception, start: p.contraceptionStart || null }
        : null
    };
  }

  function predictedStart(list) {
    var M = window.Epok.Model;
    if (!M || typeof M.predict !== "function") return null;
    try {
      var o = modelOpts(); o.noMae = true;
      var p = M.predict(list, o);
      return (p && p.nextStart) || null;
    } catch (e) {
      if (window.console) console.warn("[epok] model refused to predict", e);
      return null;
    }
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  /* What applying this start would do to the cycle list — computed on a copy,
     so previewing never touches stored state. */
  function withStart(key) {
    var next = clone(cycles());
    var near = startNear(key);
    if (near) {
      for (var i = 0; i < next.length; i++) {
        if (next[i].start !== near.start) continue;
        next[i].start = key;
        next[i].source = "manual";                // the user moved it; it is theirs now
        // An end before the new start is now nonsense; drop it rather than
        // keep a cycle that bleeds before it begins.
        if (next[i].end && E.daysBetween(key, next[i].end) < 0) next[i].end = null;
      }
    } else {
      next.push(blankCycle(key, "manual"));
    }
    next.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
    for (var j = 0; j < next.length; j++) {
      next[j].length = next[j + 1] ? E.daysBetween(next[j].start, next[j + 1].start) : null;
    }
    return next;
  }

  function previewPeriodStart(key) {
    var near = startNear(key);
    return {
      from: near ? near.start : null,
      to: key,
      predictionBefore: predictedStart(cycles()),
      predictionAfter: predictedStart(withStart(key))
    };
  }

  function setPeriodStart(key) {
    var s = get();
    if (!E.isKey(key)) { E.toast("Refused: " + key + " is not a date."); return; }
    if (E.daysBetween(key, E.today()) < 0) {
      E.toast("Refused: " + E.prettyDate(key) + " has not happened yet.");
      return;
    }
    var before = clone(s.cycles), beforeRej = clone(s.meta.rejectedStarts);
    var near = startNear(key);
    if (near && near.start === key) {
      // Marking an inferred start by hand adopts it: from here on the flow log
      // can no longer move or remove it.
      if (near.source === "flow") { near.source = "manual"; save(); E.refresh(); }
      return;
    }

    s.cycles = withStart(key);
    s.meta.rejectedStarts = s.meta.rejectedStarts.filter(function (k) { return k !== key; });
    save();
    E.refresh();

    E.undo(near
      ? "Period start moved from " + E.prettyDate(near.start) + " to " + E.prettyDate(key) + "."
      : "Period start recorded on " + E.prettyDate(key) + ".",
      function () { get().cycles = before; get().meta.rejectedStarts = beforeRej; save(); E.refresh(); });
  }

  function clearPeriodStart(key) {
    var s = get();
    var before = clone(s.cycles), beforeRej = clone(s.meta.rejectedStarts);
    var kept = s.cycles.filter(function (c) { return c.start !== key; });
    if (kept.length === s.cycles.length) { E.toast("No period start on " + E.prettyDate(key) + "."); return; }
    s.cycles = kept;
    // Removing a start the flow log would re-infer is a decision, so it is
    // recorded; otherwise the next flow edit quietly puts it back.
    if (flowStreakStarts(s.days).indexOf(key) >= 0 && s.meta.rejectedStarts.indexOf(key) < 0) {
      s.meta.rejectedStarts.push(key);
    }
    sortCycles(s);
    save();
    E.refresh();
    E.undo("Period start on " + E.prettyDate(key) + " removed.",
      function () { get().cycles = before; get().meta.rejectedStarts = beforeRej; save(); E.refresh(); });
  }

  /* The first bleeding day of each flow streak. A streak is a run of logged
     flow days with no gap over a day; SPOTTING keeps a streak going but is
     never what starts one, because spotting alone is not a period — one tap
     used to mint a whole cycle, and a cycle is the model's training data. */
  function flowStreakStarts(days) {
    var keys = Object.keys(days).filter(function (k) { return days[k] && days[k].flow; }).sort();
    var starts = [], prev = null, found = false;
    keys.forEach(function (k) {
      if (!prev || E.daysBetween(prev, k) > 1) found = false;
      if (!found && days[k].flow !== "spotting") { starts.push(k); found = true; }
      prev = k;
    });
    return starts;
  }

  /* Reconciles the INFERRED starts with the flow log, in both directions.
     Starts marked or moved by hand (source "manual") are never touched, and a
     flow start within the merge window of one is covered by it rather than
     duplicated. Starts the user removed (meta.rejectedStarts) are not
     re-inferred. An inferred start whose flow day was cleared is removed, and
     one whose streak now begins earlier (a backfilled day) moves with it —
     before, an inferred start was permanent and never revised. One combined
     undo. Returns the starts it created. */
  function deriveCyclesFromFlow() {
    var s = get();
    var before = clone(s.cycles);
    var rejected = s.meta.rejectedStarts || [];
    var desired = flowStreakStarts(s.days).filter(function (k) { return rejected.indexOf(k) < 0; });
    var next = s.cycles.filter(function (c) { return c.source !== "flow"; });
    var old = s.cycles.filter(function (c) { return c.source === "flow"; });
    var added = [], moved = 0;

    function within(c, k) { return Math.abs(E.daysBetween(c.start, k)) <= MERGE_WINDOW_DAYS; }
    desired.forEach(function (k) {
      if (next.some(function (c) { return within(c, k); })) return;
      var reuse = null;
      old.forEach(function (c) {
        if (!c.__taken && within(c, k) &&
            (!reuse || Math.abs(E.daysBetween(c.start, k)) < Math.abs(E.daysBetween(reuse.start, k)))) reuse = c;
      });
      if (reuse) {
        reuse.__taken = true;
        if (reuse.start !== k) { reuse.start = k; moved++; }
        if (reuse.end && E.daysBetween(k, reuse.end) < 0) reuse.end = null;
        next.push(reuse);
      } else {
        next.push(blankCycle(k, "flow"));
        added.push(k);
      }
    });
    var removed = old.filter(function (c) { return !c.__taken; }).length;
    old.forEach(function (c) { delete c.__taken; });
    if (!added.length && !moved && !removed) return added;

    s.cycles = next;
    sortCycles(s);
    save();
    E.refresh();
    var parts = [];
    if (added.length) parts.push(added.length === 1
      ? "period start extracted from your flow log: " + E.prettyDate(added[0])
      : added.length + " period starts extracted from your flow log");
    if (moved) parts.push(moved + " inferred start" + (moved === 1 ? "" : "s") + " moved to match the flow log");
    if (removed) parts.push(removed + " inferred start" + (removed === 1 ? "" : "s") + " removed because its flow was cleared");
    E.undo(parts.join("; ").replace(/^./, function (c) { return c.toUpperCase(); }) + ".",
      function () { get().cycles = before; save(); E.refresh(); });
    return added;
  }

  /* ==================================================================
     7. PORTABILITY
     ------------------------------------------------------------------
     The user's data is theirs and must be extractable. Two formats, and the
     tradeoff between them is stated at the button rather than buried:

       JSON  restores completely, and is encrypted whenever the PIN is on —
             so it is only as recoverable as the PIN is memorable.
       CSV   opens in any spreadsheet and is ALWAYS plaintext, including when
             the PIN is on. That is the tradeoff: readable everywhere means
             readable by anyone who finds the file.
     ================================================================== */

  var EXPORT_NOTES = {
    json: "Restores everything, exactly. Encrypted with your PIN if encryption is on \u2014 " +
          "which means this file is unopenable without that PIN, by anyone.",
    csv:  "Opens in any spreadsheet. Always plaintext, even when encryption is on: anyone " +
          "who opens the file can read your log. It is a copy to read, not a backup to restore."
  };

  function exportFileName(ext) {
    return "epok-" + E.calendarToday() + "." + ext;
  }

  /* Sealed when the PIN is on, because the export path must not be a way
     around the lock. Call flush() first; see the note there. */
  function exportJSON() {
    var raw = readRaw(KEY);
    if (Store._cipher && isSealed(raw)) return new Blob([raw], { type: "application/json" });
    return new Blob([serialise()], { type: "application/json" });
  }

  function csvCell(v) {
    if (v == null) return "";
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCSV() {
    var s = get();
    var cs = cycles();
    var starts = {};
    cs.forEach(function (c) { starts[c.start] = true; });

    // Every day that carries anything, plus every period start, ascending.
    var keys = Object.keys(s.days).concat(Object.keys(starts));
    keys = keys.filter(function (k, i) { return keys.indexOf(k) === i; }).sort();

    var head = ["date", "cycle_day", "period_start", "flow", "tags", "bbt_c", "lh", "pill", "note"];
    var rows = [head.join(",")];

    keys.forEach(function (k) {
      var d = s.days[k] || blankDay();
      // Which cycle contains this day, so the CSV is readable without
      // recomputing the cycle boundaries in a spreadsheet.
      var cycleDay = "";
      for (var i = cs.length - 1; i >= 0; i--) {
        if (E.daysBetween(cs[i].start, k) >= 0) { cycleDay = E.daysBetween(cs[i].start, k) + 1; break; }
      }
      rows.push([
        k, cycleDay, starts[k] ? "yes" : "",
        d.flow || "", (d.tags || []).join(";"),
        d.bbt == null ? "" : d.bbt, d.lh || "", d.pill || "", d.note || ""
      ].map(csvCell).join(","));
    });

    // The BOM is what makes Excel read UTF-8 notes correctly instead of mojibake.
    return new Blob(["\ufeff" + rows.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
  }

  function importJSON(text) {
    if (typeof text !== "string" || !text.trim()) return { ok: false, error: "The file is empty." };
    if (isSealed(text)) {
      return { ok: false, error:
        "That file is encrypted. Switch encryption off first, or restore it in a browser where " +
        "you can enter its PIN \u2014 epok cannot open it from here." };
    }
    var incoming;
    try { incoming = tryParse(text); }
    catch (err) {
      return { ok: false, error: "That file is not an epok backup (" + err.message + ")." };
    }

    var before = JSON.parse(serialise());
    var days = Object.keys(incoming.days).length;
    STATE = incoming;
    applyProfile();
    save();
    E.refresh();
    E.undo("Restored " + days + " logged day" + (days === 1 ? "" : "s") +
           " and " + incoming.cycles.length + " cycle" + (incoming.cycles.length === 1 ? "" : "s") +
           ". Your previous log was replaced.",
      function () { STATE = before; applyProfile(); save(); E.refresh(); });
    return { ok: true, error: null };
  }

  /* ==================================================================
     8. PROFILE
     ================================================================== */

  function setProfile(patch) {
    var s = get();
    var boundaryChanged = ("dayBoundaryHour" in patch) &&
                          Number(patch.dayBoundaryHour) !== Number(s.profile.dayBoundaryHour);
    var oldMethod = s.profile.contraception, oldStart = s.profile.contraceptionStart;
    var changed = false;
    Object.keys(patch).forEach(function (k) {
      if (s.profile[k] !== patch[k]) { s.profile[k] = patch[k]; changed = true; }
    });
    if (!changed) return;
    if (boundaryChanged) E._setDayBoundary(s.profile.dayBoundaryHour);
    syncMethodEvents(s, oldMethod, oldStart);
    save();
  }

  /* The current contraception method lives on the profile (the picker writes
     it) AND as an open event, so that the day it changes its span is already
     on record — stopping a method used to erase the fact that the cycles on
     it were not natural ones. The model reads only CLOSED contraception events
     and takes the current method from the profile, so nothing is counted twice. */
  function syncMethodEvents(s, oldMethod, oldStart) {
    var p = s.profile;
    var open = s.events.filter(function (e) { return e.type === "contraception" && e.to == null; });
    if (p.contraception !== oldMethod) {
      var today = E.calendarToday(), closed = false;
      open.forEach(function (e) {
        e.to = (e.from && today < e.from) ? e.from : today; closed = true;
      });
      if (oldMethod && !closed) {
        s.events.push({ id: newEventId(), type: "contraception", method: oldMethod,
                        from: oldStart || null, to: today, note: "" });
        closed = true;
      }
      if (closed) E.toast("Recorded your previous method as an event, so its cycles stay out of the fit.");
      if (p.contraception) {
        s.events.push({ id: newEventId(), type: "contraception", method: p.contraception,
                        from: p.contraceptionStart || null, to: null, note: "" });
      }
    } else if (p.contraceptionStart !== oldStart && open.length) {
      open[0].from = p.contraceptionStart || null;
    }
  }

  /* ==================================================================
     8b. EVENTS
     ------------------------------------------------------------------
     Dated spans the user states: pregnancy, postpartum, breastfeeding, a
     method, a medication. The model drops cycles that overlap a pregnancy,
     postpartum or ovulation-suppressing span from its fit, and pauses while
     one is open. A span with no `from` is "unknown start" and covers
     everything before its end. Nothing here gives advice.
     ================================================================== */

  var EVENT_TYPES = ["pregnancy", "postpartum", "breastfeeding", "contraception", "medication", "other"];

  function newEventId() {
    return "ev-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  function addEvent(ev) {
    var s = get();
    if (!ev || EVENT_TYPES.indexOf(ev.type) < 0) return { ok: false, error: "Pick what kind of event this is." };
    if (ev.from && !E.isKey(ev.from)) return { ok: false, error: "The start is not a date." };
    if (ev.to && !E.isKey(ev.to)) return { ok: false, error: "The end is not a date." };
    if (ev.from && ev.to && ev.to < ev.from) return { ok: false, error: "The end is before the start." };
    if (ev.type === "contraception" && !(window.Epok.Contraception && window.Epok.Contraception.BY_ID[ev.method])) {
      return { ok: false, error: "Pick which method." };
    }
    var rec = { id: newEventId(), type: ev.type, method: ev.type === "contraception" ? ev.method : null,
                from: ev.from || null, to: ev.to || null, note: String(ev.note || "").slice(0, 120) };
    var before = clone(s.events);
    s.events.push(rec);
    save(); E.refresh();
    E.undo("Event added.", function () { get().events = before; save(); E.refresh(); });
    return { ok: true, error: null, id: rec.id };
  }

  function endEvent(id, to) {
    var s = get(), ev = s.events.filter(function (e) { return e.id === id; })[0];
    if (!ev) return { ok: false, error: "No such event." };
    if (!E.isKey(to) || (ev.from && to < ev.from)) return { ok: false, error: "That end date is before the start." };
    var before = clone(s.events);
    ev.to = to;
    save(); E.refresh();
    E.undo("Event ended.", function () { get().events = before; save(); E.refresh(); });
    return { ok: true, error: null };
  }

  function removeEvent(id) {
    var s = get(), before = clone(s.events);
    var kept = s.events.filter(function (e) { return e.id !== id; });
    if (kept.length === s.events.length) return { ok: false, error: "No such event." };
    s.events = kept;
    save(); E.refresh();
    E.undo("Event removed.", function () { get().events = before; save(); E.refresh(); });
    return { ok: true, error: null };
  }

  /* ==================================================================
     8a. REMOTE RECORDS (opt-in sync)
     ------------------------------------------------------------------
     js/sync.js hands changed records here by logical key. Written through the
     normal normalisers, so a record from another device or an older build can
     never put a malformed shape into state. Saving goes through save(), which
     writes epok.state.prev first — the state this overwrites stays recoverable.
     ================================================================== */

  function applyRemote(changes) {
    var s = get();
    changes.forEach(function (c) {
      var k = c.k, v = c.v;
      if (k.indexOf("day:") === 0) {
        var key = k.slice(4);
        if (!E.isKey(key)) return;
        if (v == null) { delete s.days[key]; return; }
        var d = normaliseDay(clone(v));
        if (isEmptyDay(d)) delete s.days[key]; else s.days[key] = d;
      } else if (k === "blob:cycles") {
        s.cycles = Array.isArray(v) ? clone(v) : [];
        s.cycles.forEach(function (cy) {
          if (cy.source !== "flow") cy.source = "manual";
          if (typeof cy.excluded !== "boolean") cy.excluded = false;
        });
        sortCycles(s);
      } else if (k === "blob:events") { s.events = Array.isArray(v) ? clone(v) : []; }
      else if (k === "blob:customTags") { s.customTags = Array.isArray(v) ? clone(v) : []; }
      else if (k === "blob:predictions") { s.predictions = Array.isArray(v) ? clone(v) : []; }
      else if (k === "blob:rejected") { s.meta.rejectedStarts = Array.isArray(v) ? v.slice() : []; }
      else if (k === "blob:profile" && v && typeof v === "object") {
        Object.keys(v).forEach(function (f) { s.profile[f] = v[f]; });
      }
    });
    save();
    E.refresh();
  }

  /* ==================================================================
     8c. CYCLE REVIEW
     ================================================================== */

  /* Leave a cycle out of the fit without deleting it. Its length is still
     shown everywhere; the model just does not learn from it. */
  function setCycleExcluded(start, flag) {
    var s = get(), c = s.cycles.filter(function (x) { return x.start === start; })[0];
    if (!c) return { ok: false, error: "No cycle starts on " + start + "." };
    var before = clone(s.cycles);
    c.excluded = !!flag;
    save(); E.refresh();
    E.undo(flag ? "Cycle left out of the fit." : "Cycle counted in the fit again.",
      function () { get().cycles = before; save(); E.refresh(); });
    return { ok: true, error: null };
  }

  /* Move a start to any date, not only within the merge window. Refuses a
     date that would land on or within the merge window of ANOTHER start —
     that is a merge, and merging is its own action. A moved start is the
     user's, so it becomes "manual". */
  function moveStart(from, to) {
    var s = get();
    if (!E.isKey(to)) return { ok: false, error: "That is not a date." };
    if (E.daysBetween(to, E.today()) < 0) return { ok: false, error: "That date has not happened yet." };
    var c = s.cycles.filter(function (x) { return x.start === from; })[0];
    if (!c) return { ok: false, error: "No cycle starts on " + from + "." };
    var clash = s.cycles.some(function (x) {
      return x !== c && Math.abs(E.daysBetween(x.start, to)) <= MERGE_WINDOW_DAYS;
    });
    if (clash) return { ok: false, error: "That is within " + MERGE_WINDOW_DAYS +
      " days of another start. To combine two cycles, remove one start instead." };
    var before = clone(s.cycles);
    c.start = to; c.source = "manual";
    if (c.end && E.daysBetween(to, c.end) < 0) c.end = null;
    sortCycles(s);
    save(); E.refresh();
    E.undo("Period start moved to " + E.prettyDate(to) + ".", function () { get().cycles = before; save(); E.refresh(); });
    return { ok: true, error: null };
  }

  /* ==================================================================
     9. CUSTOM TAGS
     ------------------------------------------------------------------
     Ids are stable forever, same rule as the built-in vocabulary: a logged
     day stores the id, never the label. Removal is therefore refused while
     any day still carries the tag — deleting it would leave those days
     holding an id nothing can name, which is history losing its meaning
     without a word. Hiding (profile.hiddenTags) is the path for "stop
     offering me this", and it works on custom tags too.
     ================================================================== */

  // Long enough for "PELVIC FLOOR PHYSIO", short enough to stay one chip.
  var MAX_TAG_LABEL = 24;

  function tagSlug(label) {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tag";
  }

  function daysCarrying(id) {
    var days = get().days;
    return Object.keys(days).filter(function (k) { return (days[k].tags || []).indexOf(id) >= 0; }).length;
  }

  function addCustomTag(label, category) {
    var s = get();
    label = String(label == null ? "" : label).trim().replace(/\s+/g, " ").toUpperCase();
    if (!label) return { ok: false, error: "A tag needs a name.", id: null };
    if (label.length > MAX_TAG_LABEL) {
      return { ok: false, error: "Keep it to " + MAX_TAG_LABEL + " characters or fewer.", id: null };
    }
    var cats = (E.Tags && E.Tags.CATEGORIES) || [];
    if (!cats.some(function (c) { return c.id === category; })) {
      return { ok: false, error: "\"" + category + "\" is not a tag category.", id: null };
    }
    var all = ((E.Tags && E.Tags.ALL) || []).concat(s.customTags);
    var twin = all.filter(function (t) { return t.category === category && t.label.toUpperCase() === label; })[0];
    if (twin) return { ok: false, error: label + " already exists in " + category + ".", id: twin.id };

    var base = "custom-" + tagSlug(label), id = base, n = 2;
    while (all.some(function (t) { return t.id === id; })) id = base + "-" + n++;

    s.customTags.push({ id: id, label: label, category: category });
    save();
    E.refresh();
    // Undo goes through the same guard: if the tag was logged in the meantime,
    // undoing the add must not orphan that day either.
    E.undo("Tag " + label + " added.", function () {
      var r = removeCustomTag(id, true);
      if (!r.ok) E.toast(r.error);
    });
    return { ok: true, error: null, id: id };
  }

  function removeCustomTag(id, silent) {
    var s = get();
    var i = s.customTags.map(function (t) { return t.id; }).indexOf(id);
    if (i < 0) return { ok: false, error: "No custom tag " + id + "." };
    var used = daysCarrying(id);
    if (used) {
      return { ok: false, error: "It is on " + used + " logged day" + (used === 1 ? "" : "s") +
        ". Removing it would leave those days with a tag nothing can name — hide it instead." };
    }
    var gone = s.customTags.splice(i, 1)[0];
    save();
    E.refresh();
    if (!silent) {
      E.undo("Tag " + gone.label + " removed.", function () {
        get().customTags.splice(i, 0, gone); save(); E.refresh();
      });
    }
    return { ok: true, error: null };
  }

  /* ==================================================================
     EXPORT
     ================================================================== */

  var Store = {
    CONDITIONS: CONDITIONS, FLOW: FLOW, CONTRACEPTION: CONTRACEPTION,

    load: load, get: get, save: save, flush: flush,
    blankDay: blankDay, isSealed: isSealed,

    // Set by Epok.Lock while unlocked: plaintext -> Promise<sealed text>.
    _cipher: null,
    _adopt: _adopt,
    _plaintext: _plaintext,

    day: day, editDay: editDay,
    cycles: cycles, currentCycleDay: currentCycleDay,
    previewPeriodStart: previewPeriodStart,
    setPeriodStart: setPeriodStart,
    clearPeriodStart: clearPeriodStart,
    deriveCyclesFromFlow: deriveCyclesFromFlow,
    modelOpts: modelOpts,
    setProfile: setProfile,
    EVENT_TYPES: EVENT_TYPES,
    addEvent: addEvent, endEvent: endEvent, removeEvent: removeEvent,
    setCycleExcluded: setCycleExcluded, moveStart: moveStart,

    // Opt-in sync hooks. _onSaved is set by Epok.Sync only while sync is on.
    _onSaved: null,
    _applyRemote: applyRemote,
    MAX_TAG_LABEL: MAX_TAG_LABEL,
    addCustomTag: addCustomTag,
    removeCustomTag: removeCustomTag,

    EXPORT_NOTES: EXPORT_NOTES,
    exportFileName: exportFileName,
    exportJSON: exportJSON,
    exportCSV: exportCSV,
    importJSON: importJSON
  };

  /* Another tab saved: adopt its copy. Without this, this tab's next save
     writes its stale log over a day the other tab just logged — measured:
     HEAVY tapped in one tab, a symptom in the other, and the flow was gone
     from epok.state.v1 (only epok.state.prev still held it, one save deep).
     Sealed data needs the key, so Epok.Lock opens it; a locked tab has
     nothing to save and ignores the event.
     ponytail: an edit made here inside the 200 ms save debounce can still
     lose the race to the other tab. */
  window.addEventListener("storage", function (e) {
    if (e.key !== KEY || e.newValue == null || !STATE || STATE.__readonly) return;
    var adopted = isSealed(e.newValue)
      ? (E.Lock && E.Lock.adoptSealed ? E.Lock.adoptSealed(e.newValue) : Promise.resolve(false))
          .then(function (ok) {
            /* Sealed by a PIN this tab doesn't hold (switched on, or changed,
               elsewhere). A save from here would write the log back in
               plaintext, or under the old PIN — measured: the PIN switched on
               in one tab, a symptom logged in the other, and the stored log
               was plaintext again. So this tab stops writing. */
            if (!ok) {
              STATE.__readonly = true;
              E.banner("locked",
                "epok was locked in another tab. Nothing here will be saved: reload and enter your PIN.",
                { tone: "danger" });
            }
            return ok;
          })
      : new Promise(function (done) {
          try { STATE = tryParse(e.newValue); applyProfile(); done(true); }
          catch (err) { done(false); }
        });
    adopted.then(function (ok) { if (ok && E.refresh) E.refresh(); });
  });

  window.Epok = window.Epok || {};
  window.Epok.Store = Store;
})();

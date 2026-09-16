/* ==========================================================================
   EPOK · STORAGE

   Owner: Window A. See PLAN-epok.md § Parallel windows.

     · SCHEMA        one key, epok.state.v1, integer SCHEMA_VERSION
     · MIGRATION     every bump ships its migration in the same change
     · WRITE-THROUGH previous state kept at epok.state.prev before every overwrite
     · PERIOD STARTS their own path, because they are the model's only input
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

  function blankDay() {
    return { flow: null, tags: [], bbt: null, lh: null, pill: null, note: "" };
  }

  function blankState() {
    return {
      v: SCHEMA_VERSION,
      profile: blankProfile(),
      days: {},
      cycles: [],
      customTags: [],
      predictions: [],
      meta: { lastOpened: E.calendarToday(), onboarded: false }
    };
  }

  /* A day with nothing in it has no key. Keeping the map sparse is what makes
     a year of history a few kilobytes instead of a few hundred. */
  function isEmptyDay(d) {
    if (!d) return true;
    return d.flow == null && d.bbt == null && d.lh == null && d.pill == null &&
           !(d.note && d.note.trim()) && !(d.tags && d.tags.length);
  }

  /* Fills in any field added in a later version. Cheap insurance against a
     view reading `undefined` off a day written by an older build. */
  function normaliseDay(d) {
    var base = blankDay();
    Object.keys(base).forEach(function (k) { if (!(k in d)) d[k] = base[k]; });
    if (!Array.isArray(d.tags)) d.tags = [];
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
    ["cycles", "customTags", "predictions"].forEach(function (k) {
      if (!Array.isArray(state[k])) state[k] = [];
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
    ["cycles", "customTags", "predictions"].forEach(function (k) {
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
    } catch (e) {
      E.banner("storage-full",
        "epok could not save (" + (e && e.name || "error") + "). Your last changes are only in " +
        "this tab. Export a backup now.", { tone: "danger" });
    }
  }

  function serialise() {
    return JSON.stringify(STATE, function (k, v) { return k === "__readonly" ? undefined : v; });
  }

  function writeNow() {
    if (!STATE) return;
    if (STATE.__readonly) return;
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
    // also requiring MARK PERIOD START for the same day.
    if (patch.flow) deriveCyclesFromFlow();
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

  function blankCycle(start) {
    return { start: start, end: null, length: null, ovulation: null, ovulationSource: null };
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
  function predictedStart(list) {
    var M = window.Epok.Model;
    if (!M || typeof M.predict !== "function") return null;
    try {
      var p = M.predict(list, {
        conditions: get().profile.conditions,
        ageBand: get().profile.ageBand,
        days: get().days
      });
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
        // An end before the new start is now nonsense; drop it rather than
        // keep a cycle that bleeds before it begins.
        if (next[i].end && E.daysBetween(key, next[i].end) < 0) next[i].end = null;
      }
    } else {
      next.push(blankCycle(key));
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
    var before = clone(s.cycles);
    var near = startNear(key);
    if (near && near.start === key) return;      // already recorded; nothing to do

    s.cycles = withStart(key);
    save();
    E.refresh();

    E.undo(near
      ? "Period start moved from " + E.prettyDate(near.start) + " to " + E.prettyDate(key) + "."
      : "Period start recorded on " + E.prettyDate(key) + ".",
      function () { get().cycles = before; save(); E.refresh(); });
  }

  function clearPeriodStart(key) {
    var s = get();
    var before = clone(s.cycles);
    var kept = s.cycles.filter(function (c) { return c.start !== key; });
    if (kept.length === s.cycles.length) { E.toast("No period start on " + E.prettyDate(key) + "."); return; }
    s.cycles = kept;
    sortCycles(s);
    save();
    E.refresh();
    E.undo("Period start on " + E.prettyDate(key) + " removed.",
      function () { get().cycles = before; save(); E.refresh(); });
  }

  /* The first day of each flow streak — a gap of more than a day since the
     last logged flow starts a new streak. That first day is a period start
     by definition, so it does not have to be marked twice. */
  function flowStreakStarts(days) {
    var keys = Object.keys(days).filter(function (k) { return days[k] && days[k].flow; }).sort();
    var starts = [], prev = null;
    keys.forEach(function (k) {
      if (!prev || E.daysBetween(prev, k) > 1) starts.push(k);
      prev = k;
    });
    return starts;
  }

  /* Extracts period starts out of the flow log instead of requiring MARK
     PERIOD START to be clicked separately. Additive only: never moves or
     removes a start someone set or corrected by hand, and reuses the same
     merge-window match as a manual start so a spotting day 3 days before the
     real one still corrects rather than duplicates. One combined undo, not
     one per day found. */
  function deriveCyclesFromFlow() {
    var s = get();
    var before = clone(s.cycles);
    var added = [];
    flowStreakStarts(s.days).forEach(function (k) {
      if (startNear(k)) return;
      s.cycles = withStart(k);
      added.push(k);
    });
    if (!added.length) return added;
    save();
    E.refresh();
    E.undo(added.length === 1
      ? "Period start extracted from your flow log: " + E.prettyDate(added[0]) + "."
      : added.length + " period starts extracted from your flow log.",
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
    var changed = false;
    Object.keys(patch).forEach(function (k) {
      if (s.profile[k] !== patch[k]) { s.profile[k] = patch[k]; changed = true; }
    });
    if (!changed) return;
    if (boundaryChanged) E._setDayBoundary(s.profile.dayBoundaryHour);
    save();
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
    setProfile: setProfile,
    MAX_TAG_LABEL: MAX_TAG_LABEL,
    addCustomTag: addCustomTag,
    removeCustomTag: removeCustomTag,

    EXPORT_NOTES: EXPORT_NOTES,
    exportFileName: exportFileName,
    exportJSON: exportJSON,
    exportCSV: exportCSV,
    importJSON: importJSON
  };

  window.Epok = window.Epok || {};
  window.Epok.Store = Store;
})();

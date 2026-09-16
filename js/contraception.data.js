/* ==========================================================================
   EPOK · CONTRACEPTION

   Owner: Window A. See PLAN-epok.md § Parallel windows.

     · RULES TABLE  one row per method: cadence, window, placebo span, expiry
     · NO GUIDANCE  the app reports what was logged and when. It gives no
                    medical advice, and it never tells anyone what to do about
                    a missed dose — that is a conversation with a prescriber,
                    not a string in a health app.
     · DATA ONLY    no logic in this file.

   Public namespace: Epok.Contraception
   ========================================================================== */

"use strict";

(function () {
  /* windowHours is the whole reason this is a table rather than a boolean.
     A combined pill has a forgiving window measured in half a day; a
     progestogen-only pill has three hours. One reminder cadence for both
     would either nag combined users or fail POP users, so the reminder
     sharpness is a property of the method, read straight off this row. */

  var METHODS = [
    {
      id: "none", label: "NONE", kind: "none", cadence: "none",
      windowHours: null, cycleDays: null, activeDays: null, placeboDays: null,
      everyDays: null, needsExpiry: false, needsStart: false,
      logs: null,
      note: ""
    },
    {
      id: "combined-21-7", label: "COMBINED PILL 21+7", kind: "pill", cadence: "daily",
      windowHours: 12, cycleDays: 28, activeDays: 21, placeboDays: 7,
      everyDays: null, needsExpiry: false, needsStart: true,
      logs: ["taken", "missed", "placebo"],
      note: "21 active days, then a 7-day break. epok marks which day of the pack you are on, " +
            "counted from the pack start date you set."
    },
    {
      id: "combined-24-4", label: "COMBINED PILL 24+4", kind: "pill", cadence: "daily",
      windowHours: 12, cycleDays: 28, activeDays: 24, placeboDays: 4,
      everyDays: null, needsExpiry: false, needsStart: true,
      logs: ["taken", "missed", "placebo"],
      note: "24 active days, then 4 inactive. epok marks which day of the pack you are on, " +
            "counted from the pack start date you set."
    },
    {
      id: "continuous", label: "CONTINUOUS PILL", kind: "pill", cadence: "daily",
      windowHours: 12, cycleDays: null, activeDays: null, placeboDays: 0,
      everyDays: null, needsExpiry: false, needsStart: true,
      logs: ["taken", "missed"],
      note: "Active every day, no break. There is no pack day to count, so epok only records " +
            "whether the day was logged."
    },
    {
      id: "pop", label: "PROGESTOGEN-ONLY PILL", kind: "pill", cadence: "daily",
      windowHours: 3, cycleDays: null, activeDays: null, placeboDays: 0,
      everyDays: null, needsExpiry: false, needsStart: true,
      logs: ["taken", "missed"],
      note: "Taken at the same time every day, with a much narrower window than a combined " +
            "pill. epok's reminder for this method is correspondingly sharper."
    },
    {
      id: "patch", label: "PATCH", kind: "patch", cadence: "weekly",
      windowHours: 24, cycleDays: 28, activeDays: 21, placeboDays: 7,
      everyDays: 7, needsExpiry: false, needsStart: true,
      logs: ["taken", "missed"],
      note: "Changed weekly for three weeks, then one patch-free week. epok counts the weeks " +
            "from the start date you set."
    },
    {
      id: "ring", label: "RING", kind: "ring", cadence: "monthly",
      windowHours: 24, cycleDays: 28, activeDays: 21, placeboDays: 7,
      everyDays: 28, needsExpiry: false, needsStart: true,
      logs: ["taken", "missed"],
      note: "In for three weeks, then out for one. epok counts from the insertion date you set."
    },
    {
      id: "injection", label: "INJECTION", kind: "injection", cadence: "weeks",
      windowHours: null, cycleDays: null, activeDays: null, placeboDays: null,
      everyDays: 84, needsExpiry: false, needsStart: true,
      logs: null,
      note: "Roughly every 12 weeks. epok counts 84 days from the last injection date you set " +
            "and shows how many days are left — your clinic's interval is the one that counts, " +
            "not this number."
    },
    {
      id: "iud", label: "IUD", kind: "device", cadence: "expiry",
      windowHours: null, cycleDays: null, activeDays: null, placeboDays: null,
      everyDays: null, needsExpiry: true, needsStart: false,
      logs: null,
      note: "Nothing to log day to day. epok tracks only the expiry date you enter and counts " +
            "down to it."
    },
    {
      id: "implant", label: "IMPLANT", kind: "device", cadence: "expiry",
      windowHours: null, cycleDays: null, activeDays: null, placeboDays: null,
      everyDays: null, needsExpiry: true, needsStart: false,
      logs: null,
      note: "Nothing to log day to day. epok tracks only the expiry date you enter and counts " +
            "down to it."
    }
  ];

  var BY_ID = {};
  METHODS.forEach(function (m) { BY_ID[m.id] = m; });

  /* Rendered wherever a missed dose could be read as a question epok is
     answering. It is not. */
  var NO_GUIDANCE =
    "epok records what you logged and when. It does not say what a missed dose means or what " +
    "to do about one — that depends on the method, the timing and you, and it belongs with " +
    "whoever prescribed it.";

  var Contraception = {
    METHODS: METHODS,
    BY_ID: BY_ID,
    NO_GUIDANCE: NO_GUIDANCE
  };

  window.Epok = window.Epok || {};
  window.Epok.Contraception = Contraception;
})();

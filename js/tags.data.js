/* ==========================================================================
   EPOK · TAGS

   Owner: Window C. See PLAN-epok.md § Parallel windows.

     · VOCABULARY  ~30 tags across 9 categories. Clue's domains, this app's wording.
     · IDS         kebab-case, stable forever. Renaming a label is free; changing an id is a migration.
     · HIDING      a display setting in profile.hiddenTags. Never deletes logged data.
     · DATA ONLY   no logic in this file beyond simple lookup/filter.

   Public namespace: Epok.Tags
   ========================================================================== */

"use strict";

(function () {
  var CATEGORIES = [
    { id: "flow",      label: "FLOW" },
    { id: "pain",      label: "PAIN" },
    { id: "mood",      label: "MOOD" },
    { id: "energy",    label: "ENERGY" },
    { id: "sleep",     label: "SLEEP" },
    { id: "skin",      label: "SKIN" },
    { id: "digestion", label: "DIGESTION" },
    { id: "fluid",     label: "FLUID" },
    { id: "activity",  label: "ACTIVITY" }
  ];

  // Labels are stored uppercase, matching CATEGORIES above — .chip already
  // forces text-transform: uppercase in CSS, so this is belt-and-braces
  // consistency with the rest of the app's stored strings, not a display need.
  var ALL = [
    { id: "clots",             label: "CLOTS",             category: "flow" },
    { id: "flooding",          label: "FLOODING",          category: "flow" },
    { id: "spotting-between",  label: "SPOTTING BETWEEN",  category: "flow" },

    { id: "cramps",            label: "CRAMPS",            category: "pain" },
    { id: "headache",          label: "HEADACHE",          category: "pain" },
    { id: "backache",          label: "BACKACHE",          category: "pain" },
    { id: "breast-tenderness", label: "BREAST TENDERNESS", category: "pain" },

    { id: "happy",             label: "HAPPY",             category: "mood" },
    { id: "anxious",           label: "ANXIOUS",           category: "mood" },
    { id: "irritable",         label: "IRRITABLE",         category: "mood" },
    { id: "low",               label: "LOW",               category: "mood" },

    { id: "energetic",         label: "ENERGETIC",         category: "energy" },
    { id: "tired",             label: "TIRED",             category: "energy" },
    { id: "exhausted",         label: "EXHAUSTED",         category: "energy" },

    { id: "slept-well",        label: "SLEPT WELL",        category: "sleep" },
    { id: "insomnia",          label: "INSOMNIA",          category: "sleep" },
    { id: "restless-sleep",    label: "RESTLESS SLEEP",    category: "sleep" },

    { id: "acne",              label: "ACNE",              category: "skin" },
    { id: "oily-skin",         label: "OILY SKIN",         category: "skin" },
    { id: "dry-skin",          label: "DRY SKIN",          category: "skin" },

    { id: "bloating",          label: "BLOATING",          category: "digestion" },
    { id: "nausea",            label: "NAUSEA",            category: "digestion" },
    { id: "constipation",      label: "CONSTIPATION",      category: "digestion" },
    { id: "diarrhea",          label: "DIARRHEA",          category: "digestion" },

    { id: "fluid-dry",         label: "DRY",               category: "fluid" },
    { id: "fluid-sticky",      label: "STICKY",            category: "fluid" },
    { id: "fluid-creamy",      label: "CREAMY",            category: "fluid" },
    { id: "fluid-egg-white",   label: "EGG WHITE",         category: "fluid" },

    { id: "exercise",          label: "EXERCISE",          category: "activity" },
    { id: "sex",                label: "SEX",               category: "activity" },
    { id: "alcohol",           label: "ALCOHOL",           category: "activity" },
    { id: "travel",            label: "TRAVEL",            category: "activity" }
  ];

  function customTags() {
    var E = window.Epok;
    if (!E || !E.Store) return [];
    return (E.Store.get().customTags || []).map(function (t) {
      return { id: t.id, label: t.label, category: t.category, custom: true };
    });
  }

  /** All tags in one category, built-in then custom. */
  function byCategory(id) {
    return ALL.concat(customTags()).filter(function (t) { return t.category === id; });
  }

  /** Everything minus what the profile has hidden. Hiding is display-only —
      it never touches logged data, so a hidden tag already on a day still
      shows on that day; it just stops being offered for new logging. */
  function visible() {
    var E = window.Epok;
    var hidden = (E && E.Store) ? (E.Store.get().profile.hiddenTags || []) : [];
    return ALL.concat(customTags()).filter(function (t) { return hidden.indexOf(t.id) < 0; });
  }

  var Tags = { CATEGORIES: CATEGORIES, ALL: ALL, byCategory: byCategory, visible: visible };

  window.Epok = window.Epok || {};
  window.Epok.Tags = Tags;
})();

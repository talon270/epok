/* ==========================================================================
   EPOK · BACKTEST

   Owner: Window B. See PLAN-epok.md § Parallel windows.

     · LEAVE-ONE-OUT  predict cycle n from cycles 1..n-1, score against what happened
     · MEDIAN ABS ERR the number the app shows the user about itself
     · PURE           runs under Node for tools/score.js

   Public namespace: Epok.Backtest
   ========================================================================== */

"use strict";

(function () {
  // The model owns the leave-one-out walk because predict() needs it too (a
  // prediction carries its own measured error). This file is the public face
  // of that walk plus the summary the user is shown.
  function model() {
    if (typeof module !== "undefined" && module.exports) return require("./model.js");
    return window.Epok.Model;
  }

  function median(xs) {
    if (!xs.length) return null;
    var a = xs.slice().sort(function (x, y) { return x - y; });
    var h = a.length >> 1;
    return a.length % 2 ? a[h] : (a[h - 1] + a[h]) / 2;
  }

  /**
   * run(cycles, opts) -> { mae, n, perCycle }
   *
   * `mae` is the MEDIAN absolute error in days, not the arithmetic mean: one
   * skipped cycle in a perimenopausal record moves a mean by several days and
   * would misdescribe every other prediction the model made.
   */
  function run(cycles, opts) {
    var rows = model()._loo(cycles || [], opts || {});
    var errs = rows.map(function (r) { return Math.abs(r.errorDays); });
    return {
      mae: median(errs),
      n: rows.length,
      perCycle: rows.map(function (r) {
        return { start: r.start, predicted: r.predicted, actual: r.actual, errorDays: r.errorDays };
      })
    };
  }

  var Backtest = { run: run };

  // Runs in the browser AND under Node — tools/score.js requires this file.
  if (typeof module !== "undefined" && module.exports) module.exports = Backtest;
  else (window.Epok = window.Epok || {}).Backtest = Backtest;
})();

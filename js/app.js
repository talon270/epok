/* ==========================================================================
   EPOK · BOOT

   Owner: Window A. See PLAN-epok.md § Parallel windows.

     · ORDER       load + migrate state, unlock if locked, register views, route
     · PLACEHOLDER a view that has no render() yet still mounts and navigates,
                   so the skeleton runs before Window C has written a line
     · FLUSH       the debounced save is forced on pagehide

   Public namespace: Epok.App
   ========================================================================== */

"use strict";

(function () {
  var E = window.Epok;

  // Rail order. Also the order a view is tried in when the hash names nothing.
  var VIEW_ORDER = [
    { key: "Today",    id: "today",    title: "TODAY" },
    { key: "Calendar", id: "calendar", title: "CALENDAR" },
    { key: "Timeline", id: "timeline", title: "TIMELINE" },
    { key: "Insights", id: "insights", title: "INSIGHTS" },
    { key: "Settings", id: "settings", title: "SETTINGS" },
    { key: "Report",   id: "report",   title: "REPORT" }
  ];

  /* A registered-but-unwritten view renders this rather than nothing. An empty
     shell that navigates is the point of the skeleton — it surfaces the
     structural mistakes while they are still cheap. */
  function placeholder(id, title) {
    return E.el("section", { class: "card" }, [
      E.el("div", { class: "card__head" }, [
        E.el("h1", { text: title }),
        E.el("span", { class: "micro", text: "NOT BUILT YET" })
      ]),
      E.el("p", { class: "dim", text: "This view has no content yet." }),
      E.el("p", { class: "small faint", text: "Window C owns js/views/" + id + ".js." })
    ]);
  }

  function register() {
    VIEW_ORDER.forEach(function (v) {
      var spec = (E.Views && E.Views[v.key]) || {};
      E.registerView(v.id, {
        title: spec.title || v.title,
        // Late-bound on purpose: the moment Window C adds render(), it is used,
        // with no change here.
        render: function () {
          return spec.render ? spec.render() : placeholder(v.id, spec.title || v.title);
        },
        refresh: function () {
          if (spec.refresh) spec.refresh();
          else E.show(v.id);
        }
      });
    });
  }

  /* Offline forever, when the scheme allows it. On file:// register() throws
     rather than returning false, so the guard is the scheme, not a try/catch
     around the failure. */
  function registerServiceWorker() {
    if (!E.Reminders.swSupported()) return;
    navigator.serviceWorker.register("service-worker.js").catch(function (err) {
      if (window.console) console.warn("[epok] service worker not registered:", err.message);
    });
  }

  function routeFromHash() {
    var id = location.hash.slice(1);
    E.show(id || VIEW_ORDER[0].id);
  }

  /* Lock on open. There is no "continue without unlocking" because there is
     nothing to continue into: the state is ciphertext until the PIN opens it. */
  function mountLock() {
    var rail = document.getElementById("rail");
    var main = document.getElementById("main");
    rail.hidden = true;
    document.body.dataset.locked = "1";
    main.textContent = "";
    main.appendChild(E.Lock.screen(function () {
      rail.hidden = false;
      delete document.body.dataset.locked;
      bootUnlocked();
    }));
  }

  function boot() {
    if (E.Lock && E.Lock.isLocked()) { mountLock(); return; }
    bootUnlocked();
  }

  function bootUnlocked() {
    // Unlocking already adopted the decrypted state; loading again would read
    // the ciphertext straight back over it.
    if (!(E.Lock && E.Lock.hasKey())) E.Store.load();

    var s = E.Store.get();
    s.meta.lastOpened = E.calendarToday();
    E.Store.save();

    // Backfill: flow logged before a period start was ever marked for it
    // (e.g. entered retrospectively) still counts as one.
    E.Store.deriveCyclesFromFlow();

    register();
    routeFromHash();
    window.addEventListener("hashchange", routeFromHash);

    /* B14: never silently missing. The banner appears only when the user has
       actually switched reminders on and they cannot fire — nagging someone
       who never asked for reminders is noise, not honesty. */
    var rem = E.Reminders.available();
    if (s.profile.remindersOn && !rem.ok) E.banner("reminders", rem.reason, { tone: "warn" });
    else E.clearBanner("reminders");

    registerServiceWorker();
    E.Reminders.schedule();
    if (E.Sync) E.Sync.init();

    // The save is debounced; a closing tab does not wait for it.
    window.addEventListener("pagehide", function () { E.Store.flush(); });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") E.Store.flush();
    });
  }

  var App = { boot: boot, placeholder: placeholder, VIEW_ORDER: VIEW_ORDER };

  window.Epok = window.Epok || {};
  window.Epok.App = App;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

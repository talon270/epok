/* ==========================================================================
   EPOK · SERVICE WORKER
   Owner: Window A.

     · PRECACHE   the whole shell on install, so the first offline open works
     · SERVE      cache-first, revalidating in the background
     · NEVER      caches state. The log lives in localStorage and never
                  touches the network; there is nothing here to leak.

   Bump CACHE whenever a shell file changes, or the old one is served forever.
   ========================================================================== */

"use strict";

var CACHE = "epok-v1";

/* Everything the app needs to open with the network gone. Window B's and
   Window C's files are listed here too — a missing one is a blank view
   offline, which is exactly the failure this list exists to prevent. */
var SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/brutal.css",
  "css/themes.css",
  "css/views.css",
  "css/print.css",
  "js/core.js",
  "js/storage.js",
  "js/crypto.js",
  "js/tags.data.js",
  "js/contraception.data.js",
  "js/model.js",
  "js/backtest.js",
  "js/import-clue.js",
  "js/reminders.js",
  "js/views/today.js",
  "js/views/calendar.js",
  "js/views/insights.js",
  "js/views/settings.js",
  "js/views/report.js",
  "js/app.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png"
];

self.addEventListener("install", function (e) {
  /* addAll is all-or-nothing: one 404 and nothing is cached, which is the
     right failure. A half-cached shell is an app that opens offline and then
     breaks in a way nobody can debug. */
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
    .then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  /* Cache-first so an offline open is instant, then refresh the cache behind
     it so the next open has the new file. Offline forever is the promise;
     one load of staleness after an update is the price. */
  e.respondWith(caches.match(req).then(function (hit) {
    var live = fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () { return hit; });
    return hit || live;
  }));
});

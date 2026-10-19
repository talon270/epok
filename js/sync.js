/* ==========================================================================
   EPOK · SYNC  (opt-in, off by default)

     · LOCAL FIRST  localStorage stays the source of truth. Sync is a copy that
                    follows it; the app is fully usable with sync off, offline,
                    or with the database gone
     · END TO END   every record is AES-GCM encrypted here, with a key derived
                    from a passphrase that is never stored and never leaves the
                    browser. The database holds ciphertext and keyed hashes
     · PER RECORD   one row per logged day, plus one per list (cycles, events,
                    profile fields, custom tags, forecasts, rejected starts).
                    Three-way merge against what was last synced, so a change
                    on only one side is never a conflict
     · CONFLICTS    a record changed on two devices since the last sync: the
                    newer edit wins, and the other version is kept in a list the
                    user can read. Nothing is overwritten without the previous
                    local state landing in epok.state.prev first
     · NO CLIENT    plain fetch against the database's HTTP pipeline endpoint
                    (Hrana over HTTP). No library, no CDN, no bundler
     · STALE        a failed sync says so, with the age of the last good one,
                    and never presents old data as current

   What the database can see: that rows exist, how many, when each was last
   written, and ciphertext. What it cannot see: dates, flow, symptoms,
   temperatures, notes, or which rows are days. The token is stored in this
   browser, NOT inside the PIN-sealed state, and is not in any export.

   UNVERIFIED AGAINST TURSO: the request shape below follows the documented
   Hrana-over-HTTP pipeline, and is tested only against tools/mock_turso.py.
   Whether a browser may call a Turso endpoint directly (CORS) is the open
   question in PLAN-features-sync.md C0.

   Public namespace: Epok.Sync
   ========================================================================== */

"use strict";

(function () {
  var E = window.Epok;

  var CFG_KEY = "epok.sync.v1";
  var PBKDF2_ITERATIONS = 250000;     // same floor as the PIN lock: never lowered
  var DEBOUNCE_MS = 4000;
  var PIPELINE_PATH = "/v2/pipeline";
  var BATCH = 100;                    // statements per request
  var MAX_CONFLICTS_KEPT = 20;
  var MAX_RESYNC = 3;
  var MASS_DELETE_MIN = 10;           // below this many, a remote deletion is applied without question                 // re-runs after another device wrote mid-sync

  var subtle = (window.crypto && window.crypto.subtle) || null;
  var enc = new TextEncoder(), dec = new TextDecoder();

  var KEYS = null;                    // { aes, hmac } — this session only, never persisted
  var timer = null, running = null, resyncs = 0;
  // True while a sync is writing remote records into local state. The saves that
  // causes must not be stamped as the user's own edits, or every pulled record
  // would look newer than the other device's copy and win the next conflict.
  var applying = false;

  /* ==================================================================
     1. CONFIG — separate key, never in state, never exported
     ================================================================== */

  function loadCfg() {
    try { var raw = localStorage.getItem(CFG_KEY); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }
  function saveCfg(cfg) {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); return true; }
    catch (e) { return false; }
  }
  function blankCfg(url, token, salt, check) {
    return { v: 1, enabled: true, url: url, token: token, salt: salt, check: check,
             lastSync: null, lastError: null,
             baseLocal: {}, baseRemote: {}, seenLocal: {}, changedAt: {}, conflicts: [] };
  }

  function normaliseUrl(u) {
    u = String(u || "").trim().replace(/\/+$/, "");
    if (/^libsql:\/\//i.test(u)) u = "https://" + u.slice(9);
    return u;
  }

  /* ==================================================================
     2. CRYPTO
     ================================================================== */

  function b64(buf) {
    var a = new Uint8Array(buf), s = "";
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s);
  }
  function unb64(str) {
    var s = atob(str), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  function b64url(buf) { return b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (x) { return (x < 16 ? "0" : "") + x.toString(16); }).join("");
  }
  function randomBytes(n) { var b = new Uint8Array(n); window.crypto.getRandomValues(b); return b; }

  /* 512 bits from the passphrase: the first half is the AES-GCM key, the second
     the HMAC key that makes record ids and hashes meaningless to the database. */
  function deriveKeys(passphrase, saltB64) {
    return subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]).then(function (base) {
      return subtle.deriveBits({ name: "PBKDF2", salt: unb64(saltB64), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, base, 512);
    }).then(function (bits) {
      var a = new Uint8Array(bits);
      return Promise.all([
        subtle.importKey("raw", a.slice(0, 32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
        subtle.importKey("raw", a.slice(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      ]);
    }).then(function (k) { return { aes: k[0], hmac: k[1] }; });
  }

  function seal(keys, obj) {
    var iv = randomBytes(12);
    return subtle.encrypt({ name: "AES-GCM", iv: iv }, keys.aes, enc.encode(JSON.stringify(obj))).then(function (ct) {
      var out = new Uint8Array(12 + ct.byteLength);
      out.set(iv, 0); out.set(new Uint8Array(ct), 12);
      return b64(out);
    });
  }
  function open(keys, text) {
    var all = unb64(text);
    return subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, keys.aes, all.slice(12)).then(function (pt) {
      return JSON.parse(dec.decode(pt));
    });
  }
  function remoteId(keys, logical) {
    return subtle.sign("HMAC", keys.hmac, enc.encode("id:" + logical)).then(function (m) { return b64url(m).slice(0, 32); });
  }
  function remoteHash(keys, canonical) {
    return subtle.sign("HMAC", keys.hmac, enc.encode("h:" + canonical)).then(hex);
  }
  function sha256(text) { return subtle.digest("SHA-256", enc.encode(text)).then(hex); }

  /* Stable stringify: sorted keys, so the same record always hashes the same. */
  function canon(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + canon(v[k]); }).join(",") + "}";
  }

  /* ==================================================================
     3. THE WIRE — Hrana over HTTP
     ================================================================== */

  function SyncError(message, kind) { var e = new Error(message); e.kind = kind || "error"; return e; }

  function arg(v) {
    if (v === null || v === undefined) return { type: "null" };
    if (typeof v === "number") return { type: "integer", value: String(v) };
    return { type: "text", value: String(v) };
  }
  function st(sql, args) { return { sql: sql, args: (args || []).map(arg) }; }

  function decodeResult(r) {
    var cols = (r.cols || []).map(function (c) { return c.name; });
    return {
      affected: Number(r.affected_row_count || 0),
      rows: (r.rows || []).map(function (row) {
        var o = {};
        cols.forEach(function (c, i) {
          var cell = row[i];
          o[c] = !cell || cell.type === "null" ? null : cell.type === "integer" ? Number(cell.value) : cell.value;
        });
        return o;
      })
    };
  }

  /* One request, many statements. Returns one decoded result per statement. */
  function pipeline(cfg, stmts) {
    var body = { requests: stmts.map(function (s) { return { type: "execute", stmt: s }; }).concat([{ type: "close" }]) };
    return fetch(normaliseUrl(cfg.url) + PIPELINE_PATH, {
      method: "POST",
      headers: { "Authorization": "Bearer " + cfg.token, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).catch(function () {
      throw SyncError("Could not reach the database. You may be offline, or the browser blocked the request.", "network");
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) throw SyncError("The database rejected the token (it may have expired or been revoked).", "auth");
      if (!res.ok) throw SyncError("The database answered " + res.status + ".", "http");
      return res.json();
    }).then(function (json) {
      var out = [];
      for (var i = 0; i < stmts.length; i++) {
        var r = json.results && json.results[i];
        if (!r) throw SyncError("The database sent an incomplete answer.", "http");
        if (r.type === "error") throw SyncError("The database refused a statement: " + ((r.error && r.error.message) || "unknown error"), "sql");
        out.push(decodeResult(r.response.result));
      }
      return out;
    });
  }

  var SCHEMA = [
    st("CREATE TABLE IF NOT EXISTS epok_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, hash TEXT NOT NULL, " +
       "payload TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)"),
    st("CREATE TABLE IF NOT EXISTS epok_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
  ];

  /* ==================================================================
     4. LOCAL RECORDS
     ================================================================== */

  // Device preferences stay on the device: theme, mode, day boundary, reminders.
  var PROFILE_FIELDS = ["ageBand", "conditions", "goal", "contraception", "contraceptionStart",
                        "contraceptionExpiry", "fertilityVisible", "hiddenTags"];

  function localRecords() {
    var s = E.Store.get(), out = {}, p = {};
    Object.keys(s.days).forEach(function (k) { out["day:" + k] = s.days[k]; });
    out["blob:cycles"] = s.cycles;
    out["blob:events"] = s.events;
    PROFILE_FIELDS.forEach(function (f) { p[f] = s.profile[f] === undefined ? null : s.profile[f]; });
    out["blob:profile"] = p;
    out["blob:customTags"] = s.customTags;
    out["blob:predictions"] = s.predictions;
    out["blob:rejected"] = (s.meta && s.meta.rejectedStarts) || [];
    return out;
  }
  /* A list a device has never edited. On a device's FIRST sync these must not
     count as changes: a fresh device joining a populated database would
     otherwise "change" cycles, events and profile from nothing to nothing,
     stamp that later than the other device's upload, and win the conflict —
     replacing a real log with an empty one. */
  var PROFILE_DEFAULTS = { ageBand: null, conditions: [], goal: null, contraception: null, contraceptionStart: null,
                           contraceptionExpiry: null, fertilityVisible: true, hiddenTags: [] };
  function isUntouched(logical, value) {
    if (logical === "blob:profile") return canon(value) === canon(PROFILE_DEFAULTS);
    if (logical.indexOf("blob:") === 0) return Array.isArray(value) && value.length === 0;
    return false;
  }

  function kindOf(logical) { return logical.indexOf("day:") === 0 ? "day" : "blob"; }

  function hashAll(records) {
    var keys = Object.keys(records);
    return Promise.all(keys.map(function (k) { return sha256(canon(records[k])); })).then(function (hs) {
      var out = {}; keys.forEach(function (k, i) { out[k] = hs[i]; }); return out;
    });
  }

  /* Union merges for the two lists that only ever grow. */
  function unionPredictions(a, b) {
    var seen = {}, out = [];
    (a || []).concat(b || []).forEach(function (p) {
      var k = p.anchor + "|" + p.madeOn + "|" + p.nextStart;
      if (!seen[k]) { seen[k] = true; out.push(p); }
    });
    return out.sort(function (x, y) { return x.madeOn < y.madeOn ? -1 : x.madeOn > y.madeOn ? 1 : 0; });
  }
  function unionStrings(a, b) {
    var seen = {}, out = [];
    (a || []).concat(b || []).forEach(function (x) { if (!seen[x]) { seen[x] = true; out.push(x); } });
    return out.sort();
  }

  /* ==================================================================
     5. CHANGE TRACKING — runs on every local save, needs no key
     ================================================================== */

  function noteLocalChange() {
    var cfg = loadCfg();
    // Tracked even while paused: the time of an edit decides a later conflict,
    // and stamping it at the moment sync resumes would let an old edit beat a
    // newer one made elsewhere.
    if (applying || !cfg || !subtle) return Promise.resolve();
    var recs = localRecords();
    return hashAll(recs).then(function (hs) {
      var now = Date.now(), changed = false;
      Object.keys(hs).forEach(function (k) {
        if (cfg.seenLocal[k] !== hs[k]) { cfg.seenLocal[k] = hs[k]; cfg.changedAt[k] = now; changed = true; }
      });
      Object.keys(cfg.seenLocal).forEach(function (k) {
        if (!(k in hs)) { delete cfg.seenLocal[k]; cfg.changedAt[k] = now; changed = true; }
      });
      if (changed) saveCfg(cfg);
      if (cfg.enabled) schedule();
    });
  }

  function schedule() {
    var cfg = loadCfg();
    if (!cfg || !cfg.enabled || !KEYS) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; syncNow().catch(function () { /* surfaced by syncNow */ }); }, DEBOUNCE_MS);
  }

  /* ==================================================================
     6. SYNC
     ================================================================== */

  function fail(cfg, err) {
    cfg.lastError = { message: err.message, kind: err.kind || "error", at: Date.now() };
    saveCfg(cfg);
    showBanner(cfg);
    return Promise.reject(err);
  }

  function showBanner(cfg) {
    if (!cfg || !cfg.enabled) { E.clearBanner("sync"); return; }
    if (cfg.lastError) {
      E.banner("sync",
        "Sync is not current: " + cfg.lastError.message + " " +
        (cfg.lastSync ? "Last good sync " + new Date(cfg.lastSync).toLocaleString() + ". " : "It has never completed. ") +
        "Your log on this device is unaffected.", { tone: "warn" });
    } else if (!KEYS) {
      E.banner("sync", "Sync is on but locked for this session — enter your sync passphrase in Settings to resume it. " +
        (cfg.lastSync ? "Last good sync " + new Date(cfg.lastSync).toLocaleString() + "." : ""), { tone: "warn" });
    } else {
      E.clearBanner("sync");
    }
  }

  function syncNow() {
    if (running) return running;
    var cfg = loadCfg();
    if (!cfg || !cfg.enabled) return Promise.reject(SyncError("Sync is off.", "off"));
    if (!KEYS) { showBanner(cfg); return Promise.reject(SyncError("Enter the sync passphrase first.", "locked")); }
    if (!subtle) return Promise.reject(SyncError("This browser has no WebCrypto, so sync cannot encrypt.", "crypto"));

    var keys = KEYS, summary = { pulled: 0, pushed: 0, conflicts: 0, raced: 0 };
    running = E.Store.flush().then(function () { return noteLocalChange(); }).then(function () {
      cfg = loadCfg();
      var recs = localRecords();
      return Promise.all([hashAll(recs), pipeline(cfg, SCHEMA.concat([
        st("SELECT id, hash, updated_at, deleted FROM epok_records"), st("SELECT k, v FROM epok_meta")]))])
        .then(function (r) {
          // A database that lost its salt was wiped or recreated. Treating its
          // empty record list as "everything was deleted" would erase this
          // device's log, so the sync stops here and changes nothing.
          var salt = r[1][3].rows.filter(function (m) { return m.k === "salt"; })[0];
          if (!salt || salt.v !== cfg.salt) {
            throw SyncError("The database no longer holds this sync's data (it may have been reset or replaced). " +
              "Nothing on this device was changed. Forget sync here and turn it on again to upload a fresh copy.", "reset");
          }
          return { recs: recs, localHash: r[0], index: r[1][2].rows };
        });
    }).then(function (ctx) {
      // Every logical key we know about, with its remote id.
      var logicals = Object.keys(ctx.recs);
      Object.keys(cfg.baseLocal).forEach(function (k) { if (logicals.indexOf(k) < 0) logicals.push(k); });
      return Promise.all(logicals.map(function (k) { return remoteId(keys, k); })).then(function (ids) {
        ctx.idOf = {}; ctx.logicalOf = {};
        logicals.forEach(function (k, i) { ctx.idOf[k] = ids[i]; ctx.logicalOf[ids[i]] = k; });
        ctx.rowById = {};
        ctx.index.forEach(function (row) { ctx.rowById[row.id] = row; });
        ctx.logicals = logicals;
        return ctx;
      });
    }).then(function (ctx) {
      // Remote rows nobody local knows yet: decrypt to learn what they are.
      var unknown = ctx.index.filter(function (row) { return !row.deleted && !(row.id in ctx.logicalOf); });
      // Known rows whose remote hash moved since the last sync.
      var moved = ctx.logicals.filter(function (k) {
        var row = ctx.rowById[ctx.idOf[k]];
        var rh = row && !row.deleted ? row.hash : null;
        return rh !== (cfg.baseRemote[k] || null) && row && !row.deleted;
      });
      var wanted = unknown.map(function (r) { return r.id; }).concat(moved.map(function (k) { return ctx.idOf[k]; }));
      return fetchPayloads(cfg, wanted).then(function (payloads) {
        return Promise.all(wanted.map(function (id) { return open(keys, payloads[id]).catch(function () { return null; }); })).then(function (opened) {
          ctx.remoteValue = {};
          wanted.forEach(function (id, i) {
            if (!opened[i]) return;
            ctx.remoteValue[opened[i].k] = opened[i].v;
            if (!(id in ctx.logicalOf)) { ctx.logicalOf[id] = opened[i].k; ctx.idOf[opened[i].k] = id; }
          });
          unknown.forEach(function (row) {
            var k = ctx.logicalOf[row.id];
            if (k && ctx.logicals.indexOf(k) < 0) ctx.logicals.push(k);
          });
          return ctx;
        });
      });
    }).then(function (ctx) {
      var plan = { apply: [], push: [], bases: [], conflicts: [] };
      ctx.logicals.forEach(function (k) {
        var id = ctx.idOf[k], row = ctx.rowById[id];
        var lh = k in ctx.recs ? ctx.localHash[k] : null, bl = cfg.baseLocal[k] || null;
        var remoteLive = !!(row && !row.deleted), rh = remoteLive ? row.hash : null, br = cfg.baseRemote[k] || null;
        var localChanged = lh !== bl, remoteChanged = rh !== br || (!!row && !!row.deleted && br !== null);
        var rv = ctx.remoteValue[k];
        if (localChanged && bl === null && remoteLive && k in ctx.recs && isUntouched(k, ctx.recs[k])) localChanged = false;

        if (!localChanged && !remoteChanged) return;
        if (localChanged && !remoteChanged) { plan.push.push({ k: k, row: row }); return; }
        if (!localChanged && remoteChanged) { plan.apply.push({ k: k, v: remoteLive ? rv : null, rh: rh }); return; }

        // Both sides moved since the last sync.
        if (remoteLive && k in ctx.recs && canon(rv) === canon(ctx.recs[k])) { plan.bases.push({ k: k, rh: rh }); return; }
        if (k === "blob:predictions" || k === "blob:rejected") {
          var merged = k === "blob:predictions" ? unionPredictions(ctx.recs[k], rv) : unionStrings(ctx.recs[k], rv);
          plan.apply.push({ k: k, v: merged, rh: null, thenPush: true, row: row });
          return;
        }
        var remoteNewer = row && row.updated_at > (cfg.changedAt[k] || 0);
        plan.conflicts.push({ k: k, winner: remoteNewer ? "other device" : "this device",
          local: k in ctx.recs ? ctx.recs[k] : null, remote: remoteLive ? rv : null, at: Date.now() });
        if (remoteNewer) plan.apply.push({ k: k, v: remoteLive ? rv : null, rh: rh });
        else plan.push.push({ k: k, row: row });
      });
      // Destructive-by-surprise guard: a large share of local days about to be
      // deleted because the remote says they are gone is more likely a
      // problem with the remote than the user deleting months of log.
      var dels = plan.apply.filter(function (a) { return a.v == null && a.k.indexOf("day:") === 0; }).length;
      var localDays = Object.keys(ctx.recs).filter(function (k) { return k.indexOf("day:") === 0; }).length;
      if (dels > MASS_DELETE_MIN && dels > localDays / 2) {
        throw SyncError("Sync would delete " + dels + " of your " + localDays + " logged days because the database says they are gone. " +
          "That looks like a problem with the database, so nothing was changed. Check the other device, or forget sync here and set it up again.", "mass-delete");
      }
      ctx.plan = plan;
      return ctx;
    }).then(function (ctx) {
      // Apply remote changes locally. Flush first so epok.state.prev holds the
      // exact state they overwrite.
      var plan = ctx.plan;
      if (!plan.apply.length) return ctx;
      applying = true;
      return E.Store.flush().then(function () {
        E.Store._applyRemote(plan.apply.map(function (a) { return { k: a.k, v: a.v }; }));
        summary.pulled = plan.apply.length;
        plan.apply.forEach(function (a) { if (a.thenPush) plan.push.push({ k: a.k, row: a.row }); });
        return E.Store.flush();
      }).then(function () { return ctx; });
    }).then(function (ctx) {
      // Push local changes, conditional on the remote row being what we saw.
      var plan = ctx.plan, recs = localRecords();
      return Promise.all(plan.push.map(function (p) {
        var present = p.k in recs, value = recs[p.k];
        var id = ctx.idOf[p.k];
        return Promise.all([
          present ? seal(keys, { k: p.k, v: value }) : Promise.resolve(""),
          present ? remoteHash(keys, canon(value)) : Promise.resolve("tomb:" + Date.now()),
          sha256(canon(value === undefined ? null : value))
        ]).then(function (x) { return { k: p.k, id: id, payload: x[0], hash: x[1], lhash: x[2], present: present, row: p.row }; });
      })).then(function (items) {
        var chunks = [];
        for (var i = 0; i < items.length; i += BATCH) chunks.push(items.slice(i, i + BATCH));
        var now = Date.now();
        return chunks.reduce(function (chain, chunk) {
          return chain.then(function () {
            var stmts = chunk.map(function (it) {
              return st("INSERT INTO epok_records (id, kind, hash, payload, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?) " +
                "ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, hash = excluded.hash, payload = excluded.payload, " +
                "updated_at = excluded.updated_at, deleted = excluded.deleted WHERE epok_records.hash = ?",
                [it.id, kindOf(it.k), it.hash, it.payload, now, it.present ? 0 : 1, it.row ? it.row.hash : "none"]);
            });
            return pipeline(cfg, stmts).then(function (res) {
              res.forEach(function (r, j) {
                var it = chunk[j];
                if (r.affected === 1) {
                  summary.pushed++;
                  plan.bases.push({ k: it.k, rh: it.present ? it.hash : null, lh: it.present ? it.lhash : null, pushed: true });
                } else summary.raced++;
              });
            });
          });
        }, Promise.resolve());
      }).then(function () { return ctx; });
    }).then(function (ctx) {
      // Record what is now in step. Local hashes come from the actual local
      // state, because normalisation on apply can change a record's shape.
      var recs = localRecords();
      return hashAll(recs).then(function (hs) {
        var plan = ctx.plan;
        plan.apply.forEach(function (a) { plan.bases.push({ k: a.k, rh: a.rh, applied: true }); });
        plan.bases.forEach(function (b) {
          if (b.k in hs) cfg.baseLocal[b.k] = hs[b.k]; else delete cfg.baseLocal[b.k];
          if (b.rh) cfg.baseRemote[b.k] = b.rh; else delete cfg.baseRemote[b.k];
          cfg.seenLocal[b.k] = hs[b.k];
        });
        Object.keys(cfg.seenLocal).forEach(function (k) { if (!(k in hs)) delete cfg.seenLocal[k]; });
        summary.conflicts = plan.conflicts.length;
        plan.conflicts.forEach(function (c) { cfg.conflicts.unshift(c); });
        cfg.conflicts = cfg.conflicts.slice(0, MAX_CONFLICTS_KEPT);
        cfg.lastSync = Date.now();
        cfg.lastError = summary.raced ? { message: "Another device wrote while this one was syncing; syncing again.", kind: "raced", at: Date.now() } : null;
        saveCfg(cfg);
        applying = false;
        showBanner(cfg);
        return summary;
      });
    }).then(function (sum) {
      running = null;
      if (sum.raced && resyncs < MAX_RESYNC) { resyncs++; return syncNow(); }
      resyncs = 0;
      return sum;
    }, function (err) {
      running = null; applying = false;
      return fail(loadCfg() || cfg, err);
    });
    return running;
  }

  function fetchPayloads(cfg, ids) {
    var out = {};
    if (!ids.length) return Promise.resolve(out);
    var chunks = [];
    for (var i = 0; i < ids.length; i += BATCH) chunks.push(ids.slice(i, i + BATCH));
    return chunks.reduce(function (chain, chunk) {
      return chain.then(function () {
        var q = "SELECT id, payload FROM epok_records WHERE id IN (" + chunk.map(function () { return "?"; }).join(",") + ")";
        return pipeline(cfg, [st(q, chunk)]).then(function (r) { r[0].rows.forEach(function (row) { out[row.id] = row.payload; }); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  /* ==================================================================
     7. SET UP, UNLOCK, TEAR DOWN
     ================================================================== */

  var CHECK_PLAIN = { k: "check", v: "epok-sync" };

  /* First device creates the salt and a check value; a later device reads them
     and must prove the passphrase by opening the check. A wrong passphrase is
     refused before anything is uploaded. */
  function setup(opts) {
    if (!subtle) return Promise.reject(SyncError("This browser has no WebCrypto, so sync cannot encrypt.", "crypto"));
    var url = normaliseUrl(opts.url), token = String(opts.token || "").trim(), pass = String(opts.passphrase || "");
    if (!/^https?:\/\//i.test(url)) return Promise.reject(SyncError("The database URL should start with libsql:// or https://.", "input"));
    if (!token) return Promise.reject(SyncError("Paste the database token.", "input"));
    if (pass.length < 8) return Promise.reject(SyncError("Use a passphrase of at least 8 characters — it is the only thing protecting the uploaded copy.", "input"));
    var probe = { url: url, token: token };
    var keys, salt, check;
    return pipeline(probe, SCHEMA.concat([st("SELECT k, v FROM epok_meta")])).then(function (res) {
      var meta = {}; res[2].rows.forEach(function (r) { meta[r.k] = r.v; });
      salt = meta.salt || b64(randomBytes(16));
      return deriveKeys(pass, salt).then(function (k) {
        keys = k;
        if (meta.salt && meta.check) {
          return open(keys, meta.check).then(function (v) {
            if (!v || v.v !== CHECK_PLAIN.v) throw SyncError("That passphrase does not open the data already in this database.", "passphrase");
            check = meta.check;
          }, function () { throw SyncError("That passphrase does not open the data already in this database.", "passphrase"); });
        }
        return seal(keys, CHECK_PLAIN).then(function (c) {
          check = c;
          return pipeline(probe, [
            st("INSERT OR REPLACE INTO epok_meta (k, v) VALUES ('salt', ?)", [salt]),
            st("INSERT OR REPLACE INTO epok_meta (k, v) VALUES ('check', ?)", [check])
          ]);
        });
      });
    }).then(function () {
      KEYS = keys;
      saveCfg(blankCfg(url, token, salt, check));
      E.Store._onSaved = function () { noteLocalChange(); };
      return noteLocalChange();
    }).then(function () { return syncNow(); });
  }

  /* Each session: derive the key again and prove it against the stored check. */
  function unlock(passphrase) {
    var cfg = loadCfg();
    if (!cfg) return Promise.reject(SyncError("Sync is not set up on this device.", "off"));
    return deriveKeys(String(passphrase || ""), cfg.salt).then(function (k) {
      return open(k, cfg.check).then(function (v) {
        if (!v || v.v !== CHECK_PLAIN.v) throw SyncError("That is not the sync passphrase.", "passphrase");
        KEYS = k; cfg.lastError = null; saveCfg(cfg); showBanner(cfg);
        return syncNow();
      }, function () { throw SyncError("That is not the sync passphrase.", "passphrase"); });
    });
  }

  function setEnabled(on) {
    var cfg = loadCfg(); if (!cfg) return;
    cfg.enabled = !!on; if (on) cfg.lastError = null;
    saveCfg(cfg); showBanner(cfg);
    if (on) { noteLocalChange(); schedule(); }
  }

  /* Remove the uploaded copy and turn sync off here. Returns how many rows went. */
  function deleteRemote() {
    var cfg = loadCfg();
    if (!cfg) return Promise.reject(SyncError("Sync is not set up on this device.", "off"));
    return pipeline(cfg, [st("DELETE FROM epok_records"), st("DELETE FROM epok_meta")]).then(function (res) {
      var n = res[0].affected;
      forget();
      return n;
    });
  }

  /* Forget sync on THIS device only; the database is left as it is. */
  function forget() {
    try { localStorage.removeItem(CFG_KEY); } catch (e) { /* nothing to remove */ }
    KEYS = null;
    if (timer) { clearTimeout(timer); timer = null; }
    E.clearBanner("sync");
  }

  function status() {
    var cfg = loadCfg();
    if (!cfg) return { configured: false };
    var pending = 0;
    var recs = localRecords();
    Object.keys(recs).forEach(function (k) { if (cfg.seenLocal[k] !== undefined && cfg.seenLocal[k] !== cfg.baseLocal[k]) pending++; });
    return {
      configured: true, enabled: cfg.enabled, unlocked: !!KEYS, url: cfg.url,
      lastSync: cfg.lastSync, lastError: cfg.lastError, conflicts: cfg.conflicts, pending: pending,
      syncing: !!running
    };
  }

  function init() {
    var cfg = loadCfg();
    if (!cfg) return;
    E.Store._onSaved = function () { noteLocalChange(); };
    showBanner(cfg);
    window.addEventListener("online", function () { schedule(); });
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") schedule(); });
  }

  var Sync = {
    available: function () { return !!subtle; },
    setup: setup, unlock: unlock, syncNow: syncNow, setEnabled: setEnabled,
    deleteRemote: deleteRemote, forget: forget, status: status, init: init,
    // Installed once so a later setup() starts tracking without a reload.
    _hook: function () { E.Store._onSaved = function () { noteLocalChange(); }; },
    _canon: canon
  };

  window.Epok = window.Epok || {};
  window.Epok.Sync = Sync;
})();

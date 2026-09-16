/* ==========================================================================
   EPOK · LOCK

   Owner: Window A. See PLAN-epok.md § Parallel windows.

     · PIN           6 digits, PBKDF2-derived key, AES-GCM at rest
     · FORCED BACKUP enabling encryption downloads an encrypted backup first, or it does not complete
     · LOCK ON OPEN  no idle timeout, no mid-session re-prompt
     · SCREEN        the unlock UI, and the plain-words warning that a lost PIN is final

   Public namespace: Epok.Lock
   ========================================================================== */

"use strict";

(function () {
  var E = window.Epok;

  /* ------------------------------------------------------------------
     CONSTANTS
     ------------------------------------------------------------------ */

  // ~200ms on a mid-range phone. Raise this over time; never lower it, because
  // lowering it weakens every PIN already in use without telling anyone.
  var PBKDF2_ITERATIONS = 250000;
  var SALT_BYTES = 16;
  var IV_BYTES   = 12;          // AES-GCM's native nonce size
  var PIN_LENGTH = 6;

  var STORE_KEY = "epok.state.v1";

  // Held for the session only. Never persisted, never written anywhere.
  var SESSION_KEY = null;
  var SESSION_SALT = null;

  var subtle = (window.crypto && window.crypto.subtle) || null;

  /* ==================================================================
     1. PRIMITIVES
     ================================================================== */

  function bytes(n) {
    var b = new Uint8Array(n);
    window.crypto.getRandomValues(b);
    return b;
  }

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

  function deriveKey(pin, salt) {
    return window.crypto.subtle
      .importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"])
      .then(function (material) {
        return window.crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
          material,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"]);
      });
  }

  /* The envelope. `enc: 1` is what Epok.Store.isSealed() looks for, and the
     KDF parameters travel with the ciphertext so raising the iteration count
     later cannot lock anyone out of data sealed at the old count. */
  function seal(key, salt, plaintext) {
    var iv = bytes(IV_BYTES);
    return window.crypto.subtle
      .encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(plaintext))
      .then(function (ct) {
        return JSON.stringify({
          enc: 1,
          kdf: "PBKDF2-SHA256",
          iter: PBKDF2_ITERATIONS,
          salt: b64(salt),
          iv: b64(iv),
          ct: b64(ct)
        });
      });
  }

  function open(key, envelope) {
    return window.crypto.subtle
      .decrypt({ name: "AES-GCM", iv: unb64(envelope.iv) }, key, unb64(envelope.ct))
      .then(function (buf) { return new TextDecoder().decode(buf); });
  }

  function readRaw() {
    try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; }
  }

  function envelope() {
    var raw = readRaw();
    if (!E.Store.isSealed(raw)) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function validPin(pin) {
    return typeof pin === "string" && new RegExp("^\\d{" + PIN_LENGTH + "}$").test(pin);
  }

  /* ==================================================================
     2. DOWNLOAD
     ------------------------------------------------------------------
     A3 guard. Enabling the PIN takes the backup as step one, before the
     plaintext is replaced — so the only ordering in which encryption can
     complete is the one where the backup was produced first.

     The limit, stated where the claim is: a browser can still cancel a
     download and the page cannot see that it did. So the setup screen also
     says, in plain words, that nobody can recover a forgotten PIN.
     ================================================================== */

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  function backupName() {
    return "epok-backup-" + E.calendarToday() + ".encrypted.json";
  }

  /* ==================================================================
     3. THE INTERFACE
     ================================================================== */

  function isEnabled() { return E.Store.isSealed(readRaw()); }
  function isLocked()  { return isEnabled() && SESSION_KEY === null; }
  function hasKey()    { return SESSION_KEY !== null; }

  function attachCipher() {
    // Every later save routes through here, so state never returns to
    // plaintext at rest while the PIN is on.
    E.Store._cipher = function (plaintext) { return seal(SESSION_KEY, SESSION_SALT, plaintext); };
  }

  function enable(pin) {
    if (!subtle) {
      return Promise.resolve({ ok: false, error: "This browser has no Web Crypto, so epok cannot encrypt." });
    }
    if (!validPin(pin)) {
      return Promise.resolve({ ok: false, error: "The PIN must be exactly " + PIN_LENGTH + " digits." });
    }
    if (isEnabled()) {
      return Promise.resolve({ ok: false, error: "Encryption is already on." });
    }

    var salt = bytes(SALT_BYTES), key = null, sealed = null;
    return deriveKey(pin, salt)
      .then(function (k) { key = k; return seal(k, salt, E.Store._plaintext()); })
      .then(function (text) {
        sealed = text;
        // Step one: the backup. Before anything is overwritten.
        var backup = new Blob([sealed], { type: "application/json" });
        download(backup, backupName());
        // Step two, and only now: replace the plaintext at rest.
        try {
          localStorage.setItem("epok.state.prev", sealed);
          localStorage.setItem(STORE_KEY, sealed);
        } catch (e) {
          return { ok: false, error: "Could not write the encrypted state: " + (e.name || e) };
        }
        SESSION_KEY = key;
        SESSION_SALT = salt;
        attachCipher();
        return { ok: true, backup: backup };
      })
      .catch(function (err) { return { ok: false, error: String(err && err.message || err) }; });
  }

  function unlock(pin) {
    var env = envelope();
    if (!env) return Promise.resolve({ ok: false, error: "There is nothing encrypted to unlock." });
    if (!validPin(pin)) {
      return Promise.resolve({ ok: false, error: "The PIN must be exactly " + PIN_LENGTH + " digits." });
    }
    var salt = unb64(env.salt);
    // The iteration count travels in the envelope, so data sealed before a
    // raise still opens at the count it was sealed with.
    var iter = Number(env.iter) || PBKDF2_ITERATIONS;
    return window.crypto.subtle
      .importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"])
      .then(function (material) {
        return window.crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: salt, iterations: iter, hash: "SHA-256" },
          material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      })
      .then(function (key) {
        return open(key, env).then(function (plaintext) {
          E.Store._adopt(plaintext);
          SESSION_KEY = key;
          SESSION_SALT = salt;
          attachCipher();
          return { ok: true, error: null };
        });
      })
      .catch(function () {
        // AES-GCM authenticates: a failed decrypt means the wrong PIN or
        // tampered data, and there is no way to tell which. Say only what is
        // known.
        return { ok: false, error: "That PIN did not open your data." };
      });
  }

  function disable(pin) {
    if (!isEnabled()) return Promise.resolve({ ok: false, error: "Encryption is not on." });
    return unlock(pin).then(function (r) {
      if (!r.ok) return r;
      E.Store._cipher = null;
      SESSION_KEY = null;
      SESSION_SALT = null;
      E.Store.flush();          // writes plaintext, now that the cipher is off
      return { ok: true, error: null };
    });
  }

  /* ==================================================================
     4. THE LOCK SCREEN
     ------------------------------------------------------------------
     Mounted by boot instead of the app when isLocked() is true. There is no
     "continue without unlocking" — there is nothing to continue into.
     ================================================================== */

  function screen(onUnlocked) {
    var input = E.el("input", {
      type: "password", inputmode: "numeric", autocomplete: "off",
      maxlength: String(PIN_LENGTH), class: "pin", "aria-label": "PIN", id: "pin"
    });
    var msg = E.el("p", { class: "small", style: "min-height:1.4em" });
    var btn = E.el("button", { type: "button", class: "btn btn--accent", text: "UNLOCK" });

    function attempt() {
      msg.textContent = "Checking…";
      msg.className = "small dim";
      btn.disabled = true;
      unlock(input.value).then(function (r) {
        btn.disabled = false;
        if (r.ok) { onUnlocked(); return; }
        msg.textContent = r.error;
        msg.className = "small";
        msg.style.color = "var(--danger)";
        input.value = "";
        input.focus();
      });
    }

    btn.addEventListener("click", attempt);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") attempt(); });

    var form = E.el("section", { class: "card lock" }, [
      E.el("div", { class: "card__head" }, [
        E.el("h1", { text: "EPOK" }),
        E.el("span", { class: "micro", text: "LOCKED" })
      ]),
      E.el("p", { class: "micro", text: "PIN" }),
      input,
      E.el("div", { class: "row" }, [btn]),
      msg,
      E.el("hr", { class: "rule" }),
      E.el("p", { class: "small faint", text:
        "Your log is encrypted on this device with your PIN. Nobody — not this app, not " +
        "your browser, not the person who wrote it — can open it without that PIN. If you " +
        "have forgotten it, the encrypted backup file you downloaded when you switched " +
        "encryption on is also unopenable. There is no reset." })
    ]);
    setTimeout(function () { input.focus(); }, 0);
    return form;
  }

  /* The warning text the settings view renders BEFORE the PIN is set, so the
     consequence is read before the decision, not after it. */
  var SETUP_WARNING =
    "Switching encryption on will download an encrypted backup of your log first — that is " +
    "not optional. Keep that file. If you forget your PIN, neither the file nor the data in " +
    "this browser can ever be opened again, by anyone. There is no reset and no recovery.";

  var Lock = {
    PIN_LENGTH: PIN_LENGTH,
    SETUP_WARNING: SETUP_WARNING,
    available: !!subtle,

    isEnabled: isEnabled,
    isLocked: isLocked,
    hasKey: hasKey,
    enable: enable,
    unlock: unlock,
    disable: disable,
    screen: screen,
    backupName: backupName,
    download: download
  };

  window.Epok = window.Epok || {};
  window.Epok.Lock = Lock;
})();

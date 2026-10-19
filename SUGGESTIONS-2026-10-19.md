# epok — suggestions

Written 2026-10-19, against commit `46afe6f` plus 25 uncommitted files (the
3 Oct review implementation and the features/sync build).
Method: headless Chromium on `file://`, with real clicks on Today's chips.
Two-tab probes with and without the PIN on (the PIN typed into the real lock
screen). The service worker run on one local origin next to `vis`. A read of
`storage.js` (load, commit, the `prev` write-through) and `crypto.js` (seal,
open, unlock). The live site was confirmed through `gh api`:
`talon270.github.io/epok/`.

**Three fixes applied in this pass (A1, A1b, A2). Everything else is a
suggestion and is not implemented.** Backups:
`js/storage.backup-20261019-085119.js` and
`service-worker.backup-20261019-053918.js`. `js/crypto.js` was clean in git.
`deploy/public/` was **not** touched. Run `./deploy.sh` to carry all three
across.

## Result

Zero page errors and console errors (11-click smoke run after the fixes).
`tools/verify.py`: 902 checks, 0 failed, and `tools/score.js`: all cohorts
within their bars. Both of those ran **before** this pass's edits and have not
been re-run since. See the check log.

## Part A — findings, ranked

### A1 · BUG (high): a second open tab erased a logged day — FIXED

This broke the app's own first rule ("never lose or misdate a logged day").
Nothing listened for `storage`, so a stale tab's next save overwrote the log.

| Two tabs on Today: A taps HEAVY, then B taps HEADACHE | Flow days stored after B's tap |
|---|---|
| Before | **`{}`** (only `epok.state.prev` still held it, one save deep) |
| After | `{2026-10-19: heavy}` |
| Before, PIN on, both tabs unlocked | B never saw A's day, so its sealed save dropped it |
| After, PIN on, both tabs unlocked | B adopts it (`flow = heavy` in both tabs) |

**Fix (applied):** a `storage` listener at the end of `storage.js`. Plaintext
goes through `tryParse` + `applyProfile`. A sealed blob goes to the new
`Epok.Lock.adoptSealed(raw)` in `crypto.js`, which opens it with this tab's
session key. Then `E.refresh()`. Ceiling (`ponytail:` comment): an edit made
inside the 200 ms save debounce can still lose the race.

### A1b · BUG (high, pre-existing): a tab without the key wrote the log back in plaintext — FIXED

Tab B is open and unlocked-by-default (no PIN yet) while tab A switches the
PIN on. B's next save wrote its plaintext state over A's sealed blob. That
silently undid the encryption at rest, and the same applies if the PIN was
changed in another tab.

| | Stored log after B's next save |
|---|---|
| Before | **plaintext** |
| After | still sealed. B shows "epok was locked in another tab. Nothing here will be saved: reload and enter your PIN." and goes read-only (`STATE.__readonly`, which `writeNow()` already honours) |

**Fix (applied):** when a sealed save can't be opened with this tab's key,
the listener marks the tab read-only and raises the banner. 13 lines.

### A2 · BUG (high): the service worker deleted every other app's offline cache — FIXED

On activate it deleted every cache except `epok-v4`. The `talon270.github.io`
apps share one CacheStorage, so this wiped vis's, Study's, Docket's and the
rest's offline copies. Reproduced with an app carrying the same filter: `vis`
offline then returns 504 "Offline, and this file was never cached."
**Fix (applied):** delete only names starting `epok-`. Checked on one local
origin: `vis-shell-3` survives, a planted `epok-stale-old` is deleted, and
`epok-v4` installs. A1 and A1b need no cache bump: the worker serves from
the cache and refreshes it in the background, so installed copies pick up the
new `storage.js` one load after you deploy. That is the worker's stated
trade-off.

### A3 · DESIGN RISK (medium): 2,567 lines uncommitted since 16 Sep

The review fixes, schema v4, sync and now A1/A1b all exist only in the
working tree.

## Check log

- `tools/verify.py` and `tools/score.js` need a re-run after A1/A1b. They are
  in the final cross-app test run, and the result is appended below when it
  finishes.

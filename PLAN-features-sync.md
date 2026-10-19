# epok — six features, multi-month calendar, optional Turso sync — plan

Written 2026-10-03, against the working tree on top of `46afe6f` (algorithm-review fixes applied, uncommitted; schema v3).
Method: re-read `REVIEW-algorithm-2026-10-03.md` § "Additional features" and the code those features touch (`storage.js`, `model.js`, `views/calendar.js`, `views/today.js`, `views/report.js`, `crypto.js`); `python3 tools/verify.py` → 780 checks, 0 failed, and `node tools/score.js --seeds 300` → exit 0 as the baseline. **Not checked:** Turso's browser behaviour (CORS, request shape, token scopes) — no account or database exists to test against, so every Turso claim below is unverified until Phase 2.
**Nothing below is implemented — this is the plan.**

## Part 0 — decisions that need your answer before code moves

### D1 · DESIGN RISK (high): a Turso backend breaks three rules in `Agents.md`

`Agents.md` says "No accounts, no backend, no CDN" and "Everything must work offline and forever." Turso is a hosted service with an account and an auth token. Two concrete problems:

- **A token in the app is a token in public.** The site is a static page on public GitHub Pages and the repo is public. A database token compiled into `index.html` or any `js/` file can be read by anyone and gives them read/write on your cycle data. It must never be in the repo or the deployed files.
- **Health data would leave the device.** Today the log never leaves the browser (`deploy.sh` says so in its header). Sync changes that sentence for the README and for the privacy note.

**Recommendation: ship it as an opt-in sync target, off by default, that cannot weaken the offline guarantee.** The local `localStorage` state stays the source of truth; the app is fully usable with the sync switched off or Turso unreachable. Specifically:

| Rule | How it is kept |
|---|---|
| No token in the repo | You paste the database URL and a token into Settings; they are stored in your browser only (inside the PIN-sealed state when the PIN is on). A repo-wide grep for `libsql://` and `eyJ` runs in `verify.py`. |
| Turso never sees your data | Every record is AES-GCM encrypted in the browser with a sync passphrase (the primitives already in `js/crypto.js`) before it is sent. The database holds ciphertext and dates' hashes, nothing readable. Lose the passphrase and the remote copy is unrecoverable — stated at the setup step. |
| Works offline | Edits write locally first and queue; sync runs when online. Failure shows a banner with the age of the last good sync ("stale beats fake"), never a spinner that implies freshness. |
| No silent configuration | Sync is a Settings section with its own switch, off by default, with what it uploads listed in plain words before it is turned on. |
| No CDN | Plain `fetch` to the database's HTTP endpoint. No `@libsql/client`, no bundler. |

**If you would rather not have a backend at all**, the alternative that keeps every rule is a manual encrypted backup file (already built) plus, if you want multi-device, a file-based sync you move yourself. Say so and Part C is dropped; nothing else in this plan depends on it.

### D2 · What "larger calendar" means

Chosen default, change it if wrong: a **view switch — MONTH · 3 MONTHS · YEAR** on the Calendar page. Month stays as is. 3 MONTHS shows the previous, current and next month side by side at ≥1200px and stacked below. YEAR is twelve compact month grids coloured by the same period / fertile / predicted tints, tap a month to open it. Cells grow with the viewport (today the grid is capped at 1120px).

## Part A — the six features, ranked by dependency, not by size

Each is independently shippable. Every schema change bumps `SCHEMA_VERSION` and ships its migration in the same step; the chain is v3 → v4 (A1, A2, A4, A5 together, one migration) so a user is not migrated four times.

### A1 · Cycle review and correction (feature 1)
**What:** a Timeline view (new tab) listing each cycle: start, source (marked by you / inferred), length, bleed days, spotting days, whether a BBT/LH chart exists, and flags for gaps ("45-day cycle — a missed entry or a real long cycle?"). Per cycle: move start, split, merge with the previous, or **exclude from the fit** (kept in history, ignored by the model).
**Why this first:** it is the only place a wrong start — the model's only input — can be fixed in one screen. It needs `cycle.excluded` (v4) and one change in `model.js`: `closedCycles()` skips excluded cycles but their length is still shown.
**Guard (Phase 0 Q2):** every correction previews the forecast change before commit (reuses `previewPeriodStart`) and registers an undo. No modal.
**Confidence labelling:** the "long-cycle" flag says "possible missed entry" and shows both readings; it never deletes or edits a start on its own.

### A2 · Forecast history and personal reliability (feature 2)
**What:** `state.predictions[]` has been in the schema since v1 and nothing writes it. Write a snapshot when a forecast is first shown for a cycle and when the evidence changes it: `{ madeOn, forDay, nextStart, window, mode, n, modelVersion, inputRev }`; fill `actual` and `errorDays` when the next start is logged. Insights gets a table: forecast made, actual start, lead time, error, inside/outside the window.
**Honesty rule:** rows from saved snapshots and rows from the retrospective backtest are labelled separately and never pooled into one "measured error" number until there are ≥ 6 real snapshots; below that the card keeps saying "reconstructed".
**Needs:** `MODEL_VERSION` constant in `model.js` so a snapshot says which engine made it.

### A3 · Daily symptom check-in (feature 3)
**What:** extends the boolean `day.checkin` from the review fix to `{ checkin: true, severity: {tagId: 1..3}, impact: null|"none"|"some"|"a lot" }`, with a completeness line on Today ("14 of the last 14 days checked in"). Severity is recorded per tag; Insights compares rates as today and additionally shows the mean severity, never a derived "score".
**Limit stated up front:** severity is self-rated and unvalidated; no clinical scale is implied and the card says so.

### A4 · Temperature quality (feature 4)
**What:** per reading, an optional measurement time and a "disturbed" reason (illness, alcohol, poor sleep, travel, early alarm). A disturbed reading is kept but excluded from `detectOvulation()`'s baseline and rise test. Schema: `day.bbtMeta = { time, disturbed: reason|null }`.
**Model change:** `detectOvulation` skips excluded readings; the existing "≥ 4 readings in the six-day baseline" rule then decides whether it can still call a rise — so excluding too many returns `null` instead of a guess.
**Verification:** score.js check that a single outlier flagged disturbed no longer produces a false rise, and an unflagged one still does.

### A5 · Dated life and medication events (feature 5)
**What:** `state.events[] = [{ id, type, from, to|null, note }]`, types: contraception change, pregnancy, postpartum, breastfeeding, medication (free text), other. Settings → Events, and a one-line entry on Today.
**Why it matters beyond the feature:** it closes the known gap from the algorithm fixes — cycles logged on a hormonal method counted again once it was set to NONE. With dated spans, `closedCycles()` drops any cycle overlapping a suppressing span, and pregnancy/postpartum/breastfeeding pause the forecast with the reason shown, exactly as the contraception pause does now.
**Migration:** `profile.contraception` + `contraceptionStart` become the first event of type contraception on v4; the old fields are kept (read, never written) for one version so a rollback does not lose them.
**Unverified claim to settle:** whether to pause on breastfeeding and postpartum is a product call, not a measured one — default is "show the forecast with a visible caveat, offer a pause", not an automatic pause.

### A6 · Clinician report (feature 6)
**What:** date-range selector (3 / 6 / 12 months / custom), severity and impact columns from A3, prolonged-bleeding episodes (bleeding > 7 days flagged, count shown), events from A5 on the timeline, observation completeness ("temperature on 41% of days"), and phase summaries based on detected ovulation (when present) instead of the current average-cycle midpoint.
**Constraint:** prints as before (`css/print.css`), says SELF-REPORTED on every page, and states what it does not contain. Depends on A2–A5, so last.

## Part B — calendar and QoL

### B1 · Multi-month calendar (D2)
Month · 3 months · Year switch; selection and the detail panel work in all three; the existing `estimates()` is computed once per render and shared, not per month. Verify at 1920 and 1440 and 400 wide (`memory.md` § Layout): no stranded space on either side, both themes.
**Out of this step:** week view and drag-to-select ranges.

### B2 · QoL, bounded — each is small and none adds a dependency
| Item | Behaviour |
|---|---|
| Keyboard | `←/→` previous/next month, `T` today, `1/3/Y` switch view, `L` log this day. Listed in a `?` panel, not hidden. |
| Jump to date | A native `<input type="date">` beside the nav. |
| Quick log from the calendar | Tap a day → the detail panel gets flow chips and the check-in chip inline, so a past day does not need a trip to Today. |
| Undo is always findable | The existing undo toast is kept; add a "last change" line in Settings with a one-step revert for the most recent edit. |
| Today view | Collapse the tag grid into the categories you actually use (top 6 by use) with "all" expanding the rest. No setting is changed silently — the rule is shown and can be turned off. |
| Empty and first-run states | One sentence of next-step guidance on every empty view. |
**Not in scope:** themes, animations, a settings redesign.

## Part C — optional Turso sync (only if D1 is answered "yes")

Built in this order because the first step can be thrown away cheaply.

1. **C0 · Skeleton against a real database, nothing wired.** You create a Turso database and a per-database token; a scratch script in the session scratchpad sends one `INSERT` and one `SELECT` over the HTTP pipeline endpoint from a browser page on `https://` and on `file://`. **This is where CORS and the request shape are verified or the plan stops** — browsers calling the endpoint directly is the unproven assumption the rest depends on. If it fails, the fallback is the file-based option in D1 and Part C ends here.
2. **C1 · Wire format.** One table `epok_records(id TEXT PRIMARY KEY, kind TEXT, payload BLOB, updated_at INTEGER, deleted INTEGER)`. `id` is a keyed hash of the record key (`day:2026-09-14`, `cycle:…`, `event:…`, `profile`) so the database cannot list your dates. `payload` is the AES-GCM ciphertext of the JSON record. Needs a per-record `updated` timestamp on days, cycles and events (v4, same migration as Part A).
3. **C2 · Merge.** Pull records changed since the last sync, merge **last-writer-wins per record**, push local changes. A conflict (same record changed on two devices since the last sync) is listed in Settings with both versions and the date — nothing is overwritten without the previous state landing in `epok.state.prev` first. **Limit stated in the UI:** last-writer-wins can lose an edit made at the same time on two devices; that is why conflicts are shown rather than resolved quietly.
4. **C3 · Failure behaviour.** Offline, bad token, quota, or revoked database each produce a banner naming the cause and the time of the last good sync. The app never blocks on the network and never shows a sync as current when it is not.
5. **C4 · Setup and teardown.** Settings → Sync: URL, token, passphrase (twice), a plain-words list of what is uploaded, then a switch. "Delete remote copy" issues the deletes and says how many rows went. Turning sync off leaves local data untouched.

**Privacy and the public repo:** `Stonks/`-style rule applies — no URL, token or passphrase ever lands in a tracked file. `verify.py` greps the repo and `deploy/public` for them and fails the run on a hit.

## Part D — build order and verification

1. D1/D2 answered. 2. **Skeleton:** v4 schema + migration only (all new fields, no UI) — seed a v3 state, reload, data survives. 3. A1 → A5 as vertical slices, each with its `verify.py` section and, where the model changes (A1 exclusions, A4 disturbed readings, A5 spans), a `score.js` check that fails on the previous model. 4. B1, B2. 5. A6. 6. Part C, C0 first. 7. README section 4 written as each lands, not at the end.

**Standing checklist per step** (`skills.md` Phase 4): backup of any large single file before editing (`js/model.js`, `js/storage.js` get timestamped copies in the scratchpad), zero console errors on a fresh and a seeded profile, v3 → v4 seed reload, both themes, 1920 / 1440 / 400 widths, empty / one / realistic-volume states, no `alert()` / `confirm()`, every new estimate marked as one, JSON backup round-trip and CSV export still parse (CSV gains the new columns).

**Honest size:** this is the largest change since the original build — about eleven slices. A1–A5 plus B1/B2 is a coherent release on its own; A6 and Part C can follow as separate releases if you want something usable sooner.

## Out of scope

- Push notifications from a server (needs a backend that would hold keys); reminders stay in-app.
- A Turso-hosted *read* of plaintext, server-side queries, or sharing a log with another person — it would require the database to see the data.
- Any ML or new prediction family; the model changes here are exclusions and spans only.
- Week view, accounts, or a login screen.
- Contraception advice of any kind (`NO_GUIDANCE` stays).

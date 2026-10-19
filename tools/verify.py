#!/usr/bin/env python3
"""Drive epok headlessly and assert on the DOM. Reading forms the hypothesis;
this confirms it. Owner: Window A.

Checks, per PLAN-epok.md § Verification:
  - zero console errors, fresh profile and seeded profile
  - a corrupt live state falls back to epok.state.prev, with the banner (A1)
  - a sparse older-shape state survives a load without losing a day
  - the day boundary lands a 00:20 log on the previous day (A2)
  - all 4 palettes x light/dark, contrast AA on every text-on-surface pairing
  - 1920 / 1440 / 400 px, no stranded background, no horizontal scroll (A7)
  - navigation by real clicks across every registered view

Drive real clicks, never page.evaluate for interaction -- inline handlers
resolve in a different scope and a real bug vanishes under evaluate. evaluate
is used here only to READ computed styles and to seed localStorage.

    python3 tools/verify.py            # everything
    python3 tools/verify.py contrast   # one section
"""
from __future__ import annotations

import csv as csv_mod
import functools
import http.server
import io
import json
import pathlib
import socketserver
import threading
import re
import sys

from playwright.sync_api import sync_playwright

APP = pathlib.Path(__file__).resolve().parent.parent / "index.html"
URL = APP.as_uri()

THEMES = ["quasar", "arasaka", "chernobyl", "monolith"]
MODES = ["dark", "light"]
VIEWS = ["today", "calendar", "timeline", "insights", "settings", "report"]
WIDTHS = [1920, 1440, 400]

# AA. 4.5:1 for body text, 3:1 for large text and for UI lines that carry
# meaning. --line is deliberately below this: it is decoration, not signal.
TEXT_ON_SURFACE = [
    ("--fg", "--bg"), ("--fg", "--surface"), ("--fg", "--surface-2"),
    ("--fg-dim", "--bg"), ("--fg-dim", "--surface"), ("--fg-dim", "--surface-2"),
    ("--fg-faint", "--bg"), ("--fg-faint", "--surface"), ("--fg-faint", "--surface-2"),
    ("--accent", "--bg"), ("--accent", "--surface"), ("--accent", "--surface-2"),
    ("--on-accent", "--accent"),
    ("--warn", "--surface-2"), ("--danger", "--surface-2"),
    ("--estimate", "--bg"), ("--estimate", "--surface"),
    # Calendar cells put day numbers and labels straight on these tints.
    ("--fg", "--period-1"), ("--fg", "--period-2"), ("--fg", "--period-3"), ("--fg", "--period-4"),
    ("--fg", "--fertile-bg"), ("--fg", "--fertile-peak-bg"),
]
UI_ON_SURFACE = [("--line-strong", "--bg"), ("--line-strong", "--surface")]

FAILURES: list[str] = []
CHECKS = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if not ok:
        FAILURES.append(f"{label}{(' — ' + detail) if detail else ''}")


# ---------------------------------------------------------------- colour ----

def _srgb(c: float) -> float:
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb: tuple[int, int, int]) -> float:
    r, g, b = (_srgb(v / 255) for v in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def parse_colour(s: str) -> tuple[int, int, int]:
    s = s.strip()
    if s.startswith("#"):
        s = s[1:]
        if len(s) == 3:
            s = "".join(ch * 2 for ch in s)
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    if s.startswith("color(srgb"):
        # How Chromium serialises a resolved color-mix(): channels 0..1.
        nums = s[s.index("(") + 1: s.index(")")].replace("srgb", " ").replace("/", " ").split()
        return tuple(round(float(n) * 255) for n in nums[:3])  # type: ignore[return-value]
    if s.startswith("rgb"):
        nums = s[s.index("(") + 1: s.index(")")].replace("/", " ").replace(",", " ").split()
        return tuple(int(float(n)) for n in nums[:3])  # type: ignore[return-value]
    raise ValueError(f"cannot parse colour {s!r}")


# ----------------------------------------------------------------- pages ----

def new_page(browser, width=1440, height=950, seed=None, colour_scheme="dark"):
    ctx = browser.new_context(viewport={"width": width, "height": height},
                              color_scheme=colour_scheme)
    page = ctx.new_page()
    errs: list[str] = []
    page.on("pageerror", lambda e: errs.append(f"PAGEERROR: {e}"))
    page.on("console", lambda m: m.type == "error" and errs.append(f"CONSOLE: {m.text}"))
    if seed:
        page.add_init_script(
            "(() => { const s = " + json.dumps(seed) + ";"
            " for (const k in s) { try { localStorage.setItem(k, s[k]); } catch (e) {} } })()"
        )
    page.goto(URL)
    page.wait_for_timeout(350)
    return ctx, page, errs


SEEDED_STATE = {
    "v": 1,
    "profile": {"created": "2026-01-01", "dayBoundaryHour": 4, "theme": "monolith", "mode": "light"},
    "days": {
        "2026-08-18": {"flow": "medium", "tags": ["cramps"], "bbt": 36.4, "lh": None, "pill": None, "note": ""},
        "2026-09-14": {"flow": "light", "tags": [], "bbt": None, "lh": None, "pill": None, "note": "seeded"},
    },
    "cycles": [{"start": "2026-08-18", "end": "2026-08-23", "length": None,
                "ovulation": None, "ovulationSource": None}],
    "customTags": [], "predictions": [], "meta": {"lastOpened": "2026-09-01", "onboarded": True},
}

# What an older build would plausibly have written: no `v`, no profile keys
# that did not exist yet, no arrays that were added later.
SPARSE_OLD_STATE = {
    "days": {"2026-07-02": {"flow": "heavy"}},
    "cycles": [{"start": "2026-07-02"}],
}


# ------------------------------------------------------------- the checks ----

def check_boot(browser) -> None:
    ctx, page, errs = new_page(browser)
    check(errs == [], "fresh profile: console errors", "; ".join(errs))
    check(page.locator(".rail__item").count() == len(VIEWS),
          "fresh profile: rail lists every view",
          f"got {page.locator('.rail__item').count()}")
    check(page.locator("#main section").count() >= 1, "fresh profile: a view mounted")
    ctx.close()

    ctx, page, errs = new_page(browser, seed={"epok.state.v1": json.dumps(SEEDED_STATE)})
    check(errs == [], "seeded profile: console errors", "; ".join(errs))
    day = page.evaluate("() => Epok.Store.day('2026-09-14').note")
    check(day == "seeded", "seeded profile: a logged day survives load", repr(day))
    theme = page.evaluate("() => document.documentElement.getAttribute('data-theme')")
    mode = page.evaluate("() => document.documentElement.getAttribute('data-mode')")
    check(theme == "monolith", "seeded profile: theme applied from profile", repr(theme))
    check(mode == "light", "seeded profile: mode applied from profile", repr(mode))
    ctx.close()


def check_migration(browser) -> None:
    """A1: a corrupt live state must fall back to prev, loudly."""
    seed = {"epok.state.v1": "{not json at all",
            "epok.state.prev": json.dumps(SEEDED_STATE)}
    ctx, page, errs = new_page(browser, seed=seed)
    check(errs == [], "corrupt state: no console errors", "; ".join(errs))
    recovered = page.evaluate("() => Epok.Store.day('2026-09-14').note")
    check(recovered == "seeded", "corrupt state: recovered from epok.state.prev", repr(recovered))
    banner = page.locator('[data-banner="recovered"]')
    check(banner.count() == 1, "corrupt state: persistent banner shown")
    check("previous save" in (banner.inner_text() if banner.count() else ""),
          "corrupt state: banner says what happened")
    ctx.close()

    # No prev either: refuse to overwrite the unreadable original.
    ctx, page, errs = new_page(browser, seed={"epok.state.v1": "{not json at all"})
    still_there = page.evaluate("() => localStorage.getItem('epok.state.v1')")
    check(still_there == "{not json at all",
          "unrecoverable state: the original is NOT overwritten", repr(still_there))
    check(page.locator('[data-banner="recovered"]').count() == 1,
          "unrecoverable state: persistent banner shown")
    ctx.close()

    # An older, sparse shape must gain its missing fields without losing a day.
    ctx, page, errs = new_page(browser, seed={"epok.state.v1": json.dumps(SPARSE_OLD_STATE)})
    check(errs == [], "sparse old state: no console errors", "; ".join(errs))
    got = page.evaluate("() => JSON.stringify(Epok.Store.day('2026-07-02'))")
    d = json.loads(got)
    check(d["flow"] == "heavy", "sparse old state: the logged day survives", got)
    check(d["tags"] == [] and "note" in d, "sparse old state: missing fields backfilled", got)
    v = page.evaluate("() => [Epok.Store.get().v, Epok.SCHEMA_VERSION]")
    check(v[0] == v[1], "sparse old state: stamped with the current schema version", repr(v))
    check(page.locator('[data-banner="recovered"]').count() == 0,
          "sparse old state: migrated cleanly, with no recovery fallback")
    ctx.close()


def check_dates(browser) -> None:
    """A2: the boundary is the whole guard against a misdated period start."""
    ctx = browser.new_context(viewport={"width": 1440, "height": 950})
    page = ctx.new_page()
    errs: list[str] = []
    page.on("pageerror", lambda e: errs.append(f"PAGEERROR: {e}"))
    page.goto(URL)
    page.wait_for_timeout(250)

    cases = [
        # (clock, boundary, expected key)
        ("2026-09-15T00:20:00", 4, "2026-09-14"),   # the 1am log, the whole point
        ("2026-09-15T03:59:00", 4, "2026-09-14"),
        ("2026-09-15T04:00:00", 4, "2026-09-15"),
        ("2026-09-15T00:20:00", 0, "2026-09-15"),   # boundary off
        ("2026-03-01T00:30:00", 4, "2026-02-28"),   # month edge
        ("2026-01-01T02:00:00", 4, "2025-12-31"),   # year edge
    ]
    for clock, boundary, expected in cases:
        got = page.evaluate(
            "([clock, b]) => { Epok._setDayBoundary(b); return Epok.ymd(new Date(clock)); }",
            [clock, boundary])
        check(got == expected, f"ymd({clock}, boundary {boundary})", f"got {got}, want {expected}")

    page.evaluate("() => Epok._setDayBoundary(4)")
    # shiftDay/daysBetween must be boundary-FREE, or every key walks backwards.
    checks = page.evaluate("""() => ({
        shift:  Epok.shiftDay('2026-09-15', 1),
        shiftB: Epok.shiftDay('2026-09-15', -1),
        dst:    Epok.daysBetween('2026-03-28', '2026-03-30'),
        span:   Epok.daysBetween('2026-08-18', '2026-09-16'),
        pretty: Epok.prettyDate('2026-09-14'),
        round:  Epok.shiftDay(Epok.shiftDay('2026-09-15', 30), -30)
    })""")
    check(checks["shift"] == "2026-09-16", "shiftDay forward", checks["shift"])
    check(checks["shiftB"] == "2026-09-14", "shiftDay back", checks["shiftB"])
    check(checks["dst"] == 2, "daysBetween across a DST boundary", str(checks["dst"]))
    check(checks["span"] == 29, "daysBetween over a cycle", str(checks["span"]))
    check(checks["pretty"] == "14 Sep 2026", "prettyDate", checks["pretty"])
    check(checks["round"] == "2026-09-15", "shiftDay round-trips", checks["round"])
    check(errs == [], "dates: console errors", "; ".join(errs))
    ctx.close()


def check_navigation(browser) -> None:
    """Real clicks, never evaluate: inline handlers resolve elsewhere."""
    ctx, page, errs = new_page(browser)
    for view in VIEWS:
        page.click(f'.rail__item[data-view="{view}"]')
        page.wait_for_timeout(120)
        active = page.evaluate("() => Epok.activeView()")
        check(active == view, f"click navigates to {view}", repr(active))
        check(page.locator("#main section").count() >= 1, f"{view}: something mounted")
        check(page.locator(f'.rail__item[data-view="{view}"].is-active').count() == 1,
              f"{view}: rail marks the active item")
    check(errs == [], "navigation: console errors", "; ".join(errs))

    # The not-today banner is the A2 guard's visible half.
    page.evaluate("() => Epok.setViewDate(Epok.shiftDay(Epok.today(), -3))")
    page.wait_for_timeout(120)
    b = page.locator('[data-banner="not-today"]')
    check(b.count() == 1, "backfill: not-today banner appears")
    check("not today" in (b.inner_text() if b.count() else "").lower(),
          "backfill: banner says it is not today")
    page.click('[data-banner="not-today"] button')      # a real click on the real control
    page.wait_for_timeout(120)
    check(page.locator('[data-banner="not-today"]').count() == 0,
          "backfill: BACK TO TODAY clears the banner")
    check(page.evaluate("() => Epok.viewDate() === Epok.today()"),
          "backfill: BACK TO TODAY resets the logging date")

    # Undo is the only reversal affordance; there is no confirm() anywhere.
    page.evaluate("() => Epok.undo('Test change', () => { window.__undone = true; })")
    page.wait_for_timeout(100)
    check(page.locator(".undo").count() == 1, "undo: affordance appears")
    page.click(".undo button")
    page.wait_for_timeout(100)
    check(page.evaluate("() => window.__undone === true"), "undo: restore ran")
    check(page.locator(".undo").count() == 0, "undo: affordance dismissed")
    ctx.close()


def check_no_dialogs(browser) -> None:
    ctx, page, errs = new_page(browser)
    fired: list[str] = []
    page.on("dialog", lambda d: (fired.append(d.type), d.dismiss()))
    for view in VIEWS:
        page.click(f'.rail__item[data-view="{view}"]')
        page.wait_for_timeout(80)
    check(fired == [], "no alert()/confirm() on any navigation path", ";".join(fired))
    ctx.close()

    # Comments talk about confirm() constantly; only real call sites count.
    src = "\n".join((pathlib.Path(__file__).resolve().parent.parent / p).read_text()
                    for p in ["js/core.js", "js/storage.js", "js/app.js"])
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"^\s*//.*$", "", src, flags=re.M)
    for bad in ["alert(", "confirm(", "prompt("]:
        check(bad not in src, f"source contains no {bad})")


def check_contrast(browser) -> None:
    ctx = browser.new_context(viewport={"width": 1440, "height": 950})
    page = ctx.new_page()
    page.goto(URL)
    page.wait_for_timeout(250)
    names = sorted({n for pair in TEXT_ON_SURFACE + UI_ON_SURFACE for n in pair})

    for theme in THEMES:
        for mode in MODES:
            page.evaluate("([t, m]) => { Epok.setTheme(t); Epok.setMode(m); }", [theme, mode])
            page.wait_for_timeout(60)
            # Resolved through a probe element, not read as a raw property: a
            # derived token's raw value is the unevaluated color-mix() text.
            vals = page.evaluate(
                "(names) => { const probe = document.createElement('i'); document.body.appendChild(probe);"
                " const raw = getComputedStyle(document.documentElement); const o = {};"
                " names.forEach(n => { if (!raw.getPropertyValue(n).trim()) { o[n] = ''; return; }"
                "   probe.style.backgroundColor = 'var(' + n + ')';"
                "   o[n] = getComputedStyle(probe).backgroundColor; });"
                " probe.remove(); return o; }",
                names)
            resolved = {}
            for n in names:
                raw = vals[n]
                check(bool(raw), f"{theme}/{mode}: token {n} is defined")
                if raw:
                    resolved[n] = parse_colour(raw)
            for fg, bg in TEXT_ON_SURFACE:
                if fg in resolved and bg in resolved:
                    r = contrast(resolved[fg], resolved[bg])
                    check(r >= 4.5, f"{theme}/{mode}: {fg} on {bg}", f"{r:.2f}:1, need 4.5")
            for fg, bg in UI_ON_SURFACE:
                if fg in resolved and bg in resolved:
                    r = contrast(resolved[fg], resolved[bg])
                    check(r >= 3.0, f"{theme}/{mode}: {fg} on {bg}", f"{r:.2f}:1, need 3.0")
    ctx.close()


def check_layout(browser) -> None:
    """A7: capped AND centred. A cap alone strands background on the right."""
    for width in WIDTHS:
        ctx, page, errs = new_page(browser, width=width, height=950)
        for view in VIEWS:
            page.click(f'.rail__item[data-view="{view}"]')
            page.wait_for_timeout(80)
            box = page.evaluate("""() => {
                const m = document.getElementById('main');
                const c = m.querySelector(':scope > *');
                const r = document.getElementById('rail');
                const ms = getComputedStyle(m);
                return { pad: parseFloat(ms.paddingLeft) + parseFloat(ms.paddingRight),
                         main: m.getBoundingClientRect().toJSON(),
                         content: c ? c.getBoundingClientRect().toJSON() : null,
                         rail: r.getBoundingClientRect().toJSON(),
                         scrollW: document.documentElement.scrollWidth,
                         clientW: document.documentElement.clientWidth };
            }""")
            check(box["content"] is not None, f"{width}px/{view}: content exists")
            if not box["content"]:
                continue
            check(box["scrollW"] <= box["clientW"] + 1,
                  f"{width}px/{view}: no horizontal scroll",
                  f"scrollWidth {box['scrollW']} > clientWidth {box['clientW']}")
            left_gap = box["content"]["x"] - box["main"]["x"]
            right_gap = (box["main"]["x"] + box["main"]["width"]) - \
                        (box["content"]["x"] + box["content"]["width"])
            check(abs(left_gap - right_gap) <= 2,
                  f"{width}px/{view}: content centred beside the rail",
                  f"left gap {left_gap:.0f}px, right gap {right_gap:.0f}px")
            # Centred is not enough: content that collapses to its own width is
            # still a canyon of background, just a symmetrical one.
            want = min(1120, box["main"]["width"] - box["pad"])
            check(abs(box["content"]["width"] - want) <= 1,
                  f"{width}px/{view}: content fills the cap, not just its own content",
                  f"content {box['content']['width']:.0f}px, cap {want:.0f}px")
        check(errs == [], f"{width}px: console errors", "; ".join(errs))
        ctx.close()


def check_period_starts(browser) -> None:
    """B3: the model's only input. A correction must not mint a second cycle."""
    ctx, page, errs = new_page(browser)
    # Relative to today, because an absolute date drifts into the future and
    # the future-start guard then refuses it — which is the guard working.
    d = lambda n: page.evaluate("(n) => Epok.shiftDay(Epok.today(), n)", n)
    A, B, C, D = d(-30), d(-2), d(-1), d(-12)

    page.evaluate("(k) => Epok.Store.setPeriodStart(k)", A)
    page.wait_for_timeout(80)
    check(page.evaluate("() => Epok.Store.cycles().length") == 1, "first period start recorded")
    check(page.locator(".undo").count() == 1, "period start offers an undo")

    page.evaluate("(k) => Epok.Store.setPeriodStart(k)", B)
    page.wait_for_timeout(80)
    cs = page.evaluate("() => Epok.Store.cycles()")
    check(len(cs) == 2, "second period start recorded", str(len(cs)))
    check(cs[0]["length"] == 28, "length derived from the gap, not typed", str(cs[0]["length"]))
    check(cs[1]["length"] is None, "the open cycle has no length yet", str(cs[1]["length"]))

    # One day later is a correction to the same start, not a 1-day cycle.
    pre = page.evaluate("(k) => Epok.Store.previewPeriodStart(k)", C)
    check(pre["from"] == B, "preview names the start it would move", str(pre))
    check(pre["to"] == C, "preview names the new start", str(pre))
    page.evaluate("(k) => Epok.Store.setPeriodStart(k)", C)
    page.wait_for_timeout(80)
    cs = page.evaluate("() => Epok.Store.cycles()")
    check(len(cs) == 2, "a start inside the merge window corrects, never adds", str(len(cs)))
    check(cs[1]["start"] == C, "the corrected start moved", str(cs[1]["start"]))
    check(cs[0]["length"] == 29, "the previous length re-derived after the correction",
          str(cs[0]["length"]))

    # Twelve days back is past the merge window from both: a genuinely new cycle.
    pre = page.evaluate("(k) => Epok.Store.previewPeriodStart(k)", D)
    check(pre["from"] is None, "preview: past the merge window is a new cycle", str(pre))

    # Undo restores the exact prior list.
    page.evaluate("(k) => Epok.Store.clearPeriodStart(k)", C)
    page.wait_for_timeout(80)
    check(page.evaluate("() => Epok.Store.cycles().length") == 1, "period start cleared")
    page.click(".undo button")
    page.wait_for_timeout(120)
    cs = page.evaluate("() => Epok.Store.cycles()")
    check(len(cs) == 2 and cs[1]["start"] == C,
          "undo restores the cleared period start", str(cs))

    page.evaluate("(k) => Epok.Store.setPeriodStart(k)", d(5))
    page.wait_for_timeout(80)
    check(page.evaluate("() => Epok.Store.cycles().length") == 2,
          "a future period start is refused")
    check(page.locator(".toast").count() >= 1, "the refusal says so inline, not in a dialog")

    # It has to survive a reload, or none of the above matters.
    page.wait_for_timeout(300)
    page.reload()
    page.wait_for_timeout(300)
    cs = page.evaluate("() => Epok.Store.cycles()")
    check(len(cs) == 2 and cs[0]["start"] == A and cs[1]["start"] == C,
          "cycles survive a reload", str(cs))
    check(errs == [], "period starts: console errors", "; ".join(errs))
    ctx.close()


def check_lock(browser) -> None:
    """B7/A3: a PIN that cannot be recovered, and a backup that is not optional."""
    ctx, page, errs = new_page(browser)
    check(page.evaluate("() => Epok.Lock.available"), "Web Crypto available on file://")

    # Log something real first, so the round trip is over data that matters.
    page.evaluate("() => { Epok.Store.setPeriodStart(Epok.shiftDay(Epok.today(), -20));"
                  " Epok.Store.editDay(Epok.today(), { flow: 'heavy', note: 'secret' }); }")
    page.wait_for_timeout(300)

    # A3: the backup download is part of enable(), not a suggestion beside it.
    with page.expect_download() as dl:
        res = page.evaluate("() => Epok.Lock.enable('123456')")
    download = dl.value
    check(res["ok"] is True, "enable() succeeded", str(res))
    check(download.suggested_filename.endswith(".encrypted.json"),
          "enable() downloaded an encrypted backup", download.suggested_filename)
    body = pathlib.Path(download.path()).read_text()
    check("secret" not in body, "the backup file contains no plaintext")
    check(json.loads(body)["enc"] == 1, "the backup file is a sealed envelope")

    raw = page.evaluate("() => localStorage.getItem('epok.state.v1')")
    check("secret" not in raw, "localStorage holds no plaintext once encryption is on")
    check(json.loads(raw)["enc"] == 1, "localStorage holds a sealed envelope")
    check(json.loads(raw)["iter"] >= 250000, "PBKDF2 iteration count is recorded in the envelope")

    prev = page.evaluate("() => localStorage.getItem('epok.state.prev')")
    check("secret" not in prev, "the write-through copy is sealed too")

    # A later save must stay sealed, or encryption quietly lapses after setup.
    page.evaluate("() => Epok.Store.editDay(Epok.today(), { note: 'second secret' })")
    page.wait_for_timeout(500)
    raw = page.evaluate("() => localStorage.getItem('epok.state.v1')")
    check("second secret" not in raw, "saves after setup are still sealed")
    check(json.loads(raw)["enc"] == 1, "saves after setup keep the envelope")

    for bad in ["12345", "1234567", "abcdef", ""]:
        r = page.evaluate("(p) => Epok.Lock.enable(p)", bad)
        check(r["ok"] is False, f"enable() refuses the PIN {bad!r}", str(r))
    check(errs == [], "lock setup: console errors", "; ".join(errs))
    ctx.close()

    # Reopening must show the lock screen and nothing else.
    ctx2, page2, errs2 = new_page(browser, seed={"epok.state.v1": raw})
    check(page2.locator(".lock").count() == 1, "a sealed state boots to the lock screen")
    check(page2.locator("#rail").is_hidden(), "the rail is not reachable while locked")
    check(page2.locator("#main section.card").count() == 1, "no view is mounted while locked")
    warn = page2.locator(".lock").inner_text().lower()
    check("no reset" in warn, "the lock screen says there is no reset")
    # Hiding the rail must not drop main into the rail's 220px grid track.
    lb = page2.evaluate("() => { const r = document.querySelector('.lock')"
                        ".getBoundingClientRect(); return { x: r.x, w: r.width,"
                        " vw: document.documentElement.clientWidth }; }")
    check(lb["w"] >= 400, "the lock card is not squeezed into the rail's column", str(lb))
    check(abs((lb["x"] + lb["w"] / 2) - lb["vw"] / 2) <= 2,
          "the lock card is centred in the viewport with the rail hidden", str(lb))

    page2.fill(".pin", "000000")
    page2.click(".lock .btn--accent")          # a real click on the real control
    page2.wait_for_timeout(1200)
    check(page2.locator(".lock").count() == 1, "a wrong PIN does not unlock")
    check("did not open" in page2.locator(".lock p[style]").inner_text().lower(),
          "a wrong PIN says so inline, not in a dialog")

    page2.fill(".pin", "123456")
    page2.click(".lock .btn--accent")
    page2.wait_for_timeout(1500)
    check(page2.locator(".lock").count() == 0, "the right PIN unlocks")
    check(page2.locator(".rail__item").count() == len(VIEWS), "the rail returns after unlocking")
    note = page2.evaluate("() => Epok.Store.day(Epok.today()).note")
    check(note == "second secret", "the decrypted log is the log that was sealed", repr(note))
    cyc = page2.evaluate("() => Epok.Store.cycles().length")
    # 2, not 1: the manual start 20 days back, plus the one flow-extracted from
    # today's log (20 days is past the merge window, so it is a real second
    # period, not a correction to the first).
    check(cyc == 2, "cycles survive the round trip", str(cyc))

    # Disabling returns plaintext, and only with the right PIN.
    r = page2.evaluate("() => Epok.Lock.disable('999999')")
    check(r["ok"] is False, "disable() refuses a wrong PIN", str(r))
    check(page2.evaluate("() => Epok.Lock.isEnabled()"), "a refused disable leaves it enabled")
    r = page2.evaluate("() => Epok.Lock.disable('123456')")
    page2.wait_for_timeout(400)
    check(r["ok"] is True, "disable() accepts the right PIN", str(r))
    check(page2.evaluate("() => !Epok.Lock.isEnabled()"), "encryption is off after disable()")
    raw2 = page2.evaluate("() => localStorage.getItem('epok.state.v1')")
    check("second secret" in raw2, "the log is readable again after disable()")
    check(errs2 == [], "lock round trip: console errors", "; ".join(errs2))
    ctx2.close()


def check_portability(browser) -> None:
    """B8: the log is the user's and must come back out, and back in."""
    ctx, page, errs = new_page(browser)
    page.evaluate("""() => {
        Epok.Store.setPeriodStart(Epok.shiftDay(Epok.today(), -30));
        Epok.Store.setPeriodStart(Epok.shiftDay(Epok.today(), -2));
        Epok.Store.editDay(Epok.shiftDay(Epok.today(), -2),
            { flow: 'heavy', tags: ['cramps', 'low-mood'], bbt: 36.42, note: 'a, "quoted" note' });
        Epok.Store.editDay(Epok.today(), { flow: 'light', lh: 'positive', pill: 'taken' });
    }""")
    page.wait_for_timeout(350)

    csv = page.evaluate("() => Epok.Store.exportCSV().text()")
    lines = [l for l in csv.lstrip("\ufeff").strip().split("\n") if l]
    check(lines[0] == "date,cycle_day,period_start,flow,tags,bbt_c,lh,pill,note",
          "CSV header", lines[0])
    check(len(lines) >= 4, "CSV has a row per logged day", str(len(lines)))
    parsed = list(csv_mod.reader(io.StringIO(csv.lstrip("\ufeff"))))
    check(all(len(r) == 9 for r in parsed if r),
          "CSV still parses with a quoted comma in a note",
          str([len(r) for r in parsed]))
    body = {r[0]: r for r in parsed[1:]}
    start = page.evaluate("() => Epok.shiftDay(Epok.today(), -2)")
    check(body[start][2] == "yes", "CSV marks the period start", str(body[start]))
    check(body[start][1] == "1", "CSV carries the cycle day", str(body[start]))
    check(body[start][4] == "cramps;low-mood", "CSV joins tags", str(body[start]))
    check('a, "quoted" note' == body[start][8], "CSV round-trips a quoted note", body[start][8])
    # Blob.text() decodes and strips the BOM, so the bytes are what to check.
    bom = page.evaluate("() => Epok.Store.exportCSV().arrayBuffer()"
                        ".then(b => Array.from(new Uint8Array(b).slice(0, 3)))")
    check(bom == [0xEF, 0xBB, 0xBF], "CSV carries a UTF-8 BOM so Excel reads notes correctly",
          str(bom))

    blob = page.evaluate("() => Epok.Store.exportJSON().text()")
    check(json.loads(blob)["v"] == page.evaluate("() => Epok.SCHEMA_VERSION"),
          "JSON export is the state at the current schema version, unencrypted with no PIN")
    check("quoted" in blob, "JSON export carries the notes")

    # Import replaces, tells you what it replaced, and is undoable.
    page.evaluate("() => Epok.Store.editDay(Epok.today(), { note: 'after export' })")
    page.wait_for_timeout(300)
    r = page.evaluate("(t) => Epok.Store.importJSON(t)", blob)
    page.wait_for_timeout(200)
    check(r["ok"] is True, "importJSON accepts its own export", str(r))
    check(page.evaluate("() => Epok.Store.day(Epok.today()).note") == "",
          "import replaced the newer state")
    check(page.locator(".undo").count() == 1, "import offers an undo")
    check("replaced" in page.locator(".undo__label").inner_text(),
          "the undo says the previous log was replaced")
    page.click(".undo button")
    page.wait_for_timeout(200)
    check(page.evaluate("() => Epok.Store.day(Epok.today()).note") == "after export",
          "undo restores the log the import replaced")

    for bad, label in [("", "an empty file"), ("not json", "a non-JSON file"),
                       ('{"v": 99}', "a state from a newer schema")]:
        r = page.evaluate("(t) => Epok.Store.importJSON(t)", bad)
        check(r["ok"] is False, f"importJSON refuses {label}", str(r))
        check(bool(r["error"]), f"importJSON says why it refused {label}", str(r))
    check(errs == [], "portability: console errors", "; ".join(errs))

    # With the PIN on, the export must not be a way around the lock.
    with page.expect_download():
        page.evaluate("() => Epok.Lock.enable('123456')")
    page.wait_for_timeout(400)
    page.evaluate("() => Epok.Store.flush()")
    page.wait_for_timeout(400)
    sealed = page.evaluate("() => Epok.Store.exportJSON().text()")
    check(json.loads(sealed)["enc"] == 1, "JSON export is sealed when the PIN is on")
    check("quoted" not in sealed, "the sealed export contains no plaintext")
    plain = page.evaluate("() => Epok.Store.exportCSV().text()")
    check("quoted" in plain, "CSV export is plaintext even with the PIN on, as documented")
    r = page.evaluate("(t) => Epok.Store.importJSON(t)", sealed)
    check(r["ok"] is False and "encrypted" in r["error"],
          "importJSON refuses a sealed file and says why", str(r))
    ctx.close()


def check_offline(browser) -> None:
    """B14/B15: offline forever where the scheme allows it, and honest where it does not."""
    # file:// — reminders cannot work, and the app must say so rather than
    # leave a switch that quietly does nothing.
    seed = dict(SEEDED_STATE)
    seed = json.loads(json.dumps(SEEDED_STATE))
    seed["profile"]["remindersOn"] = True
    ctx, page, errs = new_page(browser, seed={"epok.state.v1": json.dumps(seed)})
    b = page.locator('[data-banner="reminders"]')
    check(b.count() == 1, "file://: reminders-unavailable banner is shown")
    text = b.inner_text() if b.count() else ""
    check("./serve.sh" in text, "file://: the banner names the command", text[:120])
    check("localhost:8731" in text, "file://: the banner names the URL", text[:120])
    check(page.evaluate("() => Epok.Reminders.available().ok") is False,
          "file://: available() reports false")
    check(page.evaluate("() => Epok.Reminders.swSupported()") is False,
          "file://: service worker reported unsupported")
    check(errs == [], "file:// reminders: console errors", "; ".join(errs))
    ctx.close()

    # And with reminders off, no banner: nagging is not honesty.
    ctx, page, errs = new_page(browser)
    check(page.locator('[data-banner="reminders"]').count() == 0,
          "file://: no banner when reminders were never switched on")
    ctx.close()

    # http:// — the service worker must precache the shell and survive offline.
    root = pathlib.Path(__file__).resolve().parent.parent

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):        # the request log drowns the results
            pass

    handler = functools.partial(Quiet, directory=str(root))
    srv = socketserver.TCPServer(("127.0.0.1", 0), handler)
    srv.allow_reuse_address = True
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        ctx = browser.new_context(viewport={"width": 1440, "height": 950})
        page = ctx.new_page()
        errs2: list[str] = []
        page.on("pageerror", lambda e: errs2.append(f"PAGEERROR: {e}"))
        page.on("console", lambda m: m.type == "error" and errs2.append(f"CONSOLE: {m.text}"))
        page.goto(f"http://127.0.0.1:{port}/")
        page.wait_for_timeout(300)
        check(page.evaluate("() => Epok.Reminders.swSupported()") is True,
              "http://: service worker reported supported")

        state = page.wait_for_function(
            "() => navigator.serviceWorker.controller ? 'controlled' : null", timeout=15000)
        check(state is not None, "http://: the service worker took control")

        for icon in ["icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"]:
            ok = page.evaluate("(u) => fetch(u).then(r => r.ok).catch(() => false)", icon)
            check(ok is True, f"manifest icon resolves: {icon}")

        # The whole point: kill the network and it still opens.
        ctx.set_offline(True)
        page.reload()
        page.wait_for_timeout(600)
        check(page.locator(".rail__item").count() == len(VIEWS),
              "offline: the app still boots with every view")
        page.click('.rail__item[data-view="insights"]')
        page.wait_for_timeout(120)
        check(page.evaluate("() => Epok.activeView()") == "insights",
              "offline: navigation still works")
        check(page.evaluate("() => typeof Epok.Store.cycles === 'function'"),
              "offline: the scripts came from the cache, not the network")
        check(errs2 == [], "offline: console errors", "; ".join(errs2))
        ctx.set_offline(False)
        ctx.close()
    finally:
        srv.shutdown()
        srv.server_close()


def check_reminders(browser) -> None:
    """B16/B17: nothing switched on silently, nothing silently not firing."""
    # v1 -> v2 migration, on a profile that already had remindersOn true.
    v1 = json.loads(json.dumps(SEEDED_STATE))
    v1["v"] = 1
    v1["profile"]["remindersOn"] = True
    ctx, page, errs = new_page(browser, seed={"epok.state.v1": json.dumps(v1)})
    st = page.evaluate("() => Epok.Store.get()")
    check(st["v"] == page.evaluate("() => Epok.SCHEMA_VERSION"), "v1 state migrates through to the current schema", str(st["v"]))
    r = st["profile"]["reminders"]
    check(r == {"predictedStart": False, "pms": False, "pill": False, "pillTime": "21:00"},
          "v2 adds every reminder switched OFF, even with remindersOn already true", str(r))
    check(st["days"]["2026-09-14"]["note"] == "seeded", "the migration lost no logged day")
    check(errs == [], "migration v1->v2: console errors", "; ".join(errs))

    # Quiet hours, including the span that runs over midnight.
    q = page.evaluate("""() => {
        Epok.Store.setProfile({ quietHours: [22, 8] });
        const at = (h) => { const d = new Date(2026, 8, 15, h, 0, 0); return d; };
        return { q23: Epok.Reminders.inQuiet(23), q3: Epok.Reminders.inQuiet(3),
                 q9: Epok.Reminders.inQuiet(9), q21: Epok.Reminders.inQuiet(21),
                 moved23: Epok.Reminders.outOfQuiet(at(23)).getHours(),
                 moved23day: Epok.Reminders.outOfQuiet(at(23)).getDate(),
                 moved3: Epok.Reminders.outOfQuiet(at(3)).getHours(),
                 moved3day: Epok.Reminders.outOfQuiet(at(3)).getDate(),
                 kept: Epok.Reminders.outOfQuiet(at(18)).getHours() };
    }""")
    check(q["q23"] and q["q3"] and not q["q9"] and not q["q21"],
          "quiet hours wrap over midnight", str(q))
    check(q["moved23"] == 8 and q["moved23day"] == 16,
          "a 23:00 reminder moves to 08:00 the next morning", str(q))
    check(q["moved3"] == 8 and q["moved3day"] == 15,
          "a 03:00 reminder moves to 08:00 the same morning", str(q))
    check(q["kept"] == 18, "a reminder outside quiet hours is left alone", str(q))
    ctx.close()

    # The contraception table, and the pill reminder it drives.
    ctx, page, errs = new_page(browser)
    ids = page.evaluate("() => Epok.Contraception.METHODS.map(m => m.id)")
    check(ids == page.evaluate("() => Epok.Store.CONTRACEPTION"),
          "every method in the schema vocabulary has a table row, in order", str(ids))
    pop = page.evaluate("() => Epok.Contraception.BY_ID['pop']")
    check(pop["windowHours"] == 3, "POP carries its 3-hour window", str(pop["windowHours"]))
    comb = page.evaluate("() => Epok.Contraception.BY_ID['combined-21-7']")
    check(comb["windowHours"] > pop["windowHours"],
          "a combined pill has a wider window than POP, so its reminder is not as sharp")
    check(page.evaluate("() => Epok.Contraception.BY_ID['iud'].needsExpiry") is True,
          "IUD is an expiry date and nothing else")
    check(page.evaluate("() => Epok.Contraception.BY_ID['iud'].logs") is None,
          "IUD has nothing to log day to day")

    # No missed-dose medical guidance anywhere in the table. PLAN B17.
    table = (pathlib.Path(__file__).resolve().parent.parent / "js/contraception.data.js").read_text()
    for banned in ["take two", "double up", "use a condom", "emergency contraception",
                   "you should take", "seek advice", "consult a doctor"]:
        check(banned not in table.lower(), f"the table gives no missed-dose guidance: {banned!r}")
    check("does not say what a missed dose means" in
          page.evaluate("() => Epok.Contraception.NO_GUIDANCE"),
          "NO_GUIDANCE states the limit in plain words")

    # Suggestions carry their reasoning; status() names what is blocking.
    page.evaluate("""() => {
        Epok.Store.setProfile({ contraception: 'pop', remindersOn: true });
        Epok.Store.get().profile.reminders.pill = true;
        Epok.Store.get().profile.reminders.predictedStart = true;
    }""")
    sg = page.evaluate("() => Epok.Reminders.suggestions()")
    check([x["id"] for x in sg] == ["predictedStart", "pms", "pill"],
          "a pill method adds the pill suggestion", str([x["id"] for x in sg]))
    check(all(x["reason"] for x in sg), "every suggestion carries its reasoning")
    pill_reason = [x for x in sg if x["id"] == "pill"][0]["reason"]
    check("3-hour window" in pill_reason and "sharper" in pill_reason,
          "the POP suggestion says why it is sharper", pill_reason)

    stat = {x["id"]: x for x in page.evaluate("() => Epok.Reminders.status()")}
    check(stat["predictedStart"]["on"] is True, "status reports what is on")
    check(stat["predictedStart"]["blocked"], "status names what is blocking a reminder that is on",
          str(stat["predictedStart"]))
    check(stat["pms"]["on"] is False and stat["pms"]["blocked"] is None,
          "an unticked reminder is not reported as blocked", str(stat["pms"]))

    # due() is derived from logged data, so logging clears it.
    page.evaluate("""() => { Epok.Store.get().profile.reminders.pillTime = '00:01'; }""")
    ids = [d["id"] for d in page.evaluate("() => Epok.Reminders.due()")]
    check("pill" in ids, "an unlogged pill past its time is due", str(ids))
    page.evaluate("() => Epok.Store.editDay(Epok.today(), { pill: 'taken' })")
    page.wait_for_timeout(120)
    ids = [d["id"] for d in page.evaluate("() => Epok.Reminders.due()")]
    check("pill" not in ids, "logging the pill clears it, with no acknowledgement to track", str(ids))
    check(errs == [], "reminders: console errors", "; ".join(errs))
    ctx.close()


def check_shell(browser) -> None:
    """B15/B18: a file missing from the precache list is a view that is blank
    offline, and a file missing from the deploy is one that 404s in public."""
    root = pathlib.Path(__file__).resolve().parent.parent
    html = (root / "index.html").read_text()

    referenced = set(re.findall(r'(?:src|href)="([^":]+?)"', html))
    referenced = {r for r in referenced if not r.startswith("#")}
    for r in sorted(referenced):
        check((root / r).exists(), f"index.html references a file that exists: {r}")

    sw = (root / "service-worker.js").read_text()
    shell_block = sw[sw.index("var SHELL = ["):sw.index("];", sw.index("var SHELL = ["))]
    shell = set(re.findall(r'"([^"]+)"', shell_block))

    missing = sorted(referenced - shell)
    check(not missing, "every file index.html loads is precached by the service worker",
          ", ".join(missing))
    for entry in sorted(shell - {"./"}):
        check((root / entry).exists(), f"service worker precaches a file that exists: {entry}")

    manifest = json.loads((root / "manifest.webmanifest").read_text())
    for icon in manifest["icons"]:
        check((root / icon["src"]).exists(), f"manifest icon exists: {icon['src']}")
        check(icon["src"] in shell, f"manifest icon is precached: {icon['src']}")

    # The deploy copy ships exactly the shell and nothing else.
    dep = root / "deploy" / "public"
    if dep.exists():
        shipped = {str(p.relative_to(dep)) for p in dep.rglob("*") if p.is_file()}
        for entry in sorted(shell - {"./"}):
            check(entry in shipped, f"deploy ships a precached file: {entry}")
        for stray in ["PLAN-epok.md", "CONTRACTS.md", "STATUS.md", "serve.sh", "deploy.sh"]:
            check(stray not in shipped, f"deploy does not ship {stray}")
        check(not any(s.startswith("tools/") for s in shipped), "deploy does not ship tools/")
        for name in sorted(shipped):
            same = (dep / name).read_bytes() == (root / name).read_bytes()
            check(same, f"deploy copy is byte-identical: {name}")
    else:
        check(False, "deploy/public exists (run ./deploy.sh)")


def check_custom_tags(browser) -> None:
    """Custom tags: ids stable, and removal never orphans a logged day."""
    ctx, page, errs = new_page(browser)
    add = lambda label, cat: page.evaluate("([l, c]) => Epok.Store.addCustomTag(l, c)", [label, cat])
    rm = lambda i: page.evaluate("(i) => Epok.Store.removeCustomTag(i)", i)
    tags = lambda: page.evaluate("() => Epok.Store.get().customTags")

    r = add("  pelvic   physio ", "pain")
    page.wait_for_timeout(80)
    check(r["ok"] and r["id"] == "custom-pelvic-physio", "add returns a slug id", str(r))
    check(tags() == [{"id": "custom-pelvic-physio", "label": "PELVIC PHYSIO", "category": "pain"}],
          "label trimmed, collapsed, uppercased", str(tags()))
    check(any(t["id"] == "custom-pelvic-physio" for t in
              page.evaluate("() => Epok.Tags.byCategory('pain')")), "Epok.Tags.byCategory sees it")
    check(page.locator(".undo").count() == 1, "add offers an undo")

    check(not add("Pelvic Physio", "pain")["ok"], "a duplicate label in one category is refused")
    check(not add("cramps", "pain")["ok"], "a label shadowing a built-in is refused")
    check(not add("", "pain")["ok"], "an empty label is refused")
    check(not add("x" * 25, "pain")["ok"], "an over-long label is refused")
    check(not add("physio", "nonsense")["ok"], "an unknown category is refused")
    r2 = add("Pelvic Physio", "activity")
    check(r2["ok"] and r2["id"] == "custom-pelvic-physio-2",
          "same label in another category gets a distinct id", str(r2))
    check(len(tags()) == 2, "refusals wrote nothing", str(tags()))

    # A tag on a logged day cannot be removed; its id would name nothing.
    page.evaluate("() => Epok.Store.editDay(Epok.today(), { tags: ['custom-pelvic-physio'] })")
    r = rm("custom-pelvic-physio")
    check(not r["ok"] and "1 logged day" in (r["error"] or ""), "removal refused while a day carries it", str(r))
    check(len(tags()) == 2, "refused removal wrote nothing")

    page.evaluate("() => Epok.Store.editDay(Epok.today(), { tags: [] })")
    r = rm("custom-pelvic-physio")
    page.wait_for_timeout(80)
    check(r["ok"] and len(tags()) == 1, "removal allowed once no day carries it", str(r))
    page.click(".undo button")
    page.wait_for_timeout(120)
    check([t["id"] for t in tags()] == ["custom-pelvic-physio", "custom-pelvic-physio-2"],
          "undo restores the removed tag in place", str(tags()))

    page.wait_for_timeout(300)
    page.reload()
    page.wait_for_timeout(300)
    check(len(tags()) == 2, "custom tags survive a reload", str(tags()))
    check(errs == [], "custom tags: console errors", "; ".join(errs))
    ctx.close()


def check_completion(browser) -> None:
    """Pill log, due list, stale notifications, past periods, sample sizes."""
    # A pill method with its reminder on and its time already passed today.
    seed = json.loads(json.dumps(SEEDED_STATE))
    seed["v"] = 2
    seed["profile"].update({"contraception": "pop", "remindersOn": True,
                            "reminders": {"predictedStart": False, "pms": False, "pill": True, "pillTime": "00:00"}})
    ctx, page, errs = new_page(browser, seed={"epok.state.v1": json.dumps(seed)})
    page.click('.rail__item[data-view="today"]')
    page.wait_for_timeout(150)
    main = page.locator("#main")
    check("Today's pill is not logged." in main.inner_text(), "due list shows the unlogged pill")
    check(main.locator("button.chip", has_text="PLACEBO").count() == 0,
          "POP offers no PLACEBO (read off the method table)")
    main.locator("button.chip", has_text="MISSED").click()
    page.wait_for_timeout(150)
    check(page.evaluate("() => Epok.Store.day(Epok.today()).pill") == "missed", "MISSED chip writes day.pill")
    check("does not say what a missed dose means" in main.inner_text(), "MISSED shows NO_GUIDANCE, not advice")
    main.locator("button.chip", has_text="TAKEN").click()
    page.wait_for_timeout(150)
    check("Today's pill is not logged." not in main.inner_text(), "logging the pill clears the due list")
    check(page.evaluate("() => Epok.Reminders._stillDue({ id: 'pill' })") is False,
          "a pill timer armed earlier is no longer due once logged")
    check(errs == [], "completion/pill: console errors", "; ".join(errs))
    ctx.close()

    # The timer is armed at 12:00 for 12:30; the pill is logged in between.
    # Before the fire-time re-check this notified anyway.
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    root = pathlib.Path(__file__).resolve().parent.parent
    srv = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(root)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        for log_it, want in ((True, 0), (False, 1)):
            seed["profile"]["reminders"]["pillTime"] = "12:30"
            ctx = browser.new_context()
            ctx.grant_permissions(["notifications"], origin=origin)
            page = ctx.new_page()
            page.clock.install(time=__import__("datetime").datetime.now().replace(hour=12, minute=0, second=0))
            page.add_init_script(
                "localStorage.setItem('epok.state.v1', " + json.dumps(json.dumps(seed)) + ");"
                "window.__fired = []; window.Notification = class { constructor(t, o) { window.__fired.push(o.body); } };"
                "window.Notification.permission = 'granted';")
            page.goto(origin + "/index.html")
            page.wait_for_timeout(400)
            if log_it:
                page.locator("#main button.chip", has_text="TAKEN").click()
                page.wait_for_timeout(150)
            page.clock.run_for(45 * 60 * 1000)
            page.wait_for_timeout(150)
            fired = page.evaluate("() => window.__fired.length")
            check(fired == want, "pill logged before its time: no notification" if log_it
                  else "pill not logged: the notification still fires", str(fired))
            ctx.close()
    finally:
        srv.shutdown()

    # Past periods, by real fill and click.
    ctx, page, errs = new_page(browser)
    page.click('.rail__item[data-view="settings"]')
    page.wait_for_timeout(150)
    d = lambda n: page.evaluate("(n) => Epok.shiftDay(Epok.today(), n)", n)
    for back in (-60, -31, -2):
        page.fill('input[aria-label="Past period start date"]', d(back))
        page.wait_for_timeout(120)
        check("Begins a new cycle" in page.locator("#main").inner_text(), f"past period {back}: consequence before commit")
        page.click("button:has-text('ADD PERIOD START')")
        page.wait_for_timeout(120)
    check(page.evaluate("() => Epok.Store.cycles().map(c => c.start)") == [d(-60), d(-31), d(-2)],
          "three past periods recorded in order")
    page.fill('input[aria-label="Past period start date"]', d(-3))
    page.wait_for_timeout(120)
    check("Corrects the existing start" in page.locator("#main").inner_text(),
          "a date inside the merge window is shown as a correction")
    page.fill('input[aria-label="Past period start date"]', d(3))
    page.wait_for_timeout(120)
    page.click("button:has-text('ADD PERIOD START')")
    page.wait_for_timeout(120)
    check(len(page.evaluate("() => Epok.Store.cycles()")) == 3, "a future date is refused from the form too")
    check(errs == [], "completion/past periods: console errors", "; ".join(errs))
    ctx.close()

    # Every error figure carries its own sample; plain averages carry no ESTIMATE.
    seed = json.loads(json.dumps(SEEDED_STATE))
    ctx, page, errs = new_page(browser, seed={"epok.state.v1": json.dumps(seed)})
    page.evaluate("""() => { for (let i = 8; i >= 0; i--) {
        const k = Epok.shiftDay(Epok.today(), -28 * i - 3 - (i % 3));
        Epok.Store.setPeriodStart(k); Epok.Store.editDay(k, { flow: 'medium' }); } }""")
    page.click('.rail__item[data-view="insights"]')
    page.wait_for_timeout(200)
    tiles = page.locator(".stat-tile")
    check(tiles.locator(".est").count() == 0, "no ESTIMATE tag on arithmetic-on-the-log tiles")
    txt = page.locator("#main").inner_text()
    check(re.search(r"MEDIAN OVER \d+ PAST PREDICTION", txt) is not None, "measured error prints its sample", txt[:200])
    check("COMPLETE CYCLE" in txt, "averages print how many cycles they came from")
    page.click('.rail__item[data-view="today"]')
    page.wait_for_timeout(200)
    check(re.search(r"FIT ON \d+ CYCLES · ±\d+(\.\d+)?D MEASURED ERROR OVER \d+ PAST PREDICTION",
                    page.locator("#main").inner_text()) is not None,
          "Today: fit size and error sample printed separately")
    page.click('.rail__item[data-view="report"]')
    page.wait_for_timeout(200)
    check(re.search(r"median ±\d+(\.\d+)?d over \d+ past prediction", page.locator("#main").inner_text()) is not None,
          "Report: prediction error prints its sample")
    check(errs == [], "completion/samples: console errors", "; ".join(errs))
    ctx.close()


CAL_SEED_JS = """() => {
  const d = n => Epok.shiftDay(Epok.today(), n);
  const lv = ['heavy', 'heavy', 'medium', 'light', 'spotting'];
  [-170, -141, -112, -83, -52, -20].forEach(s => lv.forEach((f, i) => Epok.Store.editDay(d(s + i), { flow: f })));
  // Chart one finished cycle: baseline 36.30 then a held rise, so it confirms.
  for (let i = 5; i < 25; i++) Epok.Store.editDay(d(-52 + i), { bbt: i < 15 ? 36.30 : 36.62 });
  Epok.Store.editDay(d(-5), { tags: ['headache'] });
  document.querySelectorAll('.undo').forEach(n => n.remove());
}"""


def check_calendar(browser) -> None:
    """PLAN-calendar.md: markers inside cells, history drawn, tap selects without re-dating."""
    ctx, page, errs = new_page(browser, width=1920, height=1080)
    page.evaluate(CAL_SEED_JS)
    page.click('.rail__item[data-view="calendar"]')
    page.wait_for_timeout(200)

    model = page.evaluate("""() => { const s = Epok.Store.get(), c = Epok.Store.cycles();
        const o = { conditions: s.profile.conditions, ageBand: s.profile.ageBand, days: s.days };
        const p = Epok.Model.predict(c, Object.assign({ noMae: true }, o));
        const h = Epok.Model.history(c, o);
        return { window: p.window, today: Epok.today(), history: h }; }""")
    want = page.evaluate("""([a, b]) => { const out = []; let k = a;
        while (Epok.daysBetween(k, b) >= 0) { out.push(k); k = Epok.shiftDay(k, 1); } return out; }""", model["window"])

    # A1: the drawn window is exactly the model's, across both months it can span.
    drawn = set()
    for _ in range(2):
        drawn |= set(page.eval_on_selector_all(".cal-day.is-predicted", "els => els.map(e => e.dataset.date)"))
        page.click(".cal-nav button:has-text('NEXT')")
        page.wait_for_timeout(120)
    check(sorted(drawn) == want, "calendar: predicted cells equal predict().window exactly",
          f"drawn {sorted(drawn)} want {want}")
    page.click(".cal-nav button:has-text('TODAY')")
    page.wait_for_timeout(120)
    edge = page.evaluate("""() => { const el = document.querySelector('.cal-day.is-predicted');
        if (!el) return null; const a = getComputedStyle(el, '::after');
        return [a.top, a.left, a.bottom, a.right].map(parseFloat); }""")
    check(edge is not None and min(edge) >= 2, "calendar: the window outline is inset, not on the cell edge", str(edge))
    check(page.locator(".cal-day__band").count() == 0, "calendar: no edge-anchored strips remain")
    count = page.eval_on_selector(".cal-grid", "g => g.children.length")
    check(count % 7 == 0, "calendar: the last week is closed with empty cells", str(count))

    # A7: every day speaks.
    labels = page.eval_on_selector_all(".cal-day:not(.is-empty)", "els => els.map(e => e.getAttribute('aria-label') || '')")
    check(labels and all(len(l) > 10 for l in labels), "calendar: every day has an aria-label", str(labels[:2]))

    # A5: a tap selects; it does not move the logging date.
    past = page.evaluate("() => Epok.shiftDay(Epok.today(), -5)")   # the seeded headache day
    if past[:7] != model["today"][:7]:
        page.click(".cal-nav button:has-text('PREV')")
        page.wait_for_timeout(120)
    page.click(f'.cal-day[data-date="{past}"]')
    page.wait_for_timeout(150)
    check(page.evaluate("() => Epok.viewDate()") == model["today"], "calendar: a tap does not change the logging date")
    check(page.get_attribute(f'.cal-day[data-date="{past}"]', "aria-pressed") == "true", "calendar: the tapped day is selected")
    head = page.locator(".cal-detail h2").inner_text()
    check(head.endswith(page.evaluate("(k) => Epok.prettyDate(k).toUpperCase()", past)), "calendar: the panel shows the tapped day", head)
    check("TAGS" in page.locator(".cal-detail").inner_text(), "calendar: the panel lists what was logged")
    page.click(".cal-detail button:has-text('LOG THIS DAY')")
    page.wait_for_timeout(150)
    check(page.evaluate("() => [location.hash, Epok.viewDate()]") == ["#today", past],
          "calendar: LOG THIS DAY hands off to Today on that date")
    page.evaluate("() => Epok.setViewDate(null)")

    # A2: a finished cycle carries its ovulation; the charted one is confirmed.
    page.click('.rail__item[data-view="calendar"]')
    page.wait_for_timeout(150)
    # The seed charts BBT only. One indirect signal is DETECTED, never confirmed
    # (REVIEW-algorithm-2026-10-03 finding 2), so it must draw as an estimate.
    charted = [h for h in model["history"] if h["ovulation"]["source"] == "bbt"]
    check(len(charted) == 1, "calendar: exactly the charted cycle is detected from BBT", str(len(charted)))
    check(not any(h["confirmed"] for h in model["history"]),
          "calendar: a single signal is never called confirmed")
    if charted:
        ov = charted[0]["ovulation"]["date"]
        page.click(".cal-nav button:has-text('TODAY')")
        while page.locator(f'.cal-day[data-date="{ov}"]').count() == 0:
            page.click(".cal-nav button:has-text('PREV')")
            page.wait_for_timeout(80)
        cell = page.locator(f'.cal-day[data-date="{ov}"] .cal-day__ov')
        check(cell.count() == 1 and "is-estimated" in (cell.get_attribute("class") or ""),
              "calendar: a BBT-only ovulation renders as an estimate, not confirmed", ov)
        check(page.locator(".cal-day--peak, .cal-day--fertile").count() > 0, "calendar: a past month shows its fertile days")
        legend = page.locator(".cal-legend").inner_text()
        check("DASHED = ESTIMATE" in legend and "CONFIRMED" not in legend,
              "calendar: the legend names what the month draws — an estimate, with no confirmed ovulation in it", legend)

    # A6: past the forecast, the legend drops the window and says why.
    page.click(".cal-nav button:has-text('TODAY')")
    for _ in range(2):
        page.click(".cal-nav button:has-text('NEXT')")
    page.wait_for_timeout(120)
    foot = page.locator(".cal-foot").inner_text()
    check("PREDICTED" not in foot and "one cycle ahead" in foot, "calendar: a month past the forecast says so", foot)

    # Layout: grid and panel side by side at 1920, filling the cap.
    box = page.evaluate("""() => { const l = document.querySelector('.cal-layout').getBoundingClientRect();
        const c = document.querySelector('.cal-card').getBoundingClientRect();
        const d = document.querySelector('.cal-detail').getBoundingClientRect();
        return { w: l.width, cardRight: c.right, detailLeft: d.left }; }""")
    check(abs(box["w"] - 1120) <= 1 and box["detailLeft"] > box["cardRight"],
          "calendar: 1920 — grid and panel side by side at the 1120px cap", str(box))

    # Every palette and mode renders the view without an error.
    for theme in THEMES:
        for mode in MODES:
            page.evaluate("([t, m]) => { Epok.setTheme(t); Epok.setMode(m); Epok.show('calendar'); }", [theme, mode])
    check(errs == [], "calendar: console errors", "; ".join(errs))
    ctx.close()

    # Phone: stacked, no sideways scroll.
    ctx, page, errs = new_page(browser, width=400, height=860)
    page.evaluate(CAL_SEED_JS)
    page.click('.rail__item[data-view="calendar"]')
    page.wait_for_timeout(200)
    m = page.evaluate("""() => ({ over: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        stacked: document.querySelector('.cal-detail').getBoundingClientRect().top >
                 document.querySelector('.cal-card').getBoundingClientRect().bottom })""")
    check(not m["over"] and m["stacked"], "calendar: 400 — panel below the grid, no horizontal scroll", str(m))
    check(errs == [], "calendar 400: console errors", "; ".join(errs))
    ctx.close()

    # Below the floor, and with fertility switched off: say why, draw nothing.
    ctx, page, errs = new_page(browser)
    page.evaluate("() => { const d = n => Epok.shiftDay(Epok.today(), n); Epok.Store.setPeriodStart(d(-28)); Epok.Store.setPeriodStart(d(0)); }")
    page.click('.rail__item[data-view="calendar"]')
    page.wait_for_timeout(150)
    check("3" in page.locator(".cal-foot").inner_text() and page.locator(".cal-day.is-predicted").count() == 0,
          "calendar: below 3 cycles the footer gives the model's reason")
    page.evaluate("() => { Epok.Store.setProfile({ fertilityVisible: false }); Epok.show('calendar'); }")
    page.wait_for_timeout(150)
    check(page.locator(".cal-day__ov, .cal-day--fertile, .cal-day--peak").count() == 0 and
          "SHOW FERTILITY ESTIMATES" in page.locator(".cal-foot").inner_text(),
          "calendar: fertility off hides the estimates and says where to turn them on")
    check(errs == [], "calendar sparse: console errors", "; ".join(errs))
    ctx.close()


def check_review(browser) -> None:
    """REVIEW-algorithm-2026-10-03 findings 4, 5, 6 and 10, plus the v3 migration.
    Each one is a repro from the review, driven through the real controls where
    the control exists."""
    ctx, page, errs = new_page(browser)
    d = lambda n: page.evaluate("(n) => Epok.shiftDay(Epok.today(), n)", n)
    flow_chip = lambda name: page.get_by_role("button", name=name, exact=True)
    cyc = lambda: page.evaluate("() => Epok.Store.cycles().map(c => [c.start, c.source])")

    # 4a. One SPOTTING tap is not a period, and clearing it leaves nothing behind.
    page.click('.rail__item[data-view="today"]')
    flow_chip("SPOTTING").click(); page.wait_for_timeout(120)
    check(cyc() == [], "spotting alone does not create a cycle", str(cyc()))

    # 4b. Real bleeding does, marked as inferred, and clearing it removes it again.
    flow_chip("LIGHT").click(); page.wait_for_timeout(120)
    t = d(0)
    check(cyc() == [[t, "flow"]], "a flow tap infers a start, marked source=flow", str(cyc()))
    flow_chip("LIGHT").click(); page.wait_for_timeout(120)
    check(cyc() == [], "clearing the only flow day removes the start it justified", str(cyc()))
    ctx.close()

    # 4c. Backfilling the day before moves the inferred start; 4d. a manual start is never moved.
    ctx, page, errs = new_page(browser)
    d = lambda n: page.evaluate("(n) => Epok.shiftDay(Epok.today(), n)", n)
    cyc = lambda: page.evaluate("() => Epok.Store.cycles().map(c => [c.start, c.source])")
    page.evaluate("(k) => Epok.Store.editDay(k, { flow: 'medium' })", d(-3))
    page.evaluate("(k) => Epok.Store.editDay(k, { flow: 'medium' })", d(-4))
    check(cyc() == [[d(-4), "flow"]], "backfilling the day before moves the inferred start to it", str(cyc()))
    page.evaluate("(k) => Epok.Store.setPeriodStart(k)", d(-40))
    page.evaluate("(k) => Epok.Store.editDay(k, { flow: 'heavy' })", d(-41))
    check([c for c in cyc() if c[1] == "manual"] == [[d(-40), "manual"]],
          "a start marked by hand is not moved by an earlier flow day", str(cyc()))
    page.evaluate("(k) => Epok.Store.editDay(k, { flow: null })", d(-41))
    check([c for c in cyc() if c[1] == "manual"] == [[d(-40), "manual"]],
          "clearing flow never removes a start marked by hand", str(cyc()))

    # 4e. A start the user removed stays removed.
    page.evaluate("(k) => Epok.Store.clearPeriodStart(k)", d(-4))
    page.evaluate("(k) => Epok.Store.editDay(k, { flow: 'light' })", d(-2))
    check(d(-4) not in [c[0] for c in cyc()] and d(-3) not in [c[0] for c in cyc()],
          "a removed inferred start is not re-inferred by the next flow edit", str(cyc()))
    rej = page.evaluate("() => Epok.Store.get().meta.rejectedStarts")
    check(rej == [d(-4)], "the rejection is recorded", str(rej))
    check(errs == [], "review/starts: console errors", "; ".join(errs))
    ctx.close()

    # v2 -> v3 migration: every existing start becomes manual, nothing is removed.
    v2 = json.loads(json.dumps(SEEDED_STATE))
    v2["v"] = 2
    v2["cycles"] = [{"start": "2026-06-01", "end": None, "length": None, "ovulation": None, "ovulationSource": None},
                    {"start": "2026-07-01", "end": None, "length": None, "ovulation": None, "ovulationSource": None}]
    ctx, page, errs = new_page(browser, seed={"epok.state.v1": json.dumps(v2)})
    st = page.evaluate("() => Epok.Store.get()")
    check(st["v"] == page.evaluate("() => Epok.SCHEMA_VERSION"), "v2 state migrates through to the current schema", str(st["v"]))
    # The seed's flow days legitimately add inferred starts after boot; what the
    # migration owns is that the two starts it was handed are manual.
    mine = [c["source"] for c in st["cycles"] if c["start"] in ("2026-06-01", "2026-07-01")]
    check(mine == ["manual", "manual"] and len(mine) == 2,
          "migration: every pre-existing start becomes manual, none inferred", str([(c["start"], c.get("source")) for c in st["cycles"]]))
    check(st["meta"]["rejectedStarts"] == [] and "checkin" in st["days"]["2026-08-18"],
          "migration: rejectedStarts and day.checkin added")
    check(errs == [], "review/migration: console errors", "; ".join(errs))
    ctx.close()

    # Helper: build N regular 28-day cycles ending `back` days ago, with a 5-day
    # bleed each carrying CRAMPS, then BBT-only readings on 60 other days.
    BUILD = """(args) => {
      const [nCycles, lastStartBack, extra] = args, S = Epok.Store.get();
      S.days = {}; S.cycles = []; S.meta.rejectedStarts = [];
      for (let i = 0; i < nCycles; i++) {
        const start = Epok.shiftDay(Epok.today(), -(lastStartBack + 28 * (nCycles - 1 - i)));
        S.cycles.push({ start, end: Epok.shiftDay(start, 4), length: null, ovulation: null, ovulationSource: null, source: 'manual' });
        for (let k = 0; k < 5; k++) S.days[Epok.shiftDay(start, k)] = { flow: 'medium', tags: ['cramps'], bbt: null, lh: null, pill: null, note: '', checkin: false };
      }
      let n = 0;
      for (let k = 6; n < 60 && k < 400; k++) {
        const key = Epok.shiftDay(Epok.today(), -k);
        if (S.days[key] || S.cycles.some(c => Epok.daysBetween(c.start, key) >= 0 && Epok.daysBetween(c.start, key) <= 4)) continue;
        S.days[key] = { flow: null, tags: extra === 'mood' ? ['low-mood'] : [], bbt: 36.4, lh: null, pill: null, note: '', checkin: extra === 'checkin' };
        n++;
      }
      return Epok.Store.flush();
    }"""

    def patterns(extra):
        c, pg, e = new_page(browser)
        pg.evaluate(BUILD, [4, 6, extra])
        pg.reload(); pg.wait_for_timeout(300)
        pg.click('.rail__item[data-view="insights"]'); pg.wait_for_timeout(200)
        txt = pg.locator("#main").inner_text()
        check(e == [], f"review/insights({extra}): console errors", "; ".join(e))
        c.close()
        return txt

    # 10. Same cramps, same cycle dates; only unrelated logging differs.
    check("CRAMPS on" not in patterns("none"), "patterns: BBT-only days give no cramps pattern")
    check("CRAMPS on" not in patterns("mood"),
          "patterns: an unrelated MOOD tag on those days must not create a cramps pattern")
    check("CRAMPS on" in patterns("checkin"),
          "patterns: days explicitly checked in with no symptoms DO count as cramp-free")

    # 5 + 6. A suppressing method pauses the card; a long-overdue forecast says it expired.
    ctx, page, errs = new_page(browser)
    page.evaluate(BUILD, [5, 60, "none"])
    page.reload(); page.wait_for_timeout(300)
    page.click('.rail__item[data-view="today"]'); page.wait_for_timeout(200)
    txt = page.locator("#main").inner_text()
    check("EXPIRED FORECAST" in txt, "today: a window that ended weeks ago is headed EXPIRED FORECAST", txt[:300])
    page.evaluate("() => Epok.Store.setProfile({ contraception: 'combined-21-7' })")
    page.evaluate("() => Epok.refresh()"); page.wait_for_timeout(200)
    txt = page.locator("#main").inner_text()
    check("PREDICTION PAUSED" in txt and "suppresses ovulation" in txt,
          "today: a combined pill pauses the natural-cycle card and says why", txt[:300])
    check(page.locator('#main :text("PREDICTED NEXT START")').count() == 0,
          "today: no predicted date is shown while paused")
    check(errs == [], "review/pause: console errors", "; ".join(errs))
    ctx.close()


def check_features(browser) -> None:
    """PLAN-features-sync.md A1-A5: timeline, forecast history, severity,
    temperature notes, events. Real clicks wherever a control exists."""
    # N regular 28-day cycles, last one starting `back` days ago, each with a bleed.
    BUILD = """(args) => {
      const [n, back, lens] = args, S = Epok.Store.get();
      S.days = {}; S.cycles = []; S.predictions = []; S.events = [];
      let start = -(back + (lens ? lens.reduce((a, b) => a + b, 0) : 28 * (n - 1)));
      for (let i = 0; i < n; i++) {
        const k = Epok.shiftDay(Epok.today(), start);
        S.cycles.push({ start: k, end: Epok.shiftDay(k, 4), length: null, ovulation: null, ovulationSource: null, source: 'manual', excluded: false });
        for (let j = 0; j < 5; j++) S.days[Epok.shiftDay(k, j)] = { flow: 'medium', tags: [], bbt: null, lh: null, pill: null, note: '', checkin: false, severity: {}, impact: null, bbtMeta: null };
        start += lens ? lens[i] : 28;
      }
      return Epok.Store.flush();
    }"""

    # A1. Timeline: one card per cycle, a long cycle is flagged not edited, exclude/move/remove act and undo.
    ctx, page, errs = new_page(browser)
    page.evaluate(BUILD, [5, 10, [28, 28, 70, 28]])
    page.reload(); page.wait_for_timeout(300)
    page.click('.rail__item[data-view="timeline"]'); page.wait_for_timeout(200)
    check(page.locator("[data-cycle]").count() == 5, "timeline: one card per cycle", str(page.locator("[data-cycle]").count()))
    txt = page.locator("#main").inner_text()
    check("LONG — 70 days" in txt and "missed entry" in txt and "real long cycle" in txt,
          "timeline: a 70-day cycle is flagged with both readings", txt[:200])
    check(page.evaluate("() => Epok.Store.cycles().length") == 5, "timeline: flagging a long cycle changes nothing")
    longcard = page.locator("[data-cycle]").filter(has_text="LONG — 70 days")
    longcard.get_by_role("button", name="LEAVE OUT OF THE FIT").click(); page.wait_for_timeout(150)
    check(page.evaluate("() => Epok.Store.cycles().filter(c => c.excluded).length") == 1, "timeline: leave out sets cycle.excluded")
    check("LEFT OUT OF THE FIT" in page.locator("#main").inner_text(), "timeline: the excluded cycle says so")
    page.locator("[data-cycle]").filter(has_text="LEFT OUT").get_by_role("button", name="COUNT IN THE FIT").click(); page.wait_for_timeout(150)
    check(page.evaluate("() => Epok.Store.cycles().filter(c => c.excluded).length") == 0, "timeline: count in clears it")
    newest = page.locator("[data-cycle]").first
    newest.get_by_role("button", name="MOVE START").click(); page.wait_for_timeout(100)
    start = page.evaluate("() => Epok.Store.cycles().slice(-1)[0].start")
    target = page.evaluate("(k) => Epok.shiftDay(k, -9)", start)
    page.locator("[data-cycle] input[type=date]").first.fill(target)
    page.wait_for_timeout(80)
    check("Moving to" in page.locator("#main").inner_text() and "goes from" in page.locator("#main").inner_text(),
          "timeline: a move states its consequence before it is made")
    page.get_by_role("button", name="MOVE", exact=True).click(); page.wait_for_timeout(150)
    check(page.evaluate("() => Epok.Store.cycles().slice(-1)[0].start") == target and
          page.evaluate("() => Epok.Store.cycles().slice(-1)[0].source") == "manual",
          "timeline: move start applies and becomes manual")
    r = page.evaluate("(k) => Epok.Store.moveStart(k, Epok.shiftDay(Epok.Store.cycles()[3].start, 3))", target)
    check(r["ok"] is False and "within" in r["error"], "timeline: a move onto a neighbour is refused inline", str(r))
    check(errs == [], "features/timeline: console errors", "; ".join(errs))
    ctx.close()

    # A3. Severity and impact: per-tag 1-3 appears only for tags that are on and is dropped with the tag.
    ctx, page, errs = new_page(browser)
    page.click('.rail__item[data-view="today"]'); page.wait_for_timeout(150)
    page.get_by_role("button", name="CRAMPS", exact=True).click(); page.wait_for_timeout(150)
    page.locator(".small-block", has_text="HOW BAD").get_by_role("button", name="2", exact=True).click(); page.wait_for_timeout(120)
    day = page.evaluate("() => Epok.Store.day()")
    check(day["severity"] == {"cramps": 2}, "severity: a rating is stored per tag", str(day["severity"]))
    page.get_by_role("button", name="A LOT", exact=True).click(); page.wait_for_timeout(120)
    check(page.evaluate("() => Epok.Store.day().impact") == "a-lot", "impact: stored")
    page.get_by_role("button", name="CRAMPS", exact=True).click(); page.wait_for_timeout(150)
    check(page.evaluate("() => Epok.Store.day().severity") == {}, "severity: removing the tag drops its rating")
    check("Symptom record:" in page.locator("#main").inner_text(), "check-in: the completeness line is shown")

    # A4. Temperature notes: shown only with a reading, disturbed flag stored, cleared with the reading.
    check("HOW IT WAS TAKEN" not in page.locator("#main").inner_text(), "bbt: no notes block without a reading")
    page.get_by_label("Basal body temperature in Celsius").fill("36.55"); page.get_by_label("Basal body temperature in Celsius").blur(); page.wait_for_timeout(200)
    page.locator(".small-block", has_text="HOW IT WAS TAKEN").get_by_role("button", name="ALCOHOL", exact=True).click(); page.wait_for_timeout(150)
    check(page.evaluate("() => Epok.Store.day().bbtMeta") == {"time": None, "disturbed": "alcohol"}, "bbt: disturbed flag stored")
    check("left out when epok looks for a temperature rise" in page.locator("#main").inner_text(), "bbt: a flagged reading says it is excluded")
    page.get_by_label("Basal body temperature in Celsius").fill(""); page.get_by_label("Basal body temperature in Celsius").blur(); page.wait_for_timeout(200)
    check(page.evaluate("() => Epok.Store.day().bbtMeta") is None, "bbt: clearing the reading clears its notes")
    check(errs == [], "features/severity+bbt: console errors", "; ".join(errs))
    ctx.close()

    # A5. Events: open pregnancy pauses and ends; a method change leaves a closed event; bad dates refused inline.
    ctx, page, errs = new_page(browser)
    page.evaluate(BUILD, [5, 10, None])
    page.reload(); page.wait_for_timeout(300)
    page.click('.rail__item[data-view="today"]'); page.wait_for_timeout(200)
    check("PREDICTED NEXT START" in page.locator("#main").inner_text(), "events: a forecast shows before any event")
    page.get_by_role("button", name="+ PREGNANCY").click(); page.wait_for_timeout(200)
    txt = page.locator("#main").inner_text()
    check("PREDICTION PAUSED" in txt and "pregnancy span is open" in txt, "events: an open pregnancy pauses the forecast, with its reason", txt[:300])
    page.get_by_role("button", name="END TODAY").click(); page.wait_for_timeout(200)
    check("PREDICTION PAUSED" not in page.locator("#main").inner_text(), "events: ending it lifts the pause")
    check(page.evaluate("() => Epok.Store.get().events.length") == 1, "events: the ended span stays on record")
    r = page.evaluate("() => Epok.Store.addEvent({ type: 'medication', from: '2026-05-10', to: '2026-05-01' })")
    check(r["ok"] is False and "before the start" in r["error"], "events: an end before the start is refused inline", str(r))
    page.evaluate("() => { Epok.Store.setProfile({ contraception: 'ring' }); Epok.Store.setProfile({ contraception: null }); }")
    evs = page.evaluate("() => Epok.Store.get().events.filter(e => e.type === 'contraception')")
    check(len(evs) == 1 and evs[0]["method"] == "ring" and evs[0]["to"] is not None,
          "events: stopping a method closes its event instead of erasing it", str(evs))
    check(errs == [], "features/events: console errors", "; ".join(errs))
    ctx.close()

    # A2. Forecast snapshots are written, settled when the next start arrives, and labelled as few.
    ctx, page, errs = new_page(browser)
    page.evaluate(BUILD, [5, 20, None])
    page.reload(); page.wait_for_timeout(300)
    page.evaluate("() => Epok.Store.flush()"); page.wait_for_timeout(100)
    preds = page.evaluate("() => Epok.Store.get().predictions")
    check(len(preds) >= 1 and preds[-1]["actual"] is None and preds[-1]["modelVersion"] >= 2,
          "snapshots: a forecast is saved with its engine version and is pending", str(preds[-1:] ))
    page.evaluate("() => Epok.Store.setPeriodStart(Epok.shiftDay(Epok.today(), -1))")
    page.evaluate("() => Epok.Store.flush()"); page.wait_for_timeout(150)
    preds = page.evaluate("() => Epok.Store.get().predictions")
    settled = [p for p in preds if p["actual"] is not None]
    check(len(settled) >= 1 and isinstance(settled[0]["errorDays"], int) and isinstance(settled[0]["inWindow"], bool),
          "snapshots: logging the next start settles the forecast against it", str(settled[:1]))
    page.click('.rail__item[data-view="insights"]'); page.wait_for_timeout(200)
    txt = page.locator("#main").inner_text()
    check("FORECAST HISTORY" in txt and "settled so far" in txt and "RECONSTRUCTED" in txt,
          "snapshots: with fewer than 6 settled, the card says the headline error is reconstructed", txt[:200])
    check(errs == [], "features/snapshots: console errors", "; ".join(errs))
    ctx.close()

    # A6. Report: range, completeness, prolonged bleeding, events, severity, phase basis.
    ctx, page, errs = new_page(browser)
    page.evaluate(BUILD, [6, 10, None])
    page.evaluate("""() => {
      const S = Epok.Store.get(), st = S.cycles[2].start;
      for (let j = 5; j < 9; j++) S.days[Epok.shiftDay(st, j)] = { flow: 'light', tags: [], bbt: null, lh: null, pill: null, note: '', checkin: false, severity: {}, impact: null, bbtMeta: null };
      const t = S.cycles[4].start;
      S.days[t] = Object.assign(S.days[t], { tags: ['cramps'], severity: { cramps: 3 }, impact: 'a-lot', checkin: true });
      S.events.push({ id: 'e1', type: 'medication', method: null, from: Epok.shiftDay(Epok.today(), -60), to: null, note: 'iron' });
      return Epok.Store.flush();
    }""")
    page.reload(); page.wait_for_timeout(300)
    page.click('.rail__item[data-view="report"]'); page.wait_for_timeout(250)
    txt = page.locator("#main").inner_text()
    check("SELF-REPORTED" in txt and "HOW COMPLETE THIS LOG IS" in txt and "temperature on 0%" in txt,
          "report: header, and a completeness line that says what is missing", txt[:300])
    check("1 bleeding episode" not in txt and "lasted more than 7 days: " in txt and "(9 days)" in txt,
          "report: a 9-day bleeding episode is flagged as prolonged", txt[txt.find("BLEEDING"):txt.find("BLEEDING") + 260])
    check("medication: " in txt and "(iron)" in txt and "ongoing" in txt, "report: events appear with their dates and note")
    check("3.0 of 3" in txt and "SELF-RATED SEVERITY" in txt and "Phase basis:" in txt,
          "report: symptoms carry the user's own severity and say how phases were placed", txt[txt.find("SYMPTOMS"):txt.find("SYMPTOMS") + 300])
    check("affected \"a lot\"" in txt, "report: days affected a lot are counted")
    n12 = page.evaluate("() => document.querySelectorAll('.report-page tbody tr').length")
    page.get_by_role("button", name="3 MONTHS", exact=True).click(); page.wait_for_timeout(200)
    n3 = page.evaluate("() => document.querySelectorAll('.report-page tbody tr').length")
    check(n3 < n12, "report: a shorter range lists fewer cycles", f"{n3} vs {n12}")
    check("Cycles started in this range: " in page.locator("#main").inner_text(), "report: the summary says it is for the range")
    check(errs == [], "features/report: console errors", "; ".join(errs))
    ctx.close()

    # Migration v3 -> v4.
    v3 = json.loads(json.dumps(SEEDED_STATE)); v3["v"] = 3
    v3["profile"]["contraception"] = "ring"; v3["profile"]["contraceptionStart"] = "2026-06-01"
    v3["days"]["2026-08-18"].pop("checkin", None)
    ctx, page, errs = new_page(browser, seed={"epok.state.v1": json.dumps(v3)})
    st = page.evaluate("() => Epok.Store.get()")
    check(st["v"] == 4 and any(e["type"] == "contraception" and e["method"] == "ring" and e["to"] is None and e["from"] == "2026-06-01" for e in st["events"]),
          "migration v3->v4: the current method becomes an open event", str(st["events"]))
    check(st["profile"]["contraception"] == "ring" and st["profile"]["contraceptionStart"] == "2026-06-01",
          "migration v3->v4: the profile fields are left exactly as they were")
    check(all(c["excluded"] is False for c in st["cycles"]) and st["days"]["2026-08-18"]["severity"] == {},
          "migration v3->v4: new fields default, nothing removed")
    check(errs == [], "features/migration: console errors", "; ".join(errs))
    ctx.close()


def check_calendar_three(browser) -> None:
    """B1/B2: the three-month view, keyboard, jump-to-date and quick log."""
    for scheme in ("dark", "light"):
        ctx, page, errs = new_page(browser, width=1920, height=1000, colour_scheme=scheme)
        page.click('.rail__item[data-view="calendar"]'); page.wait_for_timeout(200)
        check(page.locator(".cal-grid").count() == 1, f"cal3 [{scheme}]: month view is one grid by default")
        page.get_by_role("button", name="3 MONTHS", exact=True).click(); page.wait_for_timeout(200)
        check(page.locator(".cal-grid").count() == 3 and page.locator(".cal--three").count() == 1,
              f"cal3 [{scheme}]: 3 MONTHS draws three grids")
        title = page.locator(".cal-nav h1").inner_text()
        check("–" in title, f"cal3 [{scheme}]: the title spans the months", title)
        boxes = page.evaluate("""() => [...document.querySelectorAll('.cal-three > .card')].map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.top]; })""")
        check(len(boxes) == 3 and boxes[0][1] <= boxes[1][0] + 1 and boxes[1][1] <= boxes[2][0] + 1 and abs(boxes[0][2] - boxes[2][2]) < 2,
              f"cal3 [{scheme}]: at 1920 the three months sit side by side", str(boxes))
        main = page.evaluate("() => { const r = document.getElementById('main').getBoundingClientRect(); return [r.left, r.right]; }")
        left_gap, right_gap = boxes[0][0] - main[0], main[1] - boxes[2][1]
        check(abs(left_gap - right_gap) <= 2 and (boxes[2][1] - boxes[0][0]) > 1400,
              f"cal3 [{scheme}]: 1920 — the months fill the page, centred, no stranded space", f"gaps {left_gap:.0f}/{right_gap:.0f}, width {boxes[2][1]-boxes[0][0]:.0f}")
        check(page.evaluate("() => document.documentElement.scrollWidth <= document.documentElement.clientWidth"),
              f"cal3 [{scheme}]: no horizontal overflow")
        check(errs == [], f"cal3 [{scheme}]: console errors", "; ".join(errs))
        ctx.close()

    ctx, page, errs = new_page(browser, width=1440, height=950)
    page.click('.rail__item[data-view="calendar"]'); page.wait_for_timeout(200)
    page.get_by_role("button", name="3 MONTHS", exact=True).click(); page.wait_for_timeout(200)
    check(page.evaluate("() => localStorage.getItem('epok.cal.mode')") == "three", "cal3: the view choice is remembered")
    page.reload(); page.wait_for_timeout(300)
    check(page.locator(".cal-grid").count() == 3, "cal3: it survives a reload")

    # Keyboard: arrows move the selected day, PageDown the month, T returns, ? lists them.
    sel0 = page.locator(".cal-day.is-selected").get_attribute("data-date")
    page.keyboard.press("ArrowRight"); page.wait_for_timeout(120)
    sel1 = page.locator(".cal-day.is-selected").get_attribute("data-date")
    check(sel1 == page.evaluate("(k) => Epok.shiftDay(k, 1)", sel0), "cal3: ArrowRight selects the next day", f"{sel0} -> {sel1}")
    page.keyboard.press("ArrowDown"); page.wait_for_timeout(120)
    check(page.locator(".cal-day.is-selected").get_attribute("data-date") == page.evaluate("(k) => Epok.shiftDay(k, 8)", sel0),
          "cal3: ArrowDown moves a week")
    t0 = page.locator(".cal-nav h1").inner_text()
    page.keyboard.press("PageDown"); page.wait_for_timeout(120)
    check(page.locator(".cal-nav h1").inner_text() != t0, "cal3: PageDown changes month")
    page.keyboard.press("t"); page.wait_for_timeout(120)
    check(page.locator(".cal-nav h1").inner_text() == t0, "cal3: T returns to today")
    page.keyboard.press("?"); page.wait_for_timeout(120)
    check("KEYBOARD" in page.locator(".cal-help").inner_text(), "cal3: ? lists the shortcuts")
    page.keyboard.press("1"); page.wait_for_timeout(120)
    check(page.locator(".cal-grid").count() == 1, "cal3: 1 returns to a single month")

    # Jump to date, and quick log from the panel without leaving the calendar.
    past = page.evaluate("() => Epok.shiftDay(Epok.today(), -75)")
    page.locator(".cal-jump").fill(past); page.locator(".cal-jump").dispatch_event("change"); page.wait_for_timeout(200)
    check(page.locator(".cal-day.is-selected").get_attribute("data-date") == past, "cal3: jump-to-date selects that day")
    page.get_by_role("button", name="MEDIUM", exact=True).click(); page.wait_for_timeout(200)
    check(page.evaluate("(k) => Epok.Store.day(k).flow", past) == "medium" and page.evaluate("() => location.hash") == "#calendar",
          "cal3: quick log sets flow on that day and stays on the calendar")
    check(page.locator(".cal-day.is-selected").get_attribute("data-date") == past, "cal3: the selection survives a quick log")
    page.get_by_role("button", name="CHECKED IN", exact=True).click(); page.wait_for_timeout(150)
    check(page.evaluate("(k) => Epok.Store.day(k).checkin", past) is True, "cal3: quick check-in")
    check(errs == [], "cal3: console errors", "; ".join(errs))
    ctx.close()

    ctx, page, errs = new_page(browser, width=400, height=800)
    page.click('.rail__item[data-view="calendar"]'); page.wait_for_timeout(200)
    page.get_by_role("button", name="3 MONTHS", exact=True).click(); page.wait_for_timeout(200)
    boxes = page.evaluate("""() => [...document.querySelectorAll('.cal-three > .card')].map(e => e.getBoundingClientRect().top)""")
    check(len(boxes) == 3 and boxes[0] < boxes[1] < boxes[2], "cal3: at 400px the months stack", str(boxes))
    check(page.evaluate("() => document.documentElement.scrollWidth <= document.documentElement.clientWidth"), "cal3: 400px has no horizontal overflow")
    check(errs == [], "cal3: 400px console errors", "; ".join(errs))
    ctx.close()


def check_sync(browser) -> None:
    """Opt-in sync against tools/mock_turso.py. The mock is NOT Turso: this proves
    js/sync.js behaves as designed on the documented request shape, and says
    nothing about CORS or acceptance by a real Turso endpoint (PLAN C0)."""
    import pathlib, socket, subprocess, urllib.request

    root = pathlib.Path(__file__).resolve().parent
    token = "test-token-not-a-secret"
    PASS = "correct horse battery"

    def free_port() -> int:
        sk = socket.socket(); sk.bind(("127.0.0.1", 0)); p = sk.getsockname()[1]; sk.close(); return p

    class Mock:
        def __init__(self, port: int | None = None):
            self.port = port or free_port()
            self.proc = subprocess.Popen([sys.executable, str(root / "mock_turso.py"), "--port", str(self.port), "--token", token],
                                         stdout=subprocess.PIPE, text=True)
            assert self.proc.stdout.readline().strip() == "READY"
        def dump(self) -> dict:
            req = urllib.request.Request(f"http://127.0.0.1:{self.port}/__dump", headers={"Authorization": f"Bearer {token}"})
            return json.loads(urllib.request.urlopen(req, timeout=5).read())
        def stop(self) -> None:
            self.proc.terminate(); self.proc.wait(timeout=5)

    def fill(page, label, value):
        loc = page.get_by_label(label, exact=True)
        loc.fill(value); loc.blur()

    def enable(page, port, passphrase=PASS, repeat=None):
        page.click('.rail__item[data-view="settings"]'); page.wait_for_timeout(250)
        fill(page, "Database URL", f"http://127.0.0.1:{port}")
        fill(page, "Database token", token)
        fill(page, "Sync passphrase", passphrase)
        fill(page, "Repeat the sync passphrase", repeat or passphrase)
        page.get_by_role("button", name="I UNDERSTAND A LOST PASSPHRASE CANNOT BE RECOVERED").click(); page.wait_for_timeout(100)
        page.get_by_role("button", name="TURN ON SYNC", exact=True).click()

    def wait_text(page, needle, ms=20000):
        page.wait_for_function("(t) => document.getElementById('main').innerText.includes(t)", arg=needle, timeout=ms)

    def sync_now(page):
        return page.evaluate("() => Epok.Sync.syncNow().then(s => s, e => ({ error: e.message, kind: e.kind }))")

    m = Mock()
    ctxA, A, errsA = new_page(browser, width=1440, height=950)
    A.evaluate("""() => { const d = n => Epok.shiftDay(Epok.today(), n);
      Epok.Store.setPeriodStart(d(-60)); Epok.Store.setPeriodStart(d(-30));
      Epok.Store.editDay(d(-10), { note: 'from A', tags: ['cramps'] }); Epok.Store.editDay(d(-9), { note: 'second' });
      document.querySelectorAll('.undo').forEach(n => n.remove()); return Epok.Store.flush(); }""")
    day10 = A.evaluate("() => Epok.shiftDay(Epok.today(), -10)")

    # Guards before anything is sent.
    enable(A, m.port, repeat="something else entirely"); A.wait_for_timeout(300)
    check("passphrases differ" in A.locator("#main").inner_text() and m.dump()["records"] == [],
          "sync: mismatched passphrases are refused inline and upload nothing")
    fill(A, "Repeat the sync passphrase", PASS)
    A.get_by_role("button", name="TURN ON SYNC", exact=True).click(); wait_text(A, "Sync is on.")
    check(A.evaluate("() => Epok.Sync.status().configured && Epok.Sync.status().unlocked"), "sync: set up and unlocked on device A")

    # What the database holds.
    d = m.dump(); recs = d["records"]
    check(len(recs) >= 6 and {r["kind"] for r in recs} <= {"day", "blob"}, "sync: one row per day plus the lists", str(len(recs)))
    blob = json.dumps(d)
    check("from A" not in blob and "cramps" not in blob and not re.search(r"20\d\d-\d\d-\d\d", blob),
          "sync: the database holds no readable note, tag or date — ids, hashes and payloads are opaque")
    exported = A.evaluate("() => Epok.Store.exportJSON().text()")
    check(token not in exported and token not in A.evaluate("() => localStorage.getItem('epok.state.v1')"),
          "sync: the token is in neither the backup export nor the state")

    # Device B joins; a wrong passphrase is refused before it uploads anything.
    ctxB, B, errsB = new_page(browser, width=1440, height=950)
    before = len(m.dump()["records"])
    enable(B, m.port, passphrase="wrong passphrase!!"); wait_text(B, "does not open the data already in this database")
    check(len(m.dump()["records"]) == before and B.evaluate("() => Epok.Sync.status().configured") is False,
          "sync: a wrong passphrase is refused and B uploads and stores nothing")
    fill(B, "Sync passphrase", PASS); fill(B, "Repeat the sync passphrase", PASS)
    B.get_by_role("button", name="TURN ON SYNC", exact=True).click(); wait_text(B, "Sync is on.")
    check(B.evaluate("(k) => Epok.Store.day(k).note", day10) == "from A" and B.evaluate("() => Epok.Store.cycles().length") == 2,
          "sync: device B receives A's days and cycles", B.evaluate("(k) => JSON.stringify(Epok.Store.day(k))", day10))

    r = sync_now(A)
    check(A.evaluate("() => Epok.Store.cycles().length") == 2 and r.get("conflicts") == 0,
          "sync: a fresh device joining does not overwrite A's cycles with its empty list", str(r))

    # A change on one side only is not a conflict.
    B.evaluate("(k) => Epok.Store.editDay(k, { note: 'B edit one' })", day10)
    r = sync_now(B); check(r.get("pushed", 0) >= 1, "sync: B pushes its edit", str(r))
    r = sync_now(A)
    check(A.evaluate("(k) => Epok.Store.day(k).note", day10) == "B edit one" and r.get("conflicts") == 0,
          "sync: A receives it with no conflict", str(r))

    # The same record changed on both: the newer edit wins and the other is kept.
    A.evaluate("() => Epok.Sync.setEnabled(false)")
    A.evaluate("(k) => Epok.Store.editDay(k, { note: 'A edit older' })", day10)
    A.wait_for_timeout(1100)
    B.evaluate("(k) => Epok.Store.editDay(k, { note: 'B edit newer' })", day10)
    sync_now(B)
    A.evaluate("() => Epok.Sync.setEnabled(true)")
    r = sync_now(A)
    check(r.get("conflicts") == 1 and A.evaluate("(k) => Epok.Store.day(k).note", day10) == "B edit newer",
          "sync: a two-sided change keeps the newer edit and reports one conflict", str(r))
    A.click('.rail__item[data-view="settings"]'); A.wait_for_timeout(250)
    ct = A.locator("#main").inner_text()
    check("CONFLICTS" in ct and "A edit older" in ct, "sync: the losing version is listed so it can be read", ct[ct.find("CONFLICTS"):ct.find("CONFLICTS") + 240])
    check(A.evaluate("() => localStorage.getItem('epok.state.prev')") is not None, "sync: epok.state.prev holds the state a pull overwrote")

    # A new session starts locked, visibly, and needs the passphrase.
    A.reload(); A.wait_for_timeout(400)
    check(A.locator('[data-banner="sync"]').count() == 1 and "locked for this session" in A.locator('[data-banner="sync"]').inner_text(),
          "sync: a new session says sync is locked, in a banner, not silently")
    A.click('.rail__item[data-view="settings"]'); A.wait_for_timeout(250)
    fill(A, "Sync passphrase", "not it at all"); A.get_by_role("button", name="UNLOCK SYNC").click(); wait_text(A, "not the sync passphrase")
    fill(A, "Sync passphrase", PASS); A.get_by_role("button", name="UNLOCK SYNC").click(); wait_text(A, "Synced.")
    check(A.locator('[data-banner="sync"]').count() == 0, "sync: unlocking clears the banner")

    # Unreachable database: said plainly, local log unaffected.
    days_before = A.evaluate("() => Object.keys(Epok.Store.get().days).length")
    m.stop()
    A.evaluate("(k) => Epok.Store.editDay(k, { note: 'written offline' })", day10)
    r = sync_now(A)
    check(r.get("kind") == "network" and "Could not reach" in r.get("error", ""), "sync: an unreachable database is reported as such", str(r))
    bn = A.locator('[data-banner="sync"]')
    check(bn.count() == 1 and "Last good sync" in bn.inner_text(), "sync: the banner gives the age of the last good sync", bn.inner_text() if bn.count() else "")
    check(A.evaluate("(k) => Epok.Store.day(k).note", day10) == "written offline", "sync: the local log keeps working offline")

    # A reset database must not erase the local log.
    m2 = Mock(m.port)
    r = sync_now(A)
    check(r.get("kind") == "reset", "sync: a database that lost its sync data is refused, not read as 'everything deleted'", str(r))
    check(A.evaluate("() => Object.keys(Epok.Store.get().days).length") == days_before and
          A.evaluate("(k) => Epok.Store.day(k).note", day10) == "written offline",
          "sync: the local log is untouched by a reset database")
    m2.stop()

    # Teardown on a fresh device: the uploaded copy goes, the local log stays.
    m3 = Mock()
    ctxC, C, errsC = new_page(browser, width=1440, height=950)
    C.evaluate("() => { Epok.Store.editDay(Epok.shiftDay(Epok.today(), -3), { note: 'keep me' }); return Epok.Store.flush(); }")
    enable(C, m3.port); wait_text(C, "Sync is on.")
    check(len(m3.dump()["records"]) >= 2, "sync: C uploaded something to delete")
    C.get_by_role("button", name="DELETE THE UPLOADED COPY…").click(); C.wait_for_timeout(150)
    C.get_by_role("button", name="YES, DELETE THE UPLOADED COPY").click(); wait_text(C, "Deleted ")
    d3 = m3.dump()
    check(d3["records"] == [] and d3["meta"] == [], "sync: delete-the-uploaded-copy empties the database")
    check(C.evaluate("() => localStorage.getItem('epok.sync.v1')") is None and
          C.evaluate("(k) => Epok.Store.day(k).note", C.evaluate("() => Epok.shiftDay(Epok.today(), -3)")) == "keep me",
          "sync: it forgets the config here and leaves the local log alone")
    m3.stop()

    # The repo and the deploy copy carry no database credential.
    leaked = []
    for base in (root.parent / "js", root.parent / "deploy" / "public"):
        if base.exists():
            for f in base.rglob("*"):
                if f.is_file() and f.suffix in (".js", ".html", ".json", ".webmanifest"):
                    if re.search(r"eyJ[A-Za-z0-9_-]{20,}", f.read_text(errors="ignore")):
                        leaked.append(str(f))
    check(not leaked, "sync: no JWT-shaped database token in js/ or the deploy copy", str(leaked))

    for name, e in (("A", errsA), ("B", errsB), ("C", errsC)):
        e = [x for x in e if "net::ERR_CONNECTION_REFUSED" not in x and "Failed to load resource" not in x]
        check(e == [], f"sync: console errors on device {name}", "; ".join(e))
    ctxA.close(); ctxB.close(); ctxC.close()


SECTIONS = {
    "completion": check_completion,
    "tags": check_custom_tags,
    "boot": check_boot,
    "migration": check_migration,
    "dates": check_dates,
    "period": check_period_starts,
    "lock": check_lock,
    "portability": check_portability,
    "offline": check_offline,
    "reminders": check_reminders,
    "shell": check_shell,
    "navigation": check_navigation,
    "dialogs": check_no_dialogs,
    "contrast": check_contrast,
    "layout": check_layout,
    "calendar": check_calendar,
    "review": check_review,
    "features": check_features,
    "calendar3": check_calendar_three,
    "sync": check_sync,
}


def main() -> int:
    wanted = sys.argv[1:] or list(SECTIONS)
    unknown = [w for w in wanted if w not in SECTIONS]
    if unknown:
        print(f"unknown section(s): {', '.join(unknown)}", file=sys.stderr)
        print(f"available: {', '.join(SECTIONS)}", file=sys.stderr)
        return 2
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for name in wanted:
            before = len(FAILURES)
            SECTIONS[name](browser)
            status = "ok" if len(FAILURES) == before else f"{len(FAILURES) - before} FAILED"
            print(f"  {name:<12} {status}")
        browser.close()

    print(f"\n{CHECKS} checks, {len(FAILURES)} failed")
    for f in FAILURES:
        print(f"  FAIL  {f}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())

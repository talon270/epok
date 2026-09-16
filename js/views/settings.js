/* ==========================================================================
   EPOK · VIEW · SETTINGS

   Owner: Window C. See PLAN-epok.md § Parallel windows.

     · PROFILE     age band, conditions, goal, contraception. All skippable, each with its inline why.
     · PRIORS      states which prior is in use and why, and that it decays as real cycles land
     · LOCK        PIN setup, with the forced backup and the unrecoverable warning
     · REMINDERS   suggest, explain, let it be unticked — never switched on silently
     · PORTABILITY JSON backup and CSV export, with the tradeoff stated at the button

   Public namespace: Epok.Views.Settings
   ========================================================================== */

"use strict";

(function () {
  var E = window.Epok;

  /* Store.setProfile() only saves — unlike editDay() it does not call
     E.refresh(), because core settings (theme, boundary) are read from many
     places, not just this view. Every write from this view goes through here
     so a tap is never silently unresponsive. */
  function setProfile(patch) {
    E.Store.setProfile(patch);
    E.refresh();
  }

  function chip(label, pressed, onclick) {
    return E.el("button", {
      type: "button", class: "chip", "aria-pressed": pressed ? "true" : "false",
      text: label, onclick: onclick
    });
  }

  /* Single-select group. Clicking the already-selected chip clears it — every
     identity question here is skippable, never gated. */
  function chipGroup(options, value, onSelect) {
    var row = E.el("div", { class: "row" });
    options.forEach(function (o) {
      row.appendChild(chip(o.label, value === o.id, function () {
        onSelect(value === o.id ? null : o.id);
      }));
    });
    return row;
  }

  // A `<section>`, not a `<div>` — every other view's content lives in one
  // (`.card` sections), and Window A's navigation harness asserts `#main
  // section` exists. Settings was the only view built as bare divs.
  function group(title, children) {
    return E.el("section", { class: "settings-group" }, [E.el("h2", { text: title })].concat(children));
  }

  /* ==================================================================
     PROFILE — identity questions. Defaults only; never gates content.
     ================================================================== */

  var AGE_BANDS = [
    { id: "u20", label: "UNDER 20" }, { id: "20s", label: "20s" },
    { id: "30s", label: "30s" }, { id: "40s", label: "40s" }, { id: "50plus", label: "50+" }
  ];
  var GOALS = [
    { id: "track", label: "TRACK" }, { id: "avoid", label: "AVOID PREGNANCY" },
    { id: "conceive", label: "CONCEIVE" }, { id: "symptoms", label: "UNDERSTAND SYMPTOMS" }
  ];
  var CONDITIONS = [
    { id: "pcos", label: "PCOS" }, { id: "endometriosis", label: "ENDOMETRIOSIS" },
    { id: "thyroid", label: "THYROID" }, { id: "perimenopause", label: "PERIMENOPAUSE" }
  ];

  function profileSection(profile) {
    function toggleCondition(id) {
      var cur = profile.conditions || [];
      var next = cur.indexOf(id) >= 0 ? cur.filter(function (x) { return x !== id; }) : cur.concat([id]);
      setProfile({ conditions: next });
    }

    var priorNote = null;
    var M = window.Epok.Model;
    if (M) {
      var p = M.predict(E.Store.cycles(), { conditions: profile.conditions, ageBand: profile.ageBand, noMae: true });
      priorNote = E.el("p", { class: "small dim", text:
        "Starting point: the " + p.prior.source + " average — " + p.prior.mean.toFixed(1) +
        "d ±" + p.prior.sd.toFixed(1) + "d. Its influence fades toward zero as your own logged " +
        "cycles accumulate, over roughly six cycles." });
    }

    return group("PROFILE", [
      E.el("p", { class: "small faint", text: "Every answer here is optional and changes nothing it doesn't need to. \"Prefer not to say\" is a real answer — leave it blank." }),
      E.el("div", { class: "field" }, [
        E.el("span", { class: "micro field__label", text: "AGE BAND" }),
        chipGroup(AGE_BANDS, profile.ageBand, function (v) { setProfile({ ageBand: v }); })
      ]),
      E.el("div", { class: "field" }, [
        E.el("span", { class: "micro field__label", text: "GOAL" }),
        chipGroup(GOALS, profile.goal, function (v) { setProfile({ goal: v }); })
      ]),
      E.el("div", { class: "field" }, [
        E.el("span", { class: "micro field__label", text: "DECLARED CONDITIONS" }),
        E.el("div", { class: "row" }, CONDITIONS.map(function (c) {
          return chip(c.label, (profile.conditions || []).indexOf(c.id) >= 0, function () { toggleCondition(c.id); });
        })),
        priorNote
      ])
    ]);
  }

  /* ==================================================================
     CONTRACEPTION — data table from Window A; this file only renders it.
     ================================================================== */

  function contraceptionSection(profile) {
    var C = window.Epok.Contraception;
    if (!C) return null;
    var method = C.BY_ID[profile.contraception] || C.BY_ID.none;

    var picker = E.el("div", { class: "row" }, C.METHODS.map(function (m) {
      return chip(m.label, profile.contraception === m.id || (!profile.contraception && m.id === "none"), function () {
        setProfile({ contraception: m.id === "none" ? null : m.id, contraceptionStart: null, contraceptionExpiry: null });
      });
    }));

    var extra = [];
    if (method.note) extra.push(E.el("p", { class: "small dim", text: method.note }));
    if (method.needsStart) {
      extra.push(E.el("div", { class: "field" }, [
        E.el("span", { class: "micro field__label", text: "STARTED" }),
        E.el("input", {
          type: "date", class: "text-input", value: profile.contraceptionStart || "",
          onchange: function (e) { setProfile({ contraceptionStart: e.target.value || null }); }
        })
      ]));
    }
    if (method.needsExpiry) {
      extra.push(E.el("div", { class: "field" }, [
        E.el("span", { class: "micro field__label", text: "EXPIRES" }),
        E.el("input", {
          type: "date", class: "text-input", value: profile.contraceptionExpiry || "",
          onchange: function (e) { setProfile({ contraceptionExpiry: e.target.value || null }); }
        })
      ]));
    }

    return group("CONTRACEPTION", [picker].concat(extra, [
      E.el("hr", { class: "rule" }),
      E.el("p", { class: "small faint", text: C.NO_GUIDANCE })
    ]));
  }

  /* ==================================================================
     LOCK — PIN setup/disable. A3 guard: forced backup, no reset.
     ================================================================== */

  function lockSection() {
    var L = window.Epok.Lock;
    if (!L) return null;
    if (!L.available) {
      return group("ENCRYPTION", [E.el("p", { class: "small dim", text: "This browser has no Web Crypto support, so epok cannot encrypt here." })]);
    }

    var msg = E.el("p", { class: "small", style: "min-height:1.4em" });

    if (L.isEnabled()) {
      var pinOff = E.el("input", { type: "password", inputmode: "numeric", maxlength: "6", class: "pin", "aria-label": "PIN to disable encryption" });
      return group("ENCRYPTION", [
        E.el("p", {}, [E.el("strong", { text: "Encryption is ON." })]),
        E.el("p", { class: "small dim", text: "Enter your PIN to switch it off. This restores plaintext storage." }),
        pinOff,
        E.el("div", { class: "row" }, [
          E.el("button", {
            type: "button", class: "btn", text: "DISABLE",
            onclick: function () {
              msg.textContent = "Checking…"; msg.style.color = "";
              L.disable(pinOff.value).then(function (r) {
                if (r.ok) { E.toast("Encryption disabled."); E.show("settings"); return; }
                msg.textContent = r.error; msg.style.color = "var(--danger)";
              });
            }
          })
        ]),
        msg
      ]);
    }

    var pin1 = E.el("input", { type: "password", inputmode: "numeric", maxlength: "6", class: "pin", "aria-label": "New 6-digit PIN" });
    return group("ENCRYPTION", [
      E.el("p", { class: "small dim", text: L.SETUP_WARNING }),
      pin1,
      E.el("div", { class: "row" }, [
        E.el("button", {
          type: "button", class: "btn btn--accent", text: "ENABLE",
          onclick: function () {
            msg.textContent = "Encrypting…"; msg.style.color = "";
            L.enable(pin1.value).then(function (r) {
              if (r.ok) { E.toast("Encrypted backup downloaded. Encryption is now on."); E.show("settings"); return; }
              msg.textContent = r.error; msg.style.color = "var(--danger)";
            });
          }
        })
      ]),
      msg
    ]);
  }

  /* ==================================================================
     REMINDERS — suggest, explain, let it be unticked.
     ================================================================== */

  function reminderRow(sg, statusById, profile) {
    var st = statusById[sg.id];
    var checkbox = E.el("input", {
      type: "checkbox", checked: st.on || false,
      onchange: function (e) {
        var cur = profile.reminders;
        var next = {}; Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
        next[sg.id] = e.target.checked;
        setProfile({ reminders: next });
        window.Epok.Reminders.request().then(function () { window.Epok.Reminders.schedule(); E.refresh(); });
      }
    });
    var when = st.on
      ? (st.scheduledFor ? E.el("p", { class: "small dim", text: "Next: " + E.prettyDate(E.ymd(st.scheduledFor)) })
                          : (st.blocked ? E.el("p", { class: "small", text: st.blocked, style: "color:var(--warn)" }) : null))
      : null;
    return E.el("label", { class: "reminder-row" }, [
      checkbox,
      E.el("div", {}, [
        E.el("p", { class: "micro", text: sg.label }),
        E.el("p", { class: "small dim", text: sg.reason }),
        when
      ])
    ]);
  }

  function remindersSection(profile) {
    var R = window.Epok.Reminders;
    if (!R) return null;
    var avail = R.available();
    var suggestions = R.suggestions();
    var status = {}; R.status().forEach(function (s) { status[s.id] = s; });

    var master = E.el("input", {
      type: "checkbox", checked: profile.remindersOn || false,
      onchange: function (e) {
        setProfile({ remindersOn: e.target.checked });
        if (e.target.checked) R.request().then(function () { R.schedule(); E.refresh(); });
        else { R.clear(); E.refresh(); }
      }
    });

    var body = [
      E.el("label", { class: "reminder-row" }, [
        master,
        E.el("div", {}, [
          E.el("p", { class: "micro", text: "REMINDERS ON" }),
          E.el("p", { class: "small dim", text: "Master switch. Nothing below fires unless this is on, and every reminder below is its own unticked checkbox with its own reason." })
        ])
      ])
    ];

    if (!avail.ok) body.push(E.el("p", { class: "small", text: avail.reason, style: "color:var(--warn)" }));

    if (profile.remindersOn) {
      suggestions.forEach(function (sg) { body.push(reminderRow(sg, status, profile)); });
      var pillMethod = window.Epok.Contraception && window.Epok.Contraception.BY_ID[profile.contraception];
      if (pillMethod && pillMethod.kind === "pill") {
        body.push(E.el("div", { class: "field" }, [
          E.el("span", { class: "micro field__label", text: "PILL REMINDER TIME" }),
          E.el("input", {
            type: "time", class: "text-input", value: profile.reminders.pillTime,
            onchange: function (e) {
              var cur = profile.reminders;
              var next = {}; Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
              next.pillTime = e.target.value || "21:00";
              setProfile({ reminders: next });
              R.schedule();
            }
          })
        ]));
      }
    }

    return group("REMINDERS", body);
  }

  /* ==================================================================
     APPEARANCE
     ================================================================== */

  function appearanceSection(profile) {
    return group("APPEARANCE", [
      E.el("div", { class: "field" }, [
        E.el("span", { class: "micro field__label", text: "PALETTE" }),
        E.el("div", { class: "row" }, E.THEMES.map(function (t) {
          return chip(t.toUpperCase(), profile.theme === t, function () { E.setTheme(t); E.refresh(); });
        }))
      ]),
      E.el("div", { class: "field" }, [
        E.el("span", { class: "micro field__label", text: "MODE" }),
        E.el("div", { class: "row" }, E.MODES.map(function (m) {
          return chip(m.toUpperCase(), (document.documentElement.getAttribute("data-mode-pref") || "dark") === m, function () { E.setMode(m); E.refresh(); });
        }))
      ]),
      E.el("div", { class: "field" }, [
        E.el("span", { class: "micro field__label", text: "DAY BOUNDARY (HOUR, 0–6)" }),
        E.el("input", {
          type: "number", min: "0", max: "6", class: "num-input", style: "max-width:120px",
          value: String(profile.dayBoundaryHour),
          onchange: function (e) {
            var v = Math.max(0, Math.min(6, Math.round(Number(e.target.value) || 0)));
            setProfile({ dayBoundaryHour: v });
          }
        }),
        E.el("p", { class: "small faint", text: "Logging before this hour counts as the previous day. 4am by default." })
      ]),
      E.el("label", { class: "reminder-row" }, [
        E.el("input", {
          type: "checkbox", checked: profile.fertilityVisible !== false,
          onchange: function (e) { setProfile({ fertilityVisible: e.target.checked }); }
        }),
        E.el("div", {}, [
          E.el("p", { class: "micro", text: "SHOW FERTILITY ESTIMATES" }),
          E.el("p", { class: "small dim", text: "Fertile-window bands on the calendar. Off hides them everywhere without deleting anything." })
        ])
      ])
    ]);
  }

  /* ==================================================================
     TAGS — hiding is display-only, never a delete.
     ================================================================== */

  // Store.addCustomTag()/removeCustomTag() call E.refresh() themselves (like
  // editDay, unlike setProfile) — so any error message has the same stale-
  // closure hazard the import handlers had. Module state, read fresh, same
  // pattern as jsonImportResult/clue.result below.
  var tagFormError = null;
  var tagRemoveError = null;

  function tagsSection(profile) {
    var hidden = profile.hiddenTags || [];
    var body = window.Epok.Tags.CATEGORIES.map(function (cat) {
      var opts = window.Epok.Tags.byCategory(cat.id);
      var row = E.el("div", { class: "row" }, opts.map(function (t) {
        var isHidden = hidden.indexOf(t.id) >= 0;
        var c = chip(t.label, !isHidden, function () {
          var next = isHidden ? hidden.filter(function (x) { return x !== t.id; }) : hidden.concat([t.id]);
          setProfile({ hiddenTags: next });
        });
        if (!t.custom) return c;
        return E.el("span", { class: "row", style: "gap:2px" }, [
          c,
          E.el("button", {
            type: "button", class: "btn btn--sm", text: "×", "aria-label": "Delete " + t.label,
            onclick: function () {
              var r = window.Epok.Store.removeCustomTag(t.id);
              tagRemoveError = r.ok ? null : r.error;
              E.refresh();
            }
          })
        ]);
      }));
      return E.el("div", { class: "small-block" }, [E.el("p", { class: "micro faint", text: cat.label }), row]);
    });

    var labelInput = E.el("input", { type: "text", class: "text-input", placeholder: "New tag name", maxlength: "24" });
    var categorySelect = E.el("select", { class: "text-input" },
      window.Epok.Tags.CATEGORIES.map(function (c) { return E.el("option", { value: c.id, text: c.label }); }));

    var addForm = E.el("div", { class: "field" }, [
      E.el("span", { class: "micro field__label", text: "ADD A TAG" }),
      E.el("div", { class: "row" }, [
        labelInput, categorySelect,
        E.el("button", {
          type: "button", class: "btn btn--accent", text: "ADD",
          onclick: function () {
            var r = window.Epok.Store.addCustomTag(labelInput.value, categorySelect.value);
            tagFormError = r.ok ? null : r.error;
            E.refresh();
          }
        })
      ]),
      tagFormError ? E.el("p", { class: "small", style: "color:var(--danger)", text: tagFormError }) : null,
      tagRemoveError ? E.el("p", { class: "small", style: "color:var(--danger)", text: tagRemoveError }) : null
    ]);

    return group("TAGS", [
      E.el("p", { class: "small faint", text: "Pressed = shown when logging. Hiding never deletes a tag already logged on a day." })
    ].concat(body, [E.el("hr", { class: "rule" }), addForm]));
  }

  /* ==================================================================
     DATA — backup/restore/CSV. Tradeoff stated at the button.
     ================================================================== */

  // Module-local, not a closure over a DOM node: Store.importJSON() calls
  // E.refresh() itself on success, which re-renders this whole view and
  // orphans any local element the click handler still holds a reference to.
  // Reading state fresh on every render is what makes the result message
  // survive that re-entrant refresh instead of writing into a detached node.
  var jsonImportResult = null;

  function dataSection() {
    var L = window.Epok.Lock;

    var fileInput = E.el("input", {
      type: "file", accept: "application/json", style: "display:none",
      onchange: function (e) {
        var f = e.target.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          jsonImportResult = E.Store.importJSON(String(reader.result));
          E.refresh();
        };
        reader.readAsText(f);
      }
    });

    var importMsg = E.el("p", {
      class: "small", style: jsonImportResult && !jsonImportResult.ok ? "color:var(--danger)" : "",
      text: jsonImportResult ? (jsonImportResult.ok ? "Restored." : jsonImportResult.error) : ""
    });

    return group("DATA", [
      E.el("div", { class: "field" }, [
        E.el("button", {
          type: "button", class: "btn btn--accent", text: "EXPORT JSON",
          onclick: function () {
            E.Store.flush().then(function () {
              var blob = E.Store.exportJSON();
              L ? L.download(blob, E.Store.exportFileName("json")) : downloadFallback(blob, E.Store.exportFileName("json"));
            });
          }
        }),
        E.el("p", { class: "small faint", text: E.Store.EXPORT_NOTES.json })
      ]),
      E.el("div", { class: "field" }, [
        E.el("button", {
          type: "button", class: "btn", text: "EXPORT CSV",
          onclick: function () {
            E.Store.flush().then(function () {
              var blob = E.Store.exportCSV();
              L ? L.download(blob, E.Store.exportFileName("csv")) : downloadFallback(blob, E.Store.exportFileName("csv"));
            });
          }
        }),
        E.el("p", { class: "small faint", text: E.Store.EXPORT_NOTES.csv })
      ]),
      E.el("hr", { class: "rule" }),
      E.el("div", { class: "field" }, [
        E.el("button", { type: "button", class: "btn", text: "IMPORT JSON BACKUP", onclick: function () { fileInput.click(); } }),
        fileInput,
        E.el("p", { class: "small faint", text: "Replaces your current log. This is undoable for a few seconds after, like every change here." }),
        importMsg
      ])
    ]);
  }

  /* ==================================================================
     CLUE IMPORT (B13) — tolerant CSV mapping, correctable before it writes.
     ================================================================== */

  var clue = null; // module-local transient UI state: { text, parsed }

  function clueSection() {
    var I = window.Epok.Import;
    if (!I) return null;

    var fileInput = E.el("input", {
      type: "file", accept: ".csv,text/csv", style: "display:none",
      onchange: function (e) {
        var f = e.target.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          var text = String(reader.result);
          clue = { text: text, parsed: I.parse(text) };
          E.refresh();
        };
        reader.readAsText(f);
      }
    });

    var body = [
      E.el("button", { type: "button", class: "btn", text: "CHOOSE CLUE CSV", onclick: function () { fileInput.click(); } }),
      fileInput
    ];

    if (clue) {
      var p = clue.parsed;
      p.warnings.forEach(function (w) { body.push(E.el("p", { class: "small", style: "color:var(--warn)", text: w })); });
      body.push(E.el("p", { class: "small dim", text: p.rows + " row" + (p.rows === 1 ? "" : "s") + " found." }));

      function colSelect(label, value, onChange) {
        var sel = E.el("select", {
          class: "text-input",
          onchange: function (e) { onChange(e.target.value === "" ? -1 : Number(e.target.value)); E.refresh(); }
        });
        sel.appendChild(E.el("option", { value: "", text: "(none)" }));
        p.headers.forEach(function (h, i) {
          var o = E.el("option", { value: String(i), text: h });
          if (i === value) o.setAttribute("selected", "");
          sel.appendChild(o);
        });
        return E.el("div", { class: "field" }, [E.el("span", { class: "micro field__label", text: label }), sel]);
      }

      body.push(colSelect("DATE COLUMN", p.mapping.dateColumn, function (v) { p.mapping.dateColumn = v; }));
      body.push(colSelect("FLOW COLUMN", p.mapping.flowColumn, function (v) { p.mapping.flowColumn = v; }));

      if (p.preview.length) {
        body.push(E.el("p", { class: "micro faint", text: "PREVIEW" }));
        p.preview.forEach(function (row) {
          body.push(E.el("p", { class: "small dim", text:
            row.date + (row.flow ? " · " + row.flow : "") + (row.tags.length ? " · " + row.tags.join(", ") : "") }));
        });
      }

      body.push(E.el("div", { class: "row" }, [
        E.el("button", {
          type: "button", class: "btn btn--accent",
          text: "IMPORT " + p.rows + " ROW" + (p.rows === 1 ? "" : "S"),
          onclick: function () {
            // Store.editDay() (called per row inside apply()) triggers its
            // own E.refresh() mid-loop, which would orphan a closure-held
            // message node the same way dataSection()'s JSON import did —
            // see jsonImportResult above. Module state, read fresh, instead.
            clue.result = I.apply(clue.text, p.mapping);
            E.refresh();
          }
        })
      ]));
      if (clue.result) {
        body.push(E.el("p", {
          class: "small", style: clue.result.error ? "color:var(--danger)" : "",
          text: clue.result.error || ("Added " + clue.result.added + ", skipped " + clue.result.skipped + ".")
        }));
      }
    }

    return group("IMPORT FROM CLUE", body);
  }

  /* ==================================================================
     PAST PERIODS (B13) — the manual alternative to a Clue file. Same path
     and same guard as Today: the consequence is stated before the commit,
     and a date inside the merge window corrects rather than adds. Only the
     start is recorded; flow is not invented for days nobody logged.
     ================================================================== */

  var pastStart = null; // chosen date, not yet committed

  function pastPeriodSection() {
    var cycles = E.Store.cycles();
    var body = [
      E.el("p", { class: "small faint", text: cycles.length
        ? cycles.length + " period start" + (cycles.length === 1 ? "" : "s") + " recorded, earliest " +
          E.prettyDate(cycles[0].start) + ". Add older ones one at a time; each is undoable."
        : "No period starts recorded yet. Three are enough for a first prediction." }),
      E.el("div", { class: "row" }, [
        E.el("input", {
          type: "date", class: "text-input", max: E.today(), value: pastStart || "",
          "aria-label": "Past period start date",
          onchange: function (e) { pastStart = e.target.value || null; E.refresh(); }
        })
      ])
    ];

    if (pastStart) {
      var pre = E.Store.previewPeriodStart(pastStart);
      body.push(E.el("p", { class: "small dim", text: pre.from
        ? (pre.from === pastStart ? "Already recorded." :
           "Corrects the existing start on " + E.prettyDate(pre.from) + " to " + E.prettyDate(pastStart) + " — within 7 days, so it is the same period.")
        : "Begins a new cycle at " + E.prettyDate(pastStart) + "." }));
      if (pre.predictionBefore !== pre.predictionAfter) {
        body.push(E.el("p", { class: "small" }, [
          E.el("span", { class: "est", text: "ESTIMATE" }),
          " Predicted next start: " + (pre.predictionBefore ? E.prettyDate(pre.predictionBefore) : "—") +
          " → " + (pre.predictionAfter ? E.prettyDate(pre.predictionAfter) : "—") + "."
        ]));
      }
      body.push(E.el("div", { class: "row" }, [
        E.el("button", {
          type: "button", class: "btn btn--accent", text: "ADD PERIOD START",
          disabled: pre.from === pastStart ? "" : null,
          onclick: function () {
            var key = pastStart;
            E.Store.setPeriodStart(key);
            // Cleared only if it landed; a refused future date keeps the field.
            if (E.Store.cycles().some(function (c) { return c.start === key; })) pastStart = null;
            E.refresh();
          }
        })
      ]));
    }
    return group("ADD A PAST PERIOD", body);
  }

  function downloadFallback(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename; a.style.display = "none";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  /* ==================================================================
     RENDER
     ================================================================== */

  function render() {
    var profile = E.Store.get().profile;
    return E.el("div", {}, [
      E.el("h1", { text: "SETTINGS", style: "margin-bottom:var(--s4)" }),
      profileSection(profile),
      contraceptionSection(profile),
      remindersSection(profile),
      lockSection(),
      appearanceSection(profile),
      tagsSection(profile),
      dataSection(),
      pastPeriodSection(),
      clueSection()
    ]);
  }

  var Settings = { id: "settings", title: "SETTINGS", render: render };
  window.Epok = window.Epok || {};
  window.Epok.Views = window.Epok.Views || {};

  window.Epok.Views.Settings = Settings;
})();

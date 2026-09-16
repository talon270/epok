/* ==========================================================================
   EPOK · IMPORT-CLUE

   Owner: Window C. See PLAN-epok.md § Parallel windows.

     · TOLERANT    reads the header row, guesses a mapping, shows it, lets the user fix it
     · UNVERIFIED  no sample Clue export exists on disk (A8). Says so in every parse() result.
     · DAY-LEVEL   writes flow/tags/bbt/lh/pill/note only — period starts stay a manual,
                   deliberate act (Today/Calendar), never inferred from a CSV row.

   Public namespace: Epok.Import
   ========================================================================== */

"use strict";

(function () {
  var UNVERIFIED_WARNING =
    "Clue's CSV export format has not been run through this parser — there is no sample file " +
    "on disk to verify it against. Check every column below before importing.";

  var FLOW_WORDS = { spotting: "spotting", spot: "spotting", light: "light", medium: "medium", heavy: "heavy" };

  /* Minimal RFC-4180 tokenizer: handles quoted fields, embedded commas, and
     "" as an escaped quote. Handles \r\n and bare \n. */
  function parseCSV(text) {
    var rows = [], row = [], field = "", i = 0, inQuotes = false;
    var s = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    while (i < s.length) {
      var c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    // Drop a single trailing blank line, which every editor adds.
    if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
    return rows;
  }

  function guessColumn(headers, pattern) {
    for (var i = 0; i < headers.length; i++) if (pattern.test(headers[i])) return i;
    return -1;
  }

  function guessMapping(headers) {
    var dateColumn = guessColumn(headers, /date|day\b/i);
    var flowColumn = guessColumn(headers, /flow|period|intensity|bleed/i);
    var tagColumns = [];
    for (var i = 0; i < headers.length; i++) if (i !== dateColumn && i !== flowColumn) tagColumns.push(i);
    return { dateColumn: dateColumn, flowColumn: flowColumn, tagColumns: tagColumns };
  }

  /* Tolerant of YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, DD-MM-YYYY. Ambiguous
     D/M vs M/D is resolved day-first (this app's locale — see context.md),
     unless the first number is >12, which settles it either way. */
  function parseDateCell(cell) {
    if (!cell) return null;
    var s = String(cell).trim();
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return pad(m[1], m[2], m[3]);
    m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (m) {
      var a = Number(m[1]), b = Number(m[2]);
      var day = a > 12 ? a : b > 12 ? b : a;   // day-first unless impossible
      var month = day === a ? b : a;
      return pad(m[3], month, day);
    }
    return null;
  }
  function pad(y, m, d) {
    return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  }

  function parseFlowCell(cell) {
    if (!cell) return null;
    var s = String(cell).trim().toLowerCase();
    for (var word in FLOW_WORDS) if (FLOW_WORDS.hasOwnProperty(word) && s.indexOf(word) >= 0) return FLOW_WORDS[word];
    return null;
  }

  function slug(header) {
    return String(header).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "column";
  }

  function truthy(cell) {
    if (cell == null) return false;
    var s = String(cell).trim().toLowerCase();
    return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "n";
  }

  function rowToDay(headers, mapping, row) {
    var key = mapping.dateColumn >= 0 ? parseDateCell(row[mapping.dateColumn]) : null;
    if (!key) return null;
    var day = { flow: null, tags: [], bbt: null, lh: null, pill: null, note: "" };
    if (mapping.flowColumn >= 0) day.flow = parseFlowCell(row[mapping.flowColumn]);
    (mapping.tagColumns || []).forEach(function (ci) {
      if (truthy(row[ci])) day.tags.push(slug(headers[ci]));
    });
    return { key: key, day: day };
  }

  /* ==================================================================
     PUBLIC
     ================================================================== */

  function parse(text) {
    var rows = parseCSV(text);
    if (!rows.length) return { headers: [], mapping: { dateColumn: -1, flowColumn: -1, tagColumns: [] }, rows: 0, preview: [], warnings: [UNVERIFIED_WARNING, "The file is empty."] };

    var headers = rows[0];
    var dataRows = rows.slice(1);
    var mapping = guessMapping(headers);
    var warnings = [UNVERIFIED_WARNING];
    if (mapping.dateColumn < 0) warnings.push("Could not guess which column is the date — pick one before importing.");
    if (mapping.flowColumn < 0) warnings.push("Could not guess a flow/intensity column. Flow will be left blank on every imported day unless you pick one.");

    var preview = [];
    for (var i = 0; i < dataRows.length && preview.length < 5; i++) {
      var r = rowToDay(headers, mapping, dataRows[i]);
      if (r) preview.push({ date: r.key, flow: r.day.flow, tags: r.day.tags, bbt: r.day.bbt, lh: r.day.lh, pill: r.day.pill, note: r.day.note });
    }

    return { headers: headers, mapping: mapping, rows: dataRows.length, preview: preview, warnings: warnings };
  }

  function apply(text, mapping) {
    var rows = parseCSV(text);
    if (rows.length < 2) return { added: 0, skipped: 0, error: "Nothing to import." };
    var headers = rows[0], dataRows = rows.slice(1);
    if (!mapping || mapping.dateColumn == null || mapping.dateColumn < 0) {
      return { added: 0, skipped: 0, error: "No date column is set — pick one before importing." };
    }

    var added = 0, skipped = 0;
    for (var i = 0; i < dataRows.length; i++) {
      var r = rowToDay(headers, mapping, dataRows[i]);
      if (!r) { skipped++; continue; }
      window.Epok.Store.editDay(r.key, r.day);
      added++;
    }
    return { added: added, skipped: skipped, error: null };
  }

  var Import = { UNVERIFIED_WARNING: UNVERIFIED_WARNING, parse: parse, apply: apply };

  window.Epok = window.Epok || {};
  window.Epok.Import = Import;
})();

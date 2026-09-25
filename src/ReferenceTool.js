/*
 * Workpaper Reference Tool for Adobe Acrobat Pro
 * ------------------------------------------------
 * Folder-level JavaScript add-on. Copy this file into Acrobat's
 * JavaScripts folder (see README.md) and restart Acrobat.
 *
 * Features
 *   - Reference    : click a figure, then its match; numbers run on
 *                    automatically (A-1, A-2, ...). Clicking either tag
 *                    jumps to its match. The jump works in any copy of
 *                    Acrobat / Reader, even without this add-on installed.
 *   - Calc Tape    : a calculator whose tape is posted onto the PDF as a
 *                    comment for the reviewer.
 *   - Tag Check    : lists every tag and flags unmatched / broken ones.
 *   - Replace Page : swaps a page for a new version and puts the tags and
 *                    tapes that were on it back.
 *   - Repair Tags  : rebuilds anything lost (e.g. after using Acrobat's own
 *                    Replace Pages command) from a register kept in the PDF.
 *   - Move Tag / Delete Tag
 *
 * Written for the Acrobat JavaScript engine (ES5).
 */

// ---------------------------------------------------------------------------
// Privileged helpers. These must be defined at the top level of a
// folder-level script so Acrobat trusts them.
// ---------------------------------------------------------------------------
var ART_privBrowseForDoc = app.trustedFunction(function () {
    app.beginPriv();
    var r = app.browseForDoc({ bSave: false });
    app.endPriv();
    return r;
});

var ART_privReplacePages = app.trustedFunction(function (doc, opts) {
    app.beginPriv();
    doc.replacePages(opts);
    app.endPriv();
});

var ART_privHttpGet = app.trustedFunction(function (url, onDone) {
    app.beginPriv();
    Net.HTTP.request({
        cVerb: "GET",
        cURL: url,
        aHeaders: [
            { name: "User-Agent", value: "ReferenceTool-Acrobat" },
            { name: "Accept", value: "application/vnd.github+json" }
        ],
        oHandler: {
            response: function (msg, uri, err) {
                var body = null;
                if (!err && msg) {
                    try { body = SOAP.stringFromStream(msg); } catch (e) { err = e; }
                }
                onDone(err || null, body);
            }
        }
    });
    app.endPriv();
});

var ART_privLaunchURL = app.trustedFunction(function (url) {
    app.beginPriv();
    app.launchURL(url, true);
    app.endPriv();
});

// The open PDFs, for the tape watcher (needs privilege to see them all).
var ART_privActiveDocs = app.trustedFunction(function () {
    app.beginPriv();
    var d = app.activeDocs;
    app.endPriv();
    return d;
});

var ART_timer = null;
var ART_followTimer = null; // reference mode / calculator: follows the page being viewed
var ART_laterTimer = null;  // runs work just after a button or keystroke event has finished
var ART_watchTimer = null;  // tape watcher

var ARTool = (function () {
    var VERSION = "0.4.0";
    var REPO = "PhilipBanks0/Adobe-reference-tool";
    var RELEASES_URL = "https://github.com/" + REPO + "/releases/latest";
    var LATEST_API = "https://api.github.com/repos/" + REPO + "/releases/latest";
    var REG_KEY = "ARTRegister";
    var CAPTURE_FIELD = "ART_CAPTURE";
    var TAG_PREFIX = "ART:T:";
    var TAPE_PREFIX = "ART:P:";

    var cfg = {
        defaultPrefix: "A-",
        tagFontSize: 8,
        tapeFontSize: 8,
        tagText: ["RGB", 0.8, 0, 0],
        tagFill: ["RGB", 1, 1, 0.8],
        tagBorder: ["RGB", 0.8, 0, 0],
        tapeFill: ["RGB", 1, 1, 1],
        tapeBorder: ["RGB", 0, 0.3, 0.7],
        // If clicks land in the wrong vertical spot during testing,
        // flip this to true (some Acrobat builds measure mouseY from the top).
        mouseYFromTop: false,
        // Quietly check GitHub for a newer release when Acrobat starts
        // (at most once every checkIntervalDays). Set false to turn off.
        autoUpdateCheck: true,
        checkIntervalDays: 7
    };

    var capture = null; // active click-capture state

    // -----------------------------------------------------------------------
    // Small utilities
    // -----------------------------------------------------------------------
    function trim(s) { return String(s).replace(/^\s+|\s+$/g, ""); }

    function toJSON(o) { return JSON.stringify(o); }

    function fromJSON(s) {
        try { return JSON.parse(s); } catch (e) { return null; }
    }

    function copyRect(r) { return [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3])]; }

    function pad(s, n, left) {
        s = String(s);
        while (s.length < n) { s = left ? " " + s : s + " "; }
        return s;
    }

    function today() {
        var d = new Date();
        function two(n) { return n < 10 ? "0" + n : "" + n; }
        return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate());
    }

    function getGlobal(key, dflt) {
        try { if (typeof global[key] !== "undefined") { return global[key]; } } catch (e) {}
        return dflt;
    }

    function setGlobal(key, val) {
        try { global[key] = val; global.setPersistent(key, true); } catch (e) {}
    }

    /** Show a tip once, with a "don't show again" checkbox. */
    function tip(key, msg) {
        if (getGlobal("ART_hide_" + key, false)) { return; }
        var cb = { cMsg: "Don't show this again", bInitialValue: false };
        app.alert({ cMsg: msg, nIcon: 3, cTitle: "Reference Tool", oCheckbox: cb });
        if (cb.bAfterValue) { setGlobal("ART_hide_" + key, true); }
    }

    // -----------------------------------------------------------------------
    // Number formatting & tape maths (pure functions)
    // -----------------------------------------------------------------------
    function fmt(n) {
        var neg = n < 0;
        var s = (Math.round(Math.abs(n) * 100) / 100).toFixed(2);
        var parts = s.split(".");
        var i = parts[0];
        var out = "";
        while (i.length > 3) { out = "," + i.slice(-3) + out; i = i.slice(0, -3); }
        out = i + out + "." + parts[1];
        return neg ? "(" + out + ")" : out + " ";
    }

    /** Parse "1,234.50", "(800)", "$12", "-5", "5%" -> number or null. */
    function parseAmount(tok) {
        var s = String(tok).replace(/[\s$,]/g, "");
        var neg = false;
        var pct = false;
        if (s.charAt(0) === "-") { neg = !neg; s = s.slice(1); }
        if (/^\(.*\)$/.test(s)) { neg = !neg; s = s.slice(1, -1); }
        if (s.charAt(0) === "-") { neg = !neg; s = s.slice(1); }
        if (s.charAt(s.length - 1) === "%") { pct = true; s = s.slice(0, -1); }
        if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) { return null; }
        var v = parseFloat(s);
        if (pct) { v = v / 100; }
        return neg ? -v : v;
    }

    /** A number as typed on the tape: 1,250 / 1.05 / 0.05 (no forced decimals). */
    function fmtNum(v) {
        var neg = v < 0;
        var s = String(Math.round(Math.abs(v) * 1e6) / 1e6);
        if (/e/i.test(s)) { s = Math.abs(v).toFixed(6).replace(/\.?0+$/, ""); }
        var parts = s.split(".");
        var i = parts[0];
        var out = "";
        while (i.length > 3) { out = "," + i.slice(-3) + out; i = i.slice(0, -3); }
        return (neg ? "-" : "") + i + out + (parts[1] ? "." + parts[1] : "");
    }

    // One amount: 1,250.00  (800)  -800  $12  5%  .5
    var AMT = "-?\\(?\\$?\\s*(?:\\d[\\d,]*\\.?\\d*|\\.\\d+)\\)?%?";
    // Multiply / divide: x * / and the × ÷ signs
    var MULOP = "[xX*\\/\\u00d7\\u00f7]";
    var EMPTY_TAPE = "Enter at least one amount.";

    function normMul(op) { return (op === "/" || op === "÷") ? "/" : "*"; }

    /**
     * Read "250 x 12 Rent" -> factors [250, x12] and the description "Rent".
     * Returns null when the text doesn't start with an amount.
     */
    function parseExpr(text) {
        var s = String(text);
        var m = s.match(new RegExp("^\\s*(" + AMT + ")"));
        var v = m ? parseAmount(m[1]) : null;
        if (v === null) { return null; }
        var factors = [{ op: "*", value: v }];
        var rest = s.slice(m[0].length);
        var step = new RegExp("^\\s*(" + MULOP + ")\\s*(" + AMT + ")");
        while (true) {
            var k = rest.match(step);
            var fv = k ? parseAmount(k[2]) : null;
            if (fv === null) { break; }
            factors.push({ op: normMul(k[1]), value: fv });
            rest = rest.slice(k[0].length);
        }
        return { factors: factors, rest: trim(rest) };
    }

    function exprText(factors) {
        var out = "";
        for (var i = 0; i < factors.length; i++) {
            if (i) { out += factors[i].op === "/" ? " / " : " x "; }
            out += fmtNum(factors[i].value);
        }
        return out;
    }

    /**
     * Parse tape entries, one per line:
     *   [op] amount [x amount ...] [description]
     * op is one of + - * x / (default +). "=" or "sub" on its own line
     * inserts a subtotal. "250 x 12 Rent" adds 3,000 (like an adding
     * machine); a line that starts with x or / multiplies or divides the
     * running total. Returns {rows, total, errors}.
     */
    function computeTape(text) {
        var lines = String(text || "").split(/\r\n|\r|\n/);
        var rows = [];
        var errors = [];
        var total = 0;
        var started = false;
        for (var i = 0; i < lines.length; i++) {
            var line = trim(lines[i]);
            if (!line) { continue; }
            var sub = line.match(/^(=|subtotal\b|sub\b)\s*(.*)$/i);
            if (sub) {
                rows.push({ op: "=", value: total, desc: trim(sub[2]) || "Subtotal" });
                continue;
            }
            var op = "+";
            var m = line.match(/^([+\-*\/xX×÷])(?=[\s\d.($-])\s*(.*)$/);
            if (m) {
                op = m[1];
                if (op === "x" || op === "X" || op === "×") { op = "*"; }
                if (op === "÷") { op = "/"; }
                line = m[2];
            }
            var ex = parseExpr(line);
            if (!ex) {
                errors.push("Line " + (i + 1) + ": can't read an amount in \"" + trim(lines[i]) + "\"");
                continue;
            }
            var val = ex.factors[0].value;
            var zero = false;
            for (var f = 1; f < ex.factors.length; f++) {
                if (ex.factors[f].op === "/") {
                    if (ex.factors[f].value === 0) { zero = true; break; }
                    val /= ex.factors[f].value;
                } else {
                    val *= ex.factors[f].value;
                }
            }
            if (zero) { errors.push("Line " + (i + 1) + ": divide by zero"); continue; }
            val = Math.round(val * 1e6) / 1e6;
            if (!started && (op === "*" || op === "/")) {
                errors.push("Line " + (i + 1) + ": the first entry can't be a multiply or divide");
                continue;
            }
            if (op === "+") { total += val; }
            else if (op === "-") { total -= val; }
            else if (op === "*") { total *= val; }
            else if (op === "/") {
                if (val === 0) { errors.push("Line " + (i + 1) + ": divide by zero"); continue; }
                total /= val;
            }
            started = true;
            // round away floating point noise
            total = Math.round(total * 1e6) / 1e6;
            var row = { op: op, value: val, desc: ex.rest };
            if (ex.factors.length > 1) { row.expr = ex.factors; }
            rows.push(row);
        }
        if (!rows.length && !errors.length) { errors.push(EMPTY_TAPE); }
        return { rows: rows, total: total, errors: errors };
    }

    /** Errors other than "the tape is empty". */
    function realErrors(calc) {
        var out = [];
        for (var i = 0; i < calc.errors.length; i++) { if (calc.errors[i] !== EMPTY_TAPE) { out.push(calc.errors[i]); } }
        return out;
    }

    /** Render a computed tape as monospaced text. */
    function formatTape(title, calc, initials) {
        var nums = [];
        var i;
        for (i = 0; i < calc.rows.length; i++) {
            var r = calc.rows[i];
            nums.push(r.op === "*" || r.op === "/" ? fmtNum(r.value) : fmt(r.value));
        }
        var totalStr = fmt(calc.total);
        var w = totalStr.length;
        for (i = 0; i < nums.length; i++) { if (nums[i].length > w) { w = nums[i].length; } }
        w += 2;
        var out = [];
        out.push("TAPE" + (title ? ": " + trim(title) : ""));
        for (i = 0; i < calc.rows.length; i++) {
            var row = calc.rows[i];
            var sym = row.op === "=" ? "S" : (row.op === "*" ? "x" : row.op);
            if (row.op === "=") {
                out.push(pad(pad("", w - 2).replace(/ /g, "-"), w, true));
            }
            var desc = row.expr ? exprText(row.expr) + (row.desc ? "  " + row.desc : "") : row.desc;
            out.push(pad(nums[i], w, true) + " " + sym + (desc ? "  " + desc : ""));
        }
        out.push(pad("", w + 2).replace(/ /g, "="));
        out.push(pad(totalStr, w, true) + " T  Total");
        out.push("Prepared" + (initials ? " by " + trim(initials) : "") + " " + today());
        return out.join("\n");
    }

    /**
     * Read a posted tape back into its title, lines and initials, for tapes
     * whose lines weren't saved in the register (made before 0.4.0, or
     * carried in from another PDF). Returns null if it isn't a tape.
     */
    function parseTapeText(text) {
        var lines = String(text || "").split(/\r\n|\r|\n/);
        var head = trim(lines[0] || "").match(/^TAPE(?::\s*(.*))?$/);
        if (!head) { return null; }
        var out = { titl: head[1] ? trim(head[1]) : "", ents: "", init: "" };
        var ents = [];
        for (var i = 1; i < lines.length; i++) {
            var line = lines[i];
            if (/^\s*[-=]+\s*$/.test(line)) { continue; }
            var prep = trim(line).match(/^Prepared(?: by (.*?))?\s+\d{4}-\d\d-\d\d$/);
            if (prep) { out.init = prep[1] ? trim(prep[1]) : ""; continue; }
            var m = line.match(/^\s*(\S+)\s+([+\-x\/ST])(?:\s\s(.*))?$/);
            if (!m) { continue; }
            var num = m[1];
            var sym = m[2];
            var desc = m[3] ? trim(m[3]) : "";
            if (sym === "T") { continue; }
            if (sym === "S") { ents.push(desc && desc !== "Subtotal" ? "= " + desc : "="); continue; }
            var shown = parseAmount(num);
            var body = num + (desc ? " " + desc : "");
            // A multiplication row shows its working in the description: "3,000.00 +  250 x 12  Rent".
            var ex = desc ? parseExpr(desc) : null;
            if (ex && ex.factors.length > 1 && shown !== null) {
                var v = ex.factors[0].value;
                for (var f = 1; f < ex.factors.length; f++) { v = ex.factors[f].op === "/" ? v / ex.factors[f].value : v * ex.factors[f].value; }
                var tol = (sym === "+" || sym === "-") ? 0.006 : 1e-6;
                if (Math.abs(v - shown) < tol) { body = trim(desc.slice(0, desc.length - ex.rest.length)) + (ex.rest ? " " + ex.rest : ""); }
            }
            if (sym === "+") { ents.push(body); }
            else if (sym === "-") { ents.push(/^-/.test(body) ? "- " + body : "-" + body); }
            else { ents.push(sym + " " + body); }
        }
        out.ents = ents.join("\n");
        return out;
    }

    /**
     * What an operator key does in the calculator's Amount box, like an
     * adding machine. `val` is what's in the box, `key` one of + - * /.
     *   1,250  +   -> adds 1,250            800  -   -> subtracts 800
     *   250    *   -> "250 x " (waits for the next number: 250 x 12 is added)
     *   (empty) * 1.05 +  -> multiplies the running total by 1.05
     * Returns {line, next} (line to add, if any, and the new box text), or
     * null when the key should just be typed (e.g. the "/" in "O/S").
     */
    function calcKeyAction(val, key) {
        var s = trim(val);
        if (!s) { return null; }
        var mul = (key === "*" || key === "/");
        var sym = key === "/" ? "/" : "x";
        // An operation on the running total: "x", "x 1.05", "/ 12"
        var pm = s.match(new RegExp("^(" + MULOP + ")\\s*(" + AMT + ")?$"));
        if (pm) {
            if (!pm[2]) { return mul ? { line: null, next: sym + " " } : null; }
            return { line: (normMul(pm[1]) === "/" ? "/ " : "x ") + trim(pm[2]), next: mul ? sym + " " : "" };
        }
        // An amount, or amounts multiplied together, maybe still waiting for the next number
        var em = s.match(new RegExp("^(?:\\+\\s*)?(" + AMT + "(?:\\s*" + MULOP + "\\s*" + AMT + ")*)(\\s*" + MULOP + ")?$"));
        if (!em) { return null; }
        var expr = trim(em[1]);
        if (em[2]) { return mul ? { line: null, next: expr + " " + sym + " " } : null; }
        if (mul) { return { line: null, next: expr + " " + sym + " " }; }
        if (key === "+") { return { line: expr, next: "" }; }
        return { line: (expr.charAt(0) === "-" ? "- " : "-") + expr, next: "" };
    }

    // -----------------------------------------------------------------------
    // Register (stored as JSON in the PDF's document properties)
    // -----------------------------------------------------------------------
    function newRegister() {
        return { v: 1, next: 1, prefix: cfg.defaultPrefix, pending: null, items: {} };
    }

    function loadReg(doc) {
        var s = null;
        try { s = doc.info[REG_KEY]; } catch (e) {}
        var r = s ? fromJSON(s) : null;
        if (!r || typeof r !== "object") { r = newRegister(); }
        if (!r.items) { r.items = {}; }
        if (!r.prefix) { r.prefix = cfg.defaultPrefix; }
        if (!r.next) { r.next = 1; }
        return r;
    }

    function saveReg(doc, reg) {
        try { doc.info[REG_KEY] = toJSON(reg); } catch (e) {}
    }

    function tagName(label, side) { return TAG_PREFIX + label + ":" + side; }

    function parseName(name) {
        if (!name) { return null; }
        if (name.indexOf(TAG_PREFIX) === 0) {
            var rest = name.slice(TAG_PREFIX.length);
            var k = rest.lastIndexOf(":");
            if (k < 1) { return null; }
            return { kind: "tag", label: rest.slice(0, k), side: Number(rest.slice(k + 1)) };
        }
        if (name.indexOf(TAPE_PREFIX) === 0) { return { kind: "tape", id: name.slice(TAPE_PREFIX.length) }; }
        return null;
    }

    function isArt(a) { return !!parseName(a && a.name); }

    // -----------------------------------------------------------------------
    // Annotation queries
    // -----------------------------------------------------------------------
    function getAnnots(doc, page) {
        try { doc.syncAnnotScan(); } catch (e) {}
        var a = null;
        try { a = (page === undefined) ? doc.getAnnots() : doc.getAnnots({ nPage: page }); } catch (e2) {}
        return a || [];
    }

    function artAnnots(doc, page) {
        var all = getAnnots(doc, page);
        var out = [];
        for (var i = 0; i < all.length; i++) { if (isArt(all[i])) { out.push(all[i]); } }
        return out;
    }

    function findAnnot(doc, name) {
        var all = getAnnots(doc);
        for (var i = 0; i < all.length; i++) { if (all[i].name === name) { return all[i]; } }
        return null;
    }

    /**
     * Bring the register up to date with what is actually in the document.
     * Adopts tags/tapes it has not seen (e.g. tapes carried in by Combine
     * Files) and records current positions. Returns a map name -> annot.
     */
    function sync(doc, reg) {
        var present = {};
        var arts = artAnnots(doc);
        for (var i = 0; i < arts.length; i++) {
            var a = arts[i];
            var p = parseName(a.name);
            present[a.name] = a;
            var item = reg.items[a.name] || {};
            item.kind = p.kind;
            item.page = a.page;
            item.rect = copyRect(a.rect);
            if (p.kind === "tag") {
                item.label = p.label;
                item.side = p.side;
                var m = p.label.match(/^(.*?)(\d+)$/);
                if (m && m[1] === reg.prefix && Number(m[2]) >= reg.next) { reg.next = Number(m[2]) + 1; }
            } else {
                item.contents = a.contents;
                if (Number(a.textSize) > 0) { item.fs = Number(a.textSize); }
            }
            reg.items[a.name] = item;
        }
        if (reg.pending) {
            var s1 = present[tagName(reg.pending, 1)];
            var s2 = present[tagName(reg.pending, 2)];
            if (!s1 || s2) { reg.pending = null; }
        }
        return present;
    }

    // -----------------------------------------------------------------------
    // Coordinates. Annotations and mouse positions use default user space;
    // links and form fields use rotated user space.
    // -----------------------------------------------------------------------
    function pageGeom(doc, page) {
        var rot = 0;
        var box = [0, 792, 612, 0];
        try { rot = doc.getPageRotation(page) || 0; } catch (e) {}
        try { box = doc.getPageBox("Media", page); } catch (e2) {}
        var W = Math.abs(box[2] - box[0]);
        var H = Math.abs(box[1] - box[3]);
        rot = ((rot % 360) + 360) % 360;
        var w = (rot === 90 || rot === 270) ? H : W;
        var h = (rot === 90 || rot === 270) ? W : H;
        return { rot: rot, w: w, h: h };
    }

    function toRotatedPt(g, x, y) {
        if (g.rot === 90) { return [y, g.w - x]; }
        if (g.rot === 180) { return [g.w - x, g.h - y]; }
        if (g.rot === 270) { return [g.h - y, x]; }
        return [x, y];
    }

    function toRotatedRect(doc, page, r) {
        var g = pageGeom(doc, page);
        var a = toRotatedPt(g, r[0], r[1]);
        var b = toRotatedPt(g, r[2], r[3]);
        return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    }

    function grow(r, d) { return [r[0] - d, r[1] - d, r[2] + d, r[3] + d]; }

    function clampRect(doc, page, r) {
        var g = pageGeom(doc, page);
        var w = r[2] - r[0];
        var h = r[3] - r[1];
        var x = Math.max(0, Math.min(r[0], g.w - w));
        var y = Math.max(0, Math.min(r[1], g.h - h));
        return [x, y, x + w, y + h];
    }

    // -----------------------------------------------------------------------
    // Building tags, links and tapes
    // -----------------------------------------------------------------------
    function tagSize(label) {
        var fs = TAG_SIZES[currentStyle().size] || cfg.tagFontSize;
        var h = fs + 6;
        var w = Math.max(20, label.length * fs * 0.62 + 10);
        return [w, h];
    }

    function tagRectAt(label, cx, cy) {
        var s = tagSize(label);
        return [cx - s[0] / 2, cy - s[1] / 2, cx + s[0] / 2, cy + s[1] / 2];
    }

    /** Script stored in each tag's link. Self-contained: needs no add-on. */
    function linkScript(label, targetSide) {
        var target = tagName(label, targetSide);
        var missing = "The matching tag " + label + " was not found in this document.";
        return "(function(d){var t=" + JSON.stringify(target) + ";" +
            "try{d.syncAnnotScan();}catch(e){}" +
            "var a=d.getAnnots();" +
            "if(a){for(var i=0;i<a.length;i++){if(a[i].name==t){" +
            "var r=a[i].rect;d.pageNum=a[i].page;" +
            "try{d.scroll(r[0]-72,r[3]+72);}catch(e){}" +
            "return;}}}" +
            "app.alert(" + JSON.stringify(missing) + ",1);})(this);";
    }

    function removeLinkAt(doc, page, rotRect) {
        try { doc.removeLinks(page, grow(rotRect, 0.5)); } catch (e) {}
    }

    /** (Re)create the clickable link that sits on top of a tag. */
    function rebuildLink(doc, annot, reg) {
        var p = parseName(annot.name);
        if (!p || p.kind !== "tag") { return; }
        var item = reg.items[annot.name] || {};
        var rr = toRotatedRect(doc, annot.page, annot.rect);
        if (item.linkRect && item.linkPage === annot.page) { removeLinkAt(doc, item.linkPage, item.linkRect); }
        removeLinkAt(doc, annot.page, rr);
        var l = doc.addLink(annot.page, rr);
        try { l.borderWidth = 0; } catch (e) {}
        try { l.highlightMode = "Invert"; } catch (e2) {}
        l.setAction(linkScript(p.label, p.side === 1 ? 2 : 1));
        item.linkRect = rr;
        item.linkPage = annot.page;
        reg.items[annot.name] = item;
    }

    function addTag(doc, reg, label, side, page, rect, style) {
        style = style || { color: "Red", size: "Medium" };
        var colr = TAG_COLORS[style.color] || TAG_COLORS.Red;
        var fontSize = TAG_SIZES[style.size] || cfg.tagFontSize;
        rect = clampRect(doc, page, rect);
        var a = doc.addAnnot({
            type: "FreeText",
            page: page,
            rect: rect,
            name: tagName(label, side),
            author: "Reference Tool",
            subject: "Reference tag",
            contents: label,
            fillColor: colr.fill,
            strokeColor: colr.text,
            width: 0.75,
            textFont: "Helvetica-Bold",
            textSize: fontSize,
            alignment: 1
        });
        try {
            var sp = {};
            sp.text = label;
            sp.textColor = colr.text;
            sp.textSize = fontSize;
            sp.fontWeight = 700;
            sp.alignment = "center";
            a.richContents = [sp];
        } catch (e) {}
        try { a.print = true; } catch (e2) {}
        // Read-only so clicks pass through to the link underneath.
        try { a.readOnly = true; } catch (e3) {}
        reg.items[a.name] = { kind: "tag", label: label, side: side, page: page, rect: copyRect(a.rect), style: style };
        rebuildLink(doc, a, reg);
        return a;
    }

    // -----------------------------------------------------------------------
    // Tapes. A tape is a FreeText comment in Courier. Its font size follows
    // the box: resize the box and the text is re-fitted so nothing is cut
    // off. An invisible button over its figures catches a double-click to
    // edit it; the title line and edges are left clear so the tape can
    // still be selected, dragged and resized.
    // -----------------------------------------------------------------------
    var TBTN = "ART_TBTN";
    var TAPE_PAD_W = 12;
    var TAPE_PAD_H = 10;
    var TAPE_MIN_FS = 4;
    var TAPE_MAX_FS = 40;

    function tapeMetrics(text) {
        var lines = String(text).split(/\r\n|\r|\n/);
        var longest = 1;
        for (var i = 0; i < lines.length; i++) { if (lines[i].length > longest) { longest = lines[i].length; } }
        return { cols: longest, rows: lines.length };
    }

    function tapeSize(text, fs) {
        fs = fs || cfg.tapeFontSize;
        var m = tapeMetrics(text);
        return [m.cols * fs * 0.6 + TAPE_PAD_W, m.rows * fs * 1.2 + TAPE_PAD_H];
    }

    function roundFs(f) {
        if (!(f > 0)) { f = TAPE_MIN_FS; }
        f = Math.floor(f * 4 + 1e-6) / 4; // quarter points, never bigger than the box
        return Math.max(TAPE_MIN_FS, Math.min(TAPE_MAX_FS, f));
    }

    /**
     * After the tape's box was resized to W x H: the font size that makes the
     * text fill it. how = "resized" follows the side dragged furthest (drag
     * any edge and the whole tape scales); "fit" makes it fit inside the box.
     * Returns {fs, w, h, changed}.
     */
    function refitTape(text, fs0, W, H, how) {
        fs0 = fs0 || cfg.tapeFontSize;
        var ideal = tapeSize(text, fs0);
        if (Math.abs(W - ideal[0]) <= 1 && Math.abs(H - ideal[1]) <= 1) {
            return { fs: fs0, w: ideal[0], h: ideal[1], changed: false };
        }
        var m = tapeMetrics(text);
        var fw = (W - TAPE_PAD_W) / (m.cols * 0.6);
        var fh = (H - TAPE_PAD_H) / (m.rows * 1.2);
        var f;
        if (how === "resized" && fw > 0 && fh > 0) {
            f = Math.abs(Math.log(fw / fs0)) >= Math.abs(Math.log(fh / fs0)) ? fw : fh;
        } else {
            f = Math.min(fw, fh);
        }
        f = roundFs(f);
        var s = tapeSize(text, f);
        return { fs: f, w: s[0], h: s[1], changed: true };
    }

    function tapeFs(a, reg) {
        var fs = Number(a && a.textSize);
        if (fs > 0) { return fs; }
        var it = reg && a && reg.items[a.name];
        return (it && it.fs) || cfg.tapeFontSize;
    }

    function setTapeText(a, text, fs) {
        try { a.textSize = fs; } catch (e0) {}
        a.contents = text;
        try {
            var sp = {};
            sp.text = text;
            sp.fontFamily = ["Courier", "monospace"];
            sp.textSize = fs;
            sp.textColor = ["RGB", 0, 0, 0];
            a.richContents = [sp];
        } catch (e) {}
    }

    function tapeBtnName(name) { return TBTN + "." + name.slice(TAPE_PREFIX.length); }

    /** The part of a tape the double-click button covers: below the title line, inside the edges. */
    function tapeBodyRect(r, fs) {
        var m = 5;
        var b = [r[0] + m, r[1] + m, r[2] - m, r[3] - TAPE_PAD_H / 2 - fs * 1.2];
        if (b[2] - b[0] < 4 || b[3] - b[1] < 4) { return null; }
        return b;
    }

    function sameBox(a, b) {
        if (!a || !b) { return false; }
        var x = [Math.min(a[0], a[2]), Math.min(a[1], a[3]), Math.max(a[0], a[2]), Math.max(a[1], a[3])];
        var y = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
        for (var i = 0; i < 4; i++) { if (Math.abs(x[i] - y[i]) > 0.5) { return false; } }
        return true;
    }

    /** Remove double-click buttons whose tape has gone (deleted with the Delete key, say). */
    function cleanTapeButtons(doc, present) {
        var names = fieldNames(doc);
        for (var i = 0; i < names.length; i++) {
            if (names[i].indexOf(TBTN + ".") !== 0) { continue; }
            if (!present[TAPE_PREFIX + names[i].slice(TBTN.length + 1)]) {
                try { doc.removeField(names[i]); } catch (e) {}
            }
        }
    }

    function removeTapeButton(doc, name) {
        var nm = tapeBtnName(name);
        try { if (doc.getField(nm)) { doc.removeField(nm); } } catch (e) {}
    }

    /** Put the invisible double-click button over a tape's figures, or move it to where the tape is now. */
    function ensureTapeButton(doc, a, fs) {
        var nm = tapeBtnName(a.name);
        var body = tapeBodyRect(copyRect(a.rect), fs || tapeFs(a));
        var f = null;
        try { f = doc.getField(nm); } catch (e) {}
        // Two tapes with the same name (pages inserted from a copy of the work paper) share
        // one button with a widget on each: leave it be rather than take it off one of them.
        if (f && typeof f.page === "object") { return false; }
        if (f && (!body || f.page !== a.page)) { removeTapeButton(doc, a.name); f = null; }
        if (!body) { return !!f; }
        var rr = toRotatedRect(doc, a.page, body);
        var box = [rr[0], rr[3], rr[2], rr[1]]; // upper-left, lower-right
        if (f) {
            if (sameBox(f.rect, box)) { return false; }
            f.rect = box;
            return true;
        }
        f = doc.addField(nm, "button", a.page, box);
        try { f.borderStyle = border.s; } catch (e1) {}
        try { f.lineWidth = 0; } catch (e2) {}
        try { f.strokeColor = color.transparent; } catch (e3) {}
        try { f.fillColor = color.transparent; } catch (e4) {}
        try { f.highlight = highlight.n; } catch (e5) {}
        try { f.display = display.noPrint; } catch (e6) {}
        try { f.userName = "Double-click to change this tape. Drag it by its title line or edge to move it; drag a corner to resize it."; } catch (e7) {}
        f.setAction("MouseUp", "if(typeof ARTool!=='undefined'){ARTool._tapeClick(this," + JSON.stringify(a.name) +
            ",event.target.page,this.mouseX,this.mouseY);}");
        return true;
    }

    function addTape(doc, reg, page, rect, text, name, opts) {
        opts = opts || {};
        var fs = opts.fs || cfg.tapeFontSize;
        rect = clampRect(doc, page, rect);
        name = name || (TAPE_PREFIX + new Date().getTime().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
        var a = doc.addAnnot({
            type: "FreeText",
            page: page,
            rect: rect,
            name: name,
            author: "Reference Tool",
            subject: "Calculator tape",
            contents: text,
            fillColor: cfg.tapeFill,
            strokeColor: cfg.tapeBorder,
            width: 1,
            textFont: "Courier",
            textSize: fs,
            alignment: 0
        });
        setTapeText(a, text, fs);
        try { a.print = true; } catch (e2) {}
        var item = { kind: "tape", page: page, rect: copyRect(a.rect), contents: text, fs: fs };
        if (opts.src) { item.src = opts.src; item.made = opts.made || text; }
        reg.items[a.name] = item;
        try { ensureTapeButton(doc, a, fs); } catch (e3) {}
        remember(doc, a);
        return a;
    }

    /** Change a tape's figures in place: same spot, same text size, box sized to the new text. */
    function updateTape(doc, reg, a, text, src) {
        var fs = tapeFs(a, reg);
        var r = copyRect(a.rect);
        var s = tapeSize(text, fs);
        setTapeText(a, text, fs);
        a.rect = clampRect(doc, a.page, [r[0], r[3] - s[1], r[0] + s[0], r[3]]);
        reg.items[a.name] = { kind: "tape", page: a.page, rect: copyRect(a.rect), contents: text, fs: fs, src: src, made: text };
        try { ensureTapeButton(doc, a, fs); } catch (e) {}
        remember(doc, a);
    }

    /** Re-create a tag or tape from its register entry. */
    function restoreItem(doc, reg, name, item, page) {
        var pg = (page === undefined) ? item.page : page;
        if (item.kind === "tag") { return addTag(doc, reg, item.label, item.side, pg, item.rect, item.style); }
        return addTape(doc, reg, pg, item.rect, item.contents, name, { fs: item.fs, src: item.src, made: item.made });
    }

    function destroyArt(doc, reg, annot) {
        var item = reg.items[annot.name];
        if (item && item.kind === "tag") {
            if (item.linkRect && item.linkPage === annot.page) { removeLinkAt(doc, item.linkPage, item.linkRect); }
            removeLinkAt(doc, annot.page, toRotatedRect(doc, annot.page, annot.rect));
        }
        var p = parseName(annot.name);
        if (p && p.kind === "tape") { removeTapeButton(doc, annot.name); }
        // Tags are read-only (so clicks reach the link); Acrobat won't delete a
        // read-only annotation until that's switched off.
        try { annot.readOnly = false; } catch (e1) {}
        try { annot.lock = false; } catch (e2) {}
        annot.destroy();
    }

    // -----------------------------------------------------------------------
    // Tape watcher. A light timer looks at the page being viewed in each open
    // PDF: when a tape's box has been resized it re-fits the text, and it
    // keeps each tape's double-click button over the tape as it's moved.
    // -----------------------------------------------------------------------
    var watch = { docs: [], seen: {}, pages: {}, tidied: {}, busy: false };

    function docKey(doc) {
        var k = null;
        try { k = doc.path; } catch (e) {}
        if (!k) { try { k = doc.documentFileName; } catch (e2) {} }
        return String(k || "doc");
    }

    function rememberDoc(doc) {
        if (!doc) { return; }
        for (var i = 0; i < watch.docs.length; i++) { if (watch.docs[i] === doc) { return; } }
        watch.docs.push(doc);
        if (watch.docs.length > 30) { watch.docs.shift(); }
    }

    /** Note a tape's box and text as current, so the watcher leaves it alone. */
    function remember(doc, a) {
        rememberDoc(doc);
        watch.seen[docKey(doc) + "|" + a.name] = { r: String(copyRect(a.rect)), c: String(a.contents) };
    }

    function watchedDocs() {
        var d = null;
        try { d = ART_privActiveDocs(); } catch (e) {}
        if (d && d.length) {
            for (var i = 0; i < d.length; i++) { rememberDoc(d[i]); }
        }
        return watch.docs.slice();
    }

    function forgetDoc(doc) {
        for (var i = 0; i < watch.docs.length; i++) {
            if (watch.docs[i] === doc) { watch.docs.splice(i, 1); return; }
        }
    }

    /** Re-fit one tape if its box or text changed, and keep its button on it. Returns true if the register changed. */
    function watchTape(doc, reg, a) {
        var key = docKey(doc) + "|" + a.name;
        var prev = watch.seen[key];
        var r = copyRect(a.rect);
        var text = String(a.contents || "");
        if (prev && prev.r === String(r) && prev.c === text) { return false; }
        var fs = tapeFs(a, reg);
        var how = !prev ? "fit" : (prev.c !== text && prev.r === String(r) ? "text" : "resized");
        var fit;
        if (how === "text") {
            // The text was edited: keep the size, grow or shrink the box.
            var s = tapeSize(text, fs);
            fit = { fs: fs, w: s[0], h: s[1], changed: Math.abs(s[0] - (r[2] - r[0])) > 1 || Math.abs(s[1] - (r[3] - r[1])) > 1 };
        } else {
            fit = refitTape(text, fs, r[2] - r[0], r[3] - r[1], how);
        }
        var changed = false;
        // A protected PDF refuses changes: remember the tape anyway so it isn't retried every tick.
        if (fit.changed) {
            try {
                if (fit.fs !== fs) { setTapeText(a, text, fit.fs); }
                a.rect = clampRect(doc, a.page, [r[0], r[3] - fit.h, r[0] + fit.w, r[3]]);
                changed = true;
            } catch (e) {
                fit.fs = fs;
            }
        }
        try { if (ensureTapeButton(doc, a, fit.fs)) { changed = true; } } catch (e2) {}
        var item = reg.items[a.name] || { kind: "tape" };
        var rect = copyRect(a.rect);
        if (item.kind !== "tape" || item.page !== a.page || String(item.rect) !== String(rect) ||
                item.contents !== text || item.fs !== fit.fs) {
            item.kind = "tape";
            item.page = a.page;
            item.rect = rect;
            item.contents = text;
            item.fs = fit.fs;
            reg.items[a.name] = item;
            changed = true;
        }
        remember(doc, a);
        return changed;
    }

    /** Once per PDF per session: remove buttons left behind by tapes deleted elsewhere. */
    function tidyTapeButtons(doc) {
        var names = fieldNames(doc);
        var any = false;
        for (var i = 0; i < names.length && !any; i++) { if (names[i].indexOf(TBTN + ".") === 0) { any = true; } }
        if (!any) { return false; }
        var present = {};
        var all = getAnnots(doc);
        for (var j = 0; j < all.length; j++) { if (all[j].name) { present[all[j].name] = true; } }
        var before = fieldNames(doc).length;
        cleanTapeButtons(doc, present);
        return fieldNames(doc).length !== before;
    }

    function watchDoc(doc) {
        var p = doc.pageNum;
        var dk = docKey(doc);
        // Housekeeping (buttons, register) mustn't make an unchanged PDF ask "Save changes?".
        var wasDirty = null;
        try { wasDirty = doc.dirty; } catch (e0) {}
        var tidied = false;
        if (!watch.tidied[dk]) {
            watch.tidied[dk] = true;
            try { tidied = tidyTapeButtons(doc); } catch (e1) {}
        }
        var annots = null;
        try { annots = doc.getAnnots({ nPage: p }); } catch (e) {}
        annots = annots || [];
        var here = {};
        var reg = null;
        var changed = false;
        for (var i = 0; i < annots.length; i++) {
            var a = annots[i];
            if (!a || !a.name || a.name.indexOf(TAPE_PREFIX) !== 0) { continue; }
            here[a.name] = true;
            var prev = watch.seen[dk + "|" + a.name];
            if (prev && prev.r === String(copyRect(a.rect)) && prev.c === String(a.contents || "")) { continue; }
            reg = reg || loadReg(doc);
            if (watchTape(doc, reg, a)) { changed = true; }
        }
        // A tape that was on this page a moment ago and is gone (deleted): take its button away too.
        var last = watch.pages[dk];
        if (last && last.page === p) {
            for (var n in last.names) {
                if (last.names.hasOwnProperty(n) && !here[n]) {
                    removeTapeButton(doc, n);
                    delete watch.seen[dk + "|" + n];
                    tidied = true;
                }
            }
        }
        watch.pages[dk] = { page: p, names: here };
        if (changed) { saveReg(doc, reg); }
        if ((changed || tidied) && wasDirty === false) { try { doc.dirty = false; } catch (e2) {} }
    }

    function watchTick() {
        if (watch.busy) { return; }
        watch.busy = true;
        try {
            var docs = watchedDocs();
            for (var i = 0; i < docs.length; i++) {
                try { watchDoc(docs[i]); } catch (e) { forgetDoc(docs[i]); } // closed
            }
        } finally {
            watch.busy = false;
        }
    }

    // -----------------------------------------------------------------------
    // Click capture. Transparent buttons laid over the page(s) record where
    // the user clicks. Reference mode also puts a small options bar at the
    // top of the page: status, Undo, Options and Done.
    //
    // Reference and delete mode don't set up every page at once: a big work
    // paper would keep Acrobat busy for minutes. They set up the page being
    // viewed, and a timer then adds its neighbours, one page per tick so
    // Acrobat never stalls, following the user through the document. Every page gets its own uniquely named buttons:
    // a property set on a field changes all of its widgets, so shared names
    // made the setup time grow with the square of the page count.
    // -----------------------------------------------------------------------
    var CAP = "ART_CAP";
    var BAR = "ART_BAR";
    var CALC = "ART_CALC";

    function fieldNames(doc) {
        var out = [];
        try {
            for (var i = 0; i < doc.numFields; i++) { out.push(doc.getNthFieldName(i)); }
        } catch (e) {}
        return out;
    }

    /** Remove every capture/bar field (also leftovers from a crash or an older version). */
    function removeCaptureFields(doc) {
        if (!doc) { return; }
        var names = fieldNames(doc);
        var roots = [CAPTURE_FIELD, CAP, BAR, CALC];
        for (var i = 0; i < names.length; i++) {
            for (var r = 0; r < roots.length; r++) {
                if (names[i] === roots[r] || names[i].indexOf(roots[r] + ".") === 0) {
                    try { doc.removeField(names[i]); } catch (e) {}
                }
            }
        }
        for (var k = 0; k < roots.length; k++) {
            try { if (doc.getField(roots[k])) { doc.removeField(roots[k]); } } catch (e2) {}
        }
    }

    function removeCaptureField(doc) { removeCaptureFields(doc); }

    function cancelCapture(doc) {
        var old = capture;
        if (old && old.mode === "calc") { stashCalc(old.doc, old.data); }
        capture = null;
        stopFollow();
        removeCaptureFields(doc);
        if (old && old.doc !== doc) { removeCaptureFields(old.doc); }
    }

    function styleButton(f, frame) {
        try { f.borderStyle = border.d; } catch (e) {}
        try { f.lineWidth = frame ? 1 : 0; } catch (e2) {}
        try { f.strokeColor = frame ? color.blue : color.transparent; } catch (e3) {}
        try { f.fillColor = color.transparent; } catch (e4) {}
        try { f.highlight = highlight.n; } catch (e5) {}
        try { f.display = display.noPrint; } catch (e6) {}
    }

    function addCaptureOnPage(doc, p) {
        var f = doc.addField(CAP + ".p" + p, "button", p, doc.getPageBox("Crop", p));
        styleButton(f, true);
        try { f.userName = "Click to place (Reference Tool)"; } catch (e) {}
        f.setAction("MouseUp",
            "if(typeof ARTool!=='undefined'){ARTool._onCapture(this," + p + ",this.mouseX,this.mouseY);}");
    }

    var BAR_BUTTONS = [
        { id: "status", w: 180, tip: "Reference Tool: what the next click does. Click to change options." },
        { id: "undo", w: 40, caption: "Undo", tip: "Remove the last tag placed" },
        { id: "del", w: 44, caption: "Delete", tip: "Click Delete, then click a tag to remove it" },
        { id: "opts", w: 52, caption: "Options", tip: "Next number, colour and size" },
        { id: "done", w: 40, caption: "Done", tip: "Stop placing references" }
    ];
    var DELETE_BAR_BUTTONS = [
        { id: "status", w: 220, tip: "Click a reference tag to delete it" },
        { id: "done", w: 40, caption: "Done", tip: "Stop deleting" }
    ];

    function addBarOnPage(doc, p, buttons) {
        var list = buttons || BAR_BUTTONS;
        var box = doc.getPageBox("Crop", p); // rotated space [left, top, right, bottom]
        var left = Math.min(box[0], box[2]) + 6;
        var top = Math.max(box[1], box[3]) - 4;
        var h = 16;
        var x = left;
        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            var f = doc.addField(BAR + "." + b.id + ".p" + p, "button", p, [x, top, x + b.w, top - h]);
            try { f.borderStyle = border.s; } catch (e) {}
            try { f.lineWidth = 1; } catch (e1) {}
            try { f.strokeColor = ["RGB", 0.2, 0.35, 0.6]; } catch (e2) {}
            try { f.fillColor = b.id === "status" ? ["RGB", 1, 0.97, 0.8] : ["RGB", 0.9, 0.93, 0.98]; } catch (e3) {}
            try { f.textSize = 8; } catch (e4) {}
            try { f.textColor = ["RGB", 0.1, 0.1, 0.1]; } catch (e5) {}
            try { f.highlight = highlight.p; } catch (e6) {}
            try { f.display = display.noPrint; } catch (e7) {}
            try { f.userName = b.tip; } catch (e8) {}
            if (b.caption) { try { f.buttonSetCaption(b.caption); } catch (e9) {} }
            f.setAction("MouseUp", "if(typeof ARTool!=='undefined'){ARTool._bar('" + b.id + "',this);}");
            x += b.w + 3;
        }
    }

    function setStatusOn(doc, p, text) {
        try {
            var f = doc.getField(BAR + ".status.p" + p);
            if (f) { f.buttonSetCaption(text); }
        } catch (e) {}
    }

    function covered(c, p) { return c.pages.hasOwnProperty(String(p)); }

    /** Bring the status caption on the pages near `center` up to date (c.pages[p] = text shown there). */
    function refreshNear(c, center) {
        if (!c.bar) { return; }
        for (var p = center - 1; p <= center + 1; p++) {
            if (covered(c, p) && c.pages[p] !== c.statusText) {
                setStatusOn(c.doc, p, c.statusText);
                c.pages[p] = c.statusText;
            }
        }
    }

    /**
     * Change the status caption. Only the pages near the one being viewed are
     * updated straight away (so a click stays quick however many pages have
     * been visited); the timer catches the others up when the user gets there.
     */
    function setBarStatus(doc, text) {
        var c = capture;
        if (!c || c.doc !== doc || !c.bar) { return; }
        c.statusText = text;
        var n = 0;
        try { n = doc.pageNum; } catch (e) {}
        refreshNear(c, n);
    }

    var FOLLOW_MS = 300;

    /** Put the capture button (and the bar) on page p, once. */
    function coverPage(c, p) {
        if (p < 0 || p >= c.doc.numPages || covered(c, p)) { return; }
        c.pages[p] = "";
        addCaptureOnPage(c.doc, p);
        if (c.bar) {
            addBarOnPage(c.doc, p, c.buttons);
            if (c.statusText) { setStatusOn(c.doc, p, c.statusText); }
            c.pages[p] = c.statusText;
        }
    }

    /** Set up one more page near the one being viewed (it first, then the next, then the previous). */
    function coverNear(c, center) {
        var order = [center, center + 1, center - 1];
        for (var i = 0; i < order.length; i++) {
            var p = order[i];
            if (p >= 0 && p < c.doc.numPages && !covered(c, p)) { coverPage(c, p); return true; }
        }
        return false;
    }

    function stopFollow() {
        try { if (ART_followTimer) { app.clearInterval(ART_followTimer); } } catch (e) {}
        ART_followTimer = null;
    }

    /** Timer: set up the pages the user moves to, and keep their status caption current. */
    function followPage() {
        var c = capture;
        if (!c || !c.follow) { stopFollow(); return; }
        var n;
        try { n = c.doc.pageNum; } catch (e) { capture = null; stopFollow(); return; } // document closed
        if (c.mode === "calc") { calcFollow(c, n); return; }
        if (!coverNear(c, n)) { refreshNear(c, n); }
    }

    /**
     * Start waiting for clicks.
     *   opts.allPages : clicks can go on any page (reference and delete mode): set up the
     *                   current page now and the others as the user reaches them
     *   opts.bar      : show the options bar
     *   opts.keep     : keep capturing after each click (reference mode)
     */
    function startCapture(doc, mode, data, tipKey, tipMsg, opts) {
        opts = opts || {};
        cancelCapture(doc);
        var c = {
            doc: doc, page: doc.pageNum, mode: mode, data: data, keep: !!opts.keep, bar: !!opts.bar,
            buttons: opts.buttons, pages: {}, statusText: "", follow: false
        };
        capture = c;
        if (opts.allPages) {
            // Clicks can go on any page: set up this one now, the others as
            // the user gets to them.
            coverPage(c, doc.pageNum);
            try {
                ART_followTimer = app.setInterval("ARTool._followPage()", FOLLOW_MS);
                c.follow = true;
            } catch (e) {
                for (var p = 0; p < doc.numPages; p++) { coverPage(c, p); } // no timers: every page
            }
        } else {
            coverPage(c, doc.pageNum);
        }
        if (tipKey) { tip(tipKey, tipMsg); }
    }

    function clickPoint(doc, page, mx, my) {
        var g = pageGeom(doc, page);
        var x = Number(mx);
        var y = Number(my);
        if (cfg.mouseYFromTop) { y = g.h - y; }
        x = Math.max(0, Math.min(g.w, x));
        y = Math.max(0, Math.min(g.h, y));
        return [x, y];
    }

    function onCapture(doc, page, mx, my) {
        var c = capture;
        if (!c || c.doc !== doc) {
            // Stray capture fields (e.g. Acrobat restarted mid-session): clean up.
            removeCaptureFields(doc);
            return;
        }
        var pt = clickPoint(doc, page, mx, my);
        var x = pt[0];
        var y = pt[1];
        var reg = loadReg(doc);
        sync(doc, reg);
        if (c.mode === "ref") {
            if (c.data.deleting) {
                c.data.deleting = false;
                deleteAt(doc, reg, page, x, y, c.data);
            } else {
                refPlace(doc, reg, c.data, page, x, y);
            }
            saveReg(doc, reg);
            setBarStatus(doc, statusText(c.data));
            return;
        }
        if (c.mode === "del") {
            deleteAt(doc, reg, page, x, y, null);
            saveReg(doc, reg);
            return;
        }
        // One-shot captures: remove the fields once this click event is over.
        capture = null;
        ART_timer = app.setTimeOut("ARTool._removeCapture()", 50);
        api._pendingRemoval = doc;
        if (c.mode === "tape") {
            delete calcStash[docKey(doc)];
            var s = tapeSize(c.data.text);
            addTape(doc, reg, page, [x, y - s[1], x + s[0], y], c.data.text, null, { src: c.data.src });
        } else if (c.mode === "move") {
            var a = findAnnot(doc, c.data.name);
            if (a) {
                var p = parseName(a.name);
                var item = reg.items[a.name];
                destroyArt(doc, reg, a);
                if (page !== item.page) { item.linkRect = null; }
                addTag(doc, reg, p.label, p.side, page, tagRectAt(p.label, x, y), item.style);
            }
        }
        saveReg(doc, reg);
    }

    // -----------------------------------------------------------------------
    // Reference mode: click a figure, click its match, repeat. Numbers run
    // on automatically (A-1, A-2, ...).
    // -----------------------------------------------------------------------
    var TAG_COLORS = {
        Red: { text: ["RGB", 0.8, 0, 0], fill: ["RGB", 1, 1, 0.8] },
        Blue: { text: ["RGB", 0, 0.25, 0.75], fill: ["RGB", 0.9, 0.95, 1] },
        Green: { text: ["RGB", 0, 0.5, 0.15], fill: ["RGB", 0.9, 1, 0.9] },
        Black: { text: ["RGB", 0, 0, 0], fill: ["RGB", 1, 1, 1] }
    };
    var TAG_SIZES = { Small: 6.5, Medium: 8, Large: 10 };

    function getPrefs() {
        return {
            color: getGlobal("ART_tagColor", "Red"),
            size: getGlobal("ART_tagSize", "Medium"),
            showOptions: getGlobal("ART_showOptions", true) !== false
        };
    }

    function currentStyle() {
        var p = getPrefs();
        return { color: TAG_COLORS[p.color] ? p.color : "Red", size: TAG_SIZES[p.size] ? p.size : "Medium" };
    }

    function labelInUse(doc, present, label) {
        return !!(present[tagName(label, 1)] || present[tagName(label, 2)]);
    }

    /** Next unused label in the running sequence, e.g. A-7. */
    function nextFreeLabel(reg, present) {
        var n = reg.next || 1;
        while (present[tagName(reg.prefix + n, 1)] || present[tagName(reg.prefix + n, 2)]) { n++; }
        reg.next = n;
        return reg.prefix + n;
    }

    function statusText(data) {
        if (data.deleting) { return "Click the tag to delete"; }
        if (data.redo) { return data.redo.label + "  -  click where it should go"; }
        return data.side === 1 ? data.label + "  -  click the figure" : data.label + "  -  now click its match";
    }

    /** The reference tag under a click, if any. */
    function tagAt(doc, page, x, y) {
        var arts = artAnnots(doc, page);
        var best = null;
        var bestD = 1e9;
        for (var i = 0; i < arts.length; i++) {
            var p = parseName(arts[i].name);
            if (!p || p.kind !== "tag") { continue; }
            var r = arts[i].rect;
            var m = 3;
            if (x >= r[0] - m && x <= r[2] + m && y >= r[1] - m && y <= r[3] + m) {
                var d = Math.abs(x - (r[0] + r[2]) / 2) + Math.abs(y - (r[1] + r[3]) / 2);
                if (d < bestD) { bestD = d; best = arts[i]; }
            }
        }
        return best;
    }

    /**
     * Delete the tag that was clicked. Asks whether to remove both sides or
     * just this one (to place it again). data = reference-mode state, if any.
     */
    function deleteAt(doc, reg, page, x, y, data) {
        var a = tagAt(doc, page, x, y);
        if (!a) {
            app.alert({ cTitle: "Delete", nIcon: 3, cMsg: "There's no reference tag there. Click directly on the tag's box." });
            return false;
        }
        var p = parseName(a.name);
        var present = sync(doc, reg);
        var other = present[tagName(p.label, p.side === 1 ? 2 : 1)];
        var both = true;
        if (other) {
            var ans = app.alert({
                cTitle: "Delete " + p.label,
                nIcon: 2,
                nType: 3,
                cMsg: "Delete reference " + p.label + "?\n\n" +
                    "Yes: delete both " + p.label + " tags (this one and its match on p." + (other.page + 1) + ")\n" +
                    "No: delete only this one, then click where it should go\n" +
                    "Cancel: keep it"
            });
            if (ans === 2) { return false; }
            both = (ans === 4);
        } else if (app.alert({ cTitle: "Delete " + p.label, nIcon: 2, nType: 2, cMsg: "Delete tag " + p.label + "?" }) !== 4) {
            return false;
        }
        destroyArt(doc, reg, a);
        delete reg.items[a.name];
        if (both) {
            if (other) { destroyArt(doc, reg, other); delete reg.items[other.name]; }
            if (reg.redo && reg.redo.label === p.label) { reg.redo = null; }
            if (reg.pending === p.label) { reg.pending = null; }
            if (data) {
                if (data.redo && data.redo.label === p.label) { data.redo = null; }
                if (data.label === p.label && data.side === 2) { data.side = 1; }
            }
        } else {
            reg.redo = { label: p.label, side: p.side };
            if (data) { data.redo = { label: p.label, side: p.side }; }
        }
        return true;
    }

    function refPlace(doc, reg, data, page, x, y) {
        if (data.redo) {
            // Re-placing one side of a reference after deleting it.
            var t = data.redo;
            addTag(doc, reg, t.label, t.side, page, tagRectAt(t.label, x, y), currentStyle());
            data.history.push({ name: tagName(t.label, t.side), redo: true });
            data.redo = null;
            reg.redo = null;
            return;
        }
        var label = data.label;
        var side = data.side;
        addTag(doc, reg, label, side, page, tagRectAt(label, x, y), currentStyle());
        data.history.push({ name: tagName(label, side) });
        var m = label.match(/^(.*?)(\d+)$/);
        if (m && m[1] === reg.prefix && Number(m[2]) >= reg.next) { reg.next = Number(m[2]) + 1; }
        if (side === 1) {
            reg.pending = label;
            data.side = 2;
        } else {
            reg.pending = null;
            var present = sync(doc, reg);
            data.label = nextFreeLabel(reg, present);
            data.side = 1;
        }
        setBarStatus(doc, statusText(data));
    }

    function refUndo(doc) {
        var c = capture;
        if (!c || c.mode !== "ref" || !c.data.history.length) { return; }
        var entry = c.data.history.pop();
        var name = entry.name;
        var reg = loadReg(doc);
        var present = sync(doc, reg);
        var p = parseName(name);
        if (present[name]) { destroyArt(doc, reg, present[name]); }
        delete reg.items[name];
        if (entry.redo) {
            c.data.redo = { label: p.label, side: p.side };
            reg.redo = c.data.redo;
            saveReg(doc, reg);
            setBarStatus(doc, statusText(c.data));
            return;
        }
        c.data.label = p.label;
        c.data.side = p.side;
        reg.pending = p.side === 2 ? p.label : null;
        var m = p.label.match(/^(.*?)(\d+)$/);
        if (m && m[1] === reg.prefix) { reg.next = Number(m[2]); }
        saveReg(doc, reg);
        setBarStatus(doc, statusText(c.data));
    }

    /**
     * The options panel. Returns the chosen settings, or null if cancelled.
     * canChangeNext: false while the first half of a pair is waiting.
     */
    function optionsDialog(nextLabel, canChangeNext, starting) {
        var prefs = getPrefs();
        var colors = ["Red", "Blue", "Green", "Black"];
        var sizes = ["Small", "Medium", "Large"];
        var result = null;
        function listFor(items, chosen) {
            var o = {};
            for (var i = 0; i < items.length; i++) { o[items[i]] = (items[i] === chosen) ? 1 : -1; }
            return o;
        }
        function picked(list) {
            for (var k in list) { if (list.hasOwnProperty(k) && list[k] > 0) { return k; } }
            return null;
        }
        var dlg = {
            initialize: function (d) {
                d.load({
                    next: nextLabel,
                    colr: listFor(colors, prefs.color),
                    size: listFor(sizes, prefs.size),
                    show: prefs.showOptions
                });
                d.enable({ next: canChangeNext });
            },
            commit: function (d) {
                var r = d.store();
                result = {
                    next: trim(r.next || ""),
                    color: picked(r.colr) || prefs.color,
                    size: picked(r.size) || prefs.size,
                    showOptions: !!r.show
                };
            },
            description: {
                name: "Reference Tool",
                elements: [
                    {
                        type: "view",
                        align_children: "align_left",
                        elements: [
                            {
                                type: "view",
                                align_children: "align_row",
                                elements: [
                                    { type: "static_text", name: "Next reference:" },
                                    { type: "edit_text", item_id: "next", width: 80 },
                                    { type: "static_text", name: "Colour:" },
                                    { type: "popup", item_id: "colr", width: 80 },
                                    { type: "static_text", name: "Size:" },
                                    { type: "popup", item_id: "size", width: 80 }
                                ]
                            },
                            {
                                type: "static_text",
                                name: "Click a figure, then click its match (any page). Numbers continue automatically.",
                                width: 470
                            },
                            { type: "check_box", item_id: "show", name: "Show these options each time I start" }
                        ]
                    },
                    { type: "ok_cancel", ok_name: starting ? "Start" : "OK" }
                ]
            }
        };
        if (app.execDialog(dlg) !== "ok") { return null; }
        return result;
    }

    function applyOptions(opts) {
        setGlobal("ART_tagColor", opts.color);
        setGlobal("ART_tagSize", opts.size);
        setGlobal("ART_showOptions", opts.showOptions);
    }

    /** Validate a typed "next reference" and point the sequence at it. */
    function setNextLabel(doc, reg, present, label) {
        if (!label || label.indexOf(":") >= 0) {
            app.alert("Please use a reference without colons, e.g. A-1.");
            return false;
        }
        if (labelInUse(doc, present, label)) {
            app.alert("Reference " + label + " is already used in this document. Pick another number.");
            return false;
        }
        var m = label.match(/^(.*?)(\d+)$/);
        if (m) { reg.prefix = m[1]; reg.next = Number(m[2]); }
        return true;
    }

    function refIsActive() { return !!(capture && capture.mode === "ref"); }

    function stopReferenceMode(doc) {
        var c = capture;
        cancelCapture(doc);
        if (c && c.mode === "ref" && c.data.redo) {
            app.alert({
                cTitle: "Reference Tool",
                nIcon: 3,
                cMsg: c.data.redo.label + " still needs placing. Next time you start the Reference tool it will ask for it first."
            });
        } else if (c && c.mode === "ref" && c.data.side === 2) {
            app.alert({
                cTitle: "Reference Tool",
                nIcon: 3,
                cMsg: c.data.label + " doesn't have its match yet. Next time you start the Reference tool it will pick up there."
            });
        }
    }

    function placeTag(doc) {
        // The same button starts and stops reference mode.
        if (capture && capture.mode === "calc") { cancelCapture(doc); }
        if (capture) {
            if (capture.mode === "ref") { stopReferenceMode(doc); } else { cancelCapture(doc); }
            return;
        }
        removeCaptureFields(doc);
        var reg = loadReg(doc);
        var present = sync(doc, reg);
        var data = { label: null, side: 1, history: [], redo: null };
        if (reg.redo && !present[tagName(reg.redo.label, reg.redo.side)]) { data.redo = reg.redo; }
        if (reg.pending) {
            data.label = reg.pending;
            data.side = 2;
        } else {
            data.label = nextFreeLabel(reg, present);
        }

        if (getPrefs().showOptions) {
            while (true) {
                var o = optionsDialog(data.label, data.side === 1, true);
                if (!o) { return; }
                applyOptions(o);
                if (data.side === 1 && o.next !== data.label) {
                    if (!setNextLabel(doc, reg, present, o.next)) { continue; }
                    data.label = o.next;
                }
                break;
            }
        }
        saveReg(doc, reg);
        startCapture(doc, "ref", data, "refmode",
            "Reference mode is on.\n\n" +
            "Click a figure to place " + data.label + ", then click its match on any page. " +
            "The next number follows automatically.\n\n" +
            "Use the bar at the top of the page to Undo, Delete a tag, change Options, or finish (Done). " +
            "Clicking the Reference button again also finishes.",
            { allPages: true, bar: true, keep: true });
        setBarStatus(doc, statusText(data));
    }

    function barClick(id, doc) {
        var c = capture;
        if (c && c.mode === "del" && c.doc === doc) {
            if (id === "done") { cancelCapture(doc); }
            return;
        }
        if (!c || c.mode !== "ref" || c.doc !== doc) { removeCaptureFields(doc); return; }
        if (id === "done") { stopReferenceMode(doc); return; }
        if (id === "undo") { refUndo(doc); return; }
        if (id === "del") {
            c.data.deleting = !c.data.deleting;
            setBarStatus(doc, statusText(c.data));
            return;
        }
        if (id === "opts" || id === "status") {
            var reg = loadReg(doc);
            var present = sync(doc, reg);
            while (true) {
                var o = optionsDialog(c.data.label, c.data.side === 1, false);
                if (!o) { return; }
                applyOptions(o);
                if (c.data.side === 1 && o.next !== c.data.label) {
                    if (!setNextLabel(doc, reg, present, o.next)) { continue; }
                    c.data.label = o.next;
                    saveReg(doc, reg);
                }
                break;
            }
            setBarStatus(doc, statusText(c.data));
        }
    }

    function selectedMarker(doc) {
        var sel = null;
        try { sel = doc.selectedAnnots; } catch (e) {}
        if (!sel || sel.length !== 1 || isArt(sel[0])) { return null; }
        return sel[0];
    }

    // -----------------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------------
    /** Preview text and running total for the calculator. */
    function tapePreview(r) {
        var calc = computeTape(r.ents);
        var txt = formatTape(r.titl, calc, r.init);
        var errs = realErrors(calc);
        if (errs.length) { txt = "Check: " + errs.join("\n") + "\n\n" + txt; }
        var hasRows = calc.rows.length > 0;
        return { text: hasRows ? txt : "", total: hasRows ? trim(fmt(calc.total)) : "" };
    }

    // -----------------------------------------------------------------------
    // Calc Tape: a calculator made of form fields at the top of the page.
    // Acrobat's pop-up dialogs can't see single key presses, but a form
    // field can, so + - * / act the moment they're pressed, like a 10-key
    // adding machine. The panel follows the page being viewed. Double-
    // clicking a tape opens it here to change it.
    // -----------------------------------------------------------------------
    var CALC_W = 340;
    var CALC_COLORS = {
        panel: ["RGB", 0.9, 0.93, 0.98],
        input: ["RGB", 1, 1, 1],
        status: ["RGB", 1, 0.97, 0.8],
        button: ["RGB", 0.8, 0.87, 0.97],
        place: ["RGB", 0.8, 0.93, 0.8],
        line: ["RGB", 0.2, 0.35, 0.6]
    };
    var CALC_HELP = "Amount, then  +  adds it,  -  subtracts it.    *  or  /  : times or divided by the next number.\n" +
        "Enter adds the line (use Enter after a description, e.g. 800 O/S cheque).    =  then Enter: subtotal";
    var DOUBLE_CLICK_MS = 600;
    var PREVIEW_LINES = 17;

    function calcRows(editing) {
        return [
            { h: 18, cells: [["info", 230, "status"], ["undo", 58, "button", "Undo line", "Take the last line off the tape"], ["move", 52, "button", "Move", "Move the calculator to another corner of the page"]] },
            { h: 17, cells: [["l_titl", 34, "label", "Title"], ["titl", 196, "text", "Title printed at the top of the tape"], ["l_init", 50, "label", "Initials"], ["init", 60, "text", "Your initials, printed under the total"]] },
            { h: 22, cells: [["l_entr", 50, "label", "Amount"], ["entr", 290, "entry", "Type an amount, then + - * / or Enter"]] },
            { h: 21, cells: [["help", 340, "help"]] },
            { h: 150, cells: [["ents", 140, "lines", "The tape's lines. You can change them here; the tape updates when you click out of this box."], ["prev", 200, "preview"]] },
            { h: 22, cells: [["l_totl", 40, "label", "Total"], ["totl", 110, "total"],
                ["place", 120, "button", editing ? "Update tape" : "Place on page", editing ? "Save the changes to the tape" : "Then click where the tape should go"],
                ["cancel", 70, "button", "Cancel", "Close the calculator without changing anything"]] }
        ];
    }

    /** Where each part of the panel goes on page p: {id: [left, top, right, bottom]} in rotated space. */
    function calcLayout(doc, p, corner, editing) {
        var rows = calcRows(editing);
        var H = 0;
        var i;
        for (i = 0; i < rows.length; i++) { H += rows[i].h; }
        var b = doc.getPageBox("Crop", p);
        var left = Math.min(b[0], b[2]);
        var right = Math.max(b[0], b[2]);
        var top = Math.max(b[1], b[3]);
        var bottom = Math.min(b[1], b[3]);
        var x0 = (corner === 2 || corner === 3) ? left + 6 : right - 6 - CALC_W;
        var y0 = (corner === 1 || corner === 2) ? bottom + 4 + H : top - 4;
        x0 = Math.max(left, x0);
        var out = [];
        var y = y0;
        for (i = 0; i < rows.length; i++) {
            var x = x0;
            for (var j = 0; j < rows[i].cells.length; j++) {
                var cell = rows[i].cells[j];
                out.push({ id: cell[0], kind: cell[2], caption: cell[3], tip: cell[4], rect: [x, y, x + cell[1], y - rows[i].h] });
                x += cell[1];
            }
            y -= rows[i].h;
        }
        return out;
    }

    function calcField(c, id) {
        try { return c.doc.getField(CALC + "." + id); } catch (e) { return null; }
    }

    function setCalcValue(c, id, v) {
        var f = calcField(c, id);
        if (f && String(f.value) !== String(v)) { try { f.value = v; } catch (e) {} }
    }

    function styleCalc(f, fill, lw) {
        try { f.borderStyle = border.s; } catch (e) {}
        try { f.lineWidth = lw; } catch (e1) {}
        try { f.strokeColor = lw ? CALC_COLORS.line : color.transparent; } catch (e2) {}
        try { f.fillColor = fill; } catch (e3) {}
        try { f.display = display.noPrint; } catch (e4) {}
        try { f.textColor = ["RGB", 0.1, 0.1, 0.1]; } catch (e5) {}
    }

    function useCourier(f) { try { f.textFont = font.Cour; } catch (e) {} }

    /** Build the panel on c.page. */
    function renderCalc(c) {
        var doc = c.doc;
        var editing = !!c.data.editing;
        var cells = calcLayout(doc, c.page, getGlobal("ART_calcCorner", 0) % 4, editing);
        for (var i = 0; i < cells.length; i++) {
            var cl = cells[i];
            var name = CALC + "." + cl.id;
            var f;
            if (cl.kind === "button") {
                f = doc.addField(name, "button", c.page, cl.rect);
                styleCalc(f, cl.id === "place" ? CALC_COLORS.place : CALC_COLORS.button, 1);
                try { f.textSize = 8; } catch (e) {}
                try { f.highlight = highlight.p; } catch (e1) {}
                try { f.buttonSetCaption(cl.caption); } catch (e2) {}
                f.setAction("MouseUp", "if(typeof ARTool!=='undefined'){ARTool._calcBtn(this,'" + cl.id + "');}");
            } else {
                f = doc.addField(name, "text", c.page, cl.rect);
                var ro = (cl.kind === "label" || cl.kind === "status" || cl.kind === "help" || cl.kind === "preview" || cl.kind === "total");
                var fill = cl.kind === "status" ? CALC_COLORS.status : (ro && cl.kind !== "preview" ? CALC_COLORS.panel : CALC_COLORS.input);
                styleCalc(f, fill, (cl.kind === "label" || cl.kind === "help") ? 0 : 1);
                try { f.textSize = { label: 8, status: 8, help: 6.5, preview: 7, total: 10, entry: 11, lines: 8, text: 9 }[cl.kind]; } catch (e3) {}
                if (cl.kind === "help" || cl.kind === "preview" || cl.kind === "lines") { try { f.multiline = true; } catch (e4) {} }
                if (cl.kind === "preview" || cl.kind === "lines") { useCourier(f); }
                if (cl.kind === "total" || cl.kind === "label") { try { f.alignment = cl.kind === "total" ? "right" : "left"; } catch (e5) {} }
                try { f.doNotSpellCheck = true; } catch (e6) {}
                if (ro) {
                    try { f.readonly = true; } catch (e7) {}
                } else if (cl.kind === "entry") {
                    f.setAction("Keystroke", "if(typeof ARTool!=='undefined'){ARTool._calcKey(this,event);}");
                    f.setAction("OnFocus", "if(typeof ARTool!=='undefined'){ARTool._calcFocus(this,true);}");
                    f.setAction("OnBlur", "if(typeof ARTool!=='undefined'){ARTool._calcFocus(this,false);}");
                } else {
                    f.setAction("Keystroke", "if(typeof ARTool!=='undefined'){ARTool._calcEdit(this,event,'" + cl.id + "');}");
                }
                if (cl.kind === "label") { try { f.value = cl.caption; } catch (e8) {} }
                if (cl.kind === "help") { try { f.value = CALC_HELP; } catch (e9) {} }
            }
            if (cl.tip) { try { f.userName = cl.tip; } catch (e10) {} }
        }
        refreshCalc(c);
    }

    function calcStatusDefault(c) {
        return c.data.editing ? "Editing this tape: change it, then click Update tape" : "Calc Tape: type an amount, then + - * / or Enter";
    }

    /** Show the latest tape, total and message. skip = the field being edited right now (leave it alone). */
    function refreshCalc(c, skip) {
        var d = c.data;
        var p = tapePreview(d);
        var lines = p.text ? p.text.split("\n") : [];
        if (lines.length > PREVIEW_LINES) { lines = ["..."].concat(lines.slice(lines.length - PREVIEW_LINES + 1)); }
        var vals = { info: d.status || calcStatusDefault(c), titl: d.titl || "", init: d.init || "", entr: d.entr || "",
            ents: d.ents || "", prev: lines.join("\n"), totl: p.total };
        for (var k in vals) {
            if (vals.hasOwnProperty(k) && k !== skip) { setCalcValue(c, k, vals[k]); }
        }
    }

    function focusEntry(c) {
        var f = calcField(c, "entr");
        if (f) { try { f.setFocus(); } catch (e) {} }
    }

    /** Run work just after the current button click or keystroke has finished. */
    var laterQueue = [];
    function later(fn) {
        laterQueue.push(fn);
        try {
            ART_laterTimer = app.setTimeOut("ARTool._runLater()", 30);
        } catch (e) {
            runLater();
        }
    }

    function runLater() {
        var q = laterQueue;
        laterQueue = [];
        for (var i = 0; i < q.length; i++) {
            try { q[i](); } catch (e) { showError("Calc Tape", e); }
        }
    }

    function isCalc(c, doc) { return !!(c && c.mode === "calc" && c.doc === doc); }

    /**
     * A calculation interrupted by another command (or a tape waiting to be
     * placed) is kept, so the next Calc Tape picks it up instead of losing it.
     */
    var calcStash = {};
    function stashCalc(doc, d) {
        if (!doc || !d || !(trim(d.ents || "") || trim(d.entr || ""))) { return; }
        calcStash[docKey(doc)] = { titl: d.titl || "", ents: d.ents || "", entr: d.entr || "", init: d.init || "", editing: d.editing || null };
    }

    function startCalc(doc, data, page) {
        cancelCapture(doc);
        data.entr = data.entr || "";
        data.status = data.status || "";
        var c = { doc: doc, mode: "calc", page: page, data: data, follow: false, pages: {}, want: null, focused: true };
        capture = c;
        renderCalc(c);
        try {
            ART_followTimer = app.setInterval("ARTool._followPage()", FOLLOW_MS);
            c.follow = true;
        } catch (e) {}
        tip("calcpad",
            "The calculator is at the top of the page, and it follows you from page to page.\n\n" +
            "Type an amount and press + to add it or - to subtract it. * or / multiplies or divides by the next number " +
            "(250 * 12 adds 3,000). Press Enter to add a line with a description, e.g. 800 O/S cheque.\n\n" +
            "Click Place on page when you're done, then click where the tape goes. Double-click a tape later to change it.");
        later(function () { if (capture === c) { focusEntry(c); } });
    }

    /** The panel follows the page being viewed (once the user has stayed there a moment). */
    function calcFollow(c, n) {
        if (n === c.page) { c.want = null; return; }
        if (!c.want || c.want.page !== n) { c.want = { page: n, ticks: 1 }; return; }
        c.want.ticks++;
        if (c.want.ticks < 2) { return; }
        c.want = null;
        moveCalc(c, n);
    }

    function moveCalc(c, n, focus) {
        // If the cursor was in the Amount box, put it back there on the new page.
        var refocus = focus || c.focused;
        removeCaptureFields(c.doc);
        c.page = n;
        renderCalc(c);
        if (refocus) { later(function () { if (capture === c) { focusEntry(c); } }); }
    }

    /** Add one line to the tape if it can be read. Shows what happened in the status line. */
    function addCalcLine(c, line) {
        var d = c.data;
        var base = d.ents ? String(d.ents).replace(/[\r\n\s]+$/, "") : "";
        var ents = base ? base + "\n" + line : line;
        var before = realErrors(computeTape(base)).length;
        var calc = computeTape(ents);
        if (realErrors(calc).length > before) {
            var errs = realErrors(calc);
            d.status = /multiply or divide/.test(errs[errs.length - 1]) ?
                "Start with an amount; * and / work on the total so far" :
                "Can't read \"" + line + "\": type an amount, e.g. 1,250.00 or 800 O/S cheque";
            return false;
        }
        d.ents = ents;
        d.status = "Added " + line + "     Total " + trim(fmt(calc.total));
        return true;
    }

    /** Enter in the Amount box: add what's there as a line. */
    function calcEnter(c, text) {
        var s = trim(text);
        if (!s) { return true; }
        if (new RegExp("^(?:" + MULOP + "|.*\\s*" + MULOP + ")$").test(s) && !/[A-Za-z]{2}/.test(s)) {
            c.data.status = "Type the number after " + s.slice(-1) + ", then press Enter";
            return false;
        }
        return addCalcLine(c, s);
    }

    /** Keystrokes in the Amount box. */
    function calcKey(doc, ev) {
        rememberDoc(doc);
        var c = capture;
        if (!isCalc(c, doc)) {
            if (!(c && c.doc === doc)) { later(function () { if (!capture) { removeCaptureFields(doc); } }); }
            return;
        }
        var d = c.data;
        if (ev.willCommit) {
            d.entr = String(ev.value || "");
            if (ev.commitKey === 2) {                 // Enter
                if (trim(d.entr) && calcEnter(c, d.entr)) { d.entr = ""; }
                later(function () { if (capture === c) { refreshCalc(c); focusEntry(c); } });
            }
            return;
        }
        var val = String(ev.value || "");
        var ch = String(ev.change || "");
        var ss = Number(ev.selStart);
        var se = Number(ev.selEnd);
        if (!(ss >= 0)) { ss = val.length; }
        if (!(se >= ss)) { se = ss; }
        var act = null;
        // Only at the end of what's typed, so "O/S" or "Year-end" type normally. With the whole
        // amount highlighted, + * / still act on it, but - starts a negative number in its place.
        if (ch.length === 1 && "+-*/".indexOf(ch) >= 0 && se === val.length && (ss === se || (ss === 0 && ch !== "-"))) {
            act = calcKeyAction(val, ch);
        }
        if (act && act.line && !addCalcLine(c, act.line)) {
            ev.rc = false;                            // couldn't read it: leave the box as it is
            refreshCalc(c, "entr");
            return;
        }
        if (act) {
            ev.selStart = 0;
            ev.selEnd = val.length;
            ev.change = act.next;
            d.entr = act.next;
            if (!act.line) { d.status = trim(act.next) + " ...  type the next number"; }
            refreshCalc(c, "entr");
            return;
        }
        d.entr = val.slice(0, ss) + ch + val.slice(se);
    }

    /** Title, Initials and the tape lines: keep up with typing; refresh the tape when the box is left. */
    function calcEdit(doc, ev, id) {
        var c = capture;
        if (!isCalc(c, doc)) { return; }
        var d = c.data;
        if (ev.willCommit) {
            d[id] = String(ev.value || "");
            if (id === "ents") { d.status = ""; }
            refreshCalc(c, id);
            if (ev.commitKey === 2 && id !== "ents") { later(function () { if (capture === c) { focusEntry(c); } }); }
            return;
        }
        var val = String(ev.value || "");
        var ss = Number(ev.selStart);
        var se = Number(ev.selEnd);
        if (!(ss >= 0)) { ss = val.length; }
        if (!(se >= ss)) { se = ss; }
        d[id] = val.slice(0, ss) + String(ev.change || "") + val.slice(se);
    }

    function endCalc(c) {
        if (capture === c) { capture = null; }
        stopFollow();
        var doc = c.doc;
        later(function () { if (!capture || capture.doc !== doc) { removeCaptureFields(doc); } });
    }

    function calcPlace(c) {
        var d = c.data;
        var doc = c.doc;
        // A number still in the Amount box goes on the tape too (a lone "x" waiting for its number doesn't).
        if (trim(d.entr) && !new RegExp("^" + MULOP + "$").test(trim(d.entr))) {
            if (!calcEnter(c, d.entr)) { refreshCalc(c); return; }
        }
        d.entr = "";
        var calc = computeTape(d.ents);
        if (calc.errors.length) {
            d.status = calc.errors[0] === EMPTY_TAPE ? "Type at least one amount first" : "Fix the lines: " + calc.errors[0];
            refreshCalc(c);
            return;
        }
        setGlobal("ART_initials", d.init || "");
        var text = formatTape(d.titl, calc, d.init);
        var src = { titl: trim(d.titl || ""), ents: String(d.ents).replace(/\r\n|\r/g, "\n"), init: trim(d.init || "") };
        endCalc(c);
        stashCalc(doc, d);                          // until the tape is on the page
        if (d.editing) {
            var a = findTape(doc, d.editing, d.editPage);
            if (a) {
                delete calcStash[docKey(doc)];
                var reg = loadReg(doc);
                sync(doc, reg);
                updateTape(doc, reg, a, text, src);
                saveReg(doc, reg);
                return;
            }
            // The tape was deleted meanwhile: place it as a new one.
        }
        later(function () {
            startCapture(doc, "tape", { text: text, src: src }, "tape",
                "Click where the top-left corner of the tape should go.\n\n" +
                "Afterwards: drag the tape by its title line or edge to move it, drag a corner to resize it, " +
                "and double-click its figures to change them.");
        });
    }

    function calcButton(doc, id) {
        rememberDoc(doc);
        var c = capture;
        if (!isCalc(c, doc)) {
            if (!(c && c.doc === doc)) { later(function () { if (!capture) { removeCaptureFields(doc); } }); }
            return;
        }
        var d = c.data;
        if (id === "place") { calcPlace(c); return; }
        if (id === "cancel") { delete calcStash[docKey(doc)]; endCalc(c); return; }
        if (id === "undo") {
            var lines = String(d.ents || "").replace(/[\r\n\s]+$/, "").split(/\r\n|\r|\n/);
            var gone = lines.pop();
            d.ents = lines.join("\n");
            d.status = gone ? "Took off " + trim(gone) : "The tape is empty";
            refreshCalc(c);
            later(function () { if (capture === c) { focusEntry(c); } });
            return;
        }
        if (id === "move") {
            setGlobal("ART_calcCorner", (getGlobal("ART_calcCorner", 0) + 1) % 4);
            later(function () { if (capture === c) { moveCalc(c, c.page, true); } });
        }
    }

    function selectedTape(doc) {
        var sel = null;
        try { sel = doc.selectedAnnots; } catch (e) {}
        if (!sel || sel.length !== 1) { return null; }
        var p = parseName(sel[0].name);
        return p && p.kind === "tape" ? sel[0] : null;
    }

    function sameText(a, b) {
        function n(t) { return trim(String(t || "").replace(/\r\n|\r/g, "\n")); }
        return n(a) === n(b);
    }

    /** The tape called `name`, preferring the one on `page` (a copied page can repeat a name). */
    function findTape(doc, name, page) {
        if (page !== undefined && page !== null) {
            var here = getAnnots(doc, page);
            for (var i = 0; i < here.length; i++) { if (here[i].name === name) { return here[i]; } }
        }
        return findAnnot(doc, name);
    }

    /** Open the calculator on an existing tape, filled in with its lines. */
    function editTape(doc, name, page) {
        var c = capture;
        if (isCalc(c, doc)) {
            if (c.data.editing !== name) {
                c.data.status = "Finish this one first: click " + (c.data.editing ? "Update tape" : "Place on page") + " or Cancel";
                refreshCalc(c);
            }
            later(function () { if (capture === c) { focusEntry(c); } });
            return;
        }
        var a = findTape(doc, name, page);
        if (!a) {
            later(function () { removeTapeButton(doc, name); });
            return;
        }
        var reg = loadReg(doc);
        var item = reg.items[name] || {};
        // The saved lines, unless the tape's text was changed directly since (then read the tape itself).
        var src = (item.src && sameText(item.made, a.contents)) ? item.src : null;
        src = src || parseTapeText(a.contents) || { titl: "", ents: "", init: "" };
        startCalc(doc, { titl: src.titl || "", ents: src.ents || "", init: src.init || "", editing: name, editPage: a.page }, a.page);
    }

    /** Follow a reference tag's link by hand (for a tag that sits on a tape's figures). */
    function jumpToMatch(doc, tag) {
        var p = parseName(tag.name);
        var other = findAnnot(doc, tagName(p.label, p.side === 1 ? 2 : 1));
        if (!other) { app.alert("The matching tag " + p.label + " was not found in this document.", 1); return; }
        doc.pageNum = other.page;
        try { doc.scroll(other.rect[0] - 72, other.rect[3] + 72); } catch (e) {}
    }

    /** A click on a tape's double-click button. */
    var lastTapeClick = null;
    function tapeClick(doc, name, page, mx, my) {
        rememberDoc(doc);
        // A button shared by two same-named tapes reports all its pages: use the one being viewed.
        page = (typeof page === "number") ? page : doc.pageNum;
        var c = capture;
        if (c && c.doc === doc && c.mode !== "calc") {
            // Placing something: this click is for that, as if the tape weren't there.
            onCapture(doc, Number(page), mx, my);
            return;
        }
        // A reference tag on the tape's figures: the click is for its link.
        var pt = clickPoint(doc, Number(page), mx, my);
        var tag = tagAt(doc, Number(page), pt[0], pt[1]);
        if (tag) { lastTapeClick = null; jumpToMatch(doc, tag); return; }
        var t = new Date().getTime();
        var last = lastTapeClick;
        lastTapeClick = { name: name, t: t };
        if (!last || last.name !== name || t - last.t > DOUBLE_CLICK_MS) { return; }
        lastTapeClick = null;
        editTape(doc, name, Number(page));
    }

    function calcTape(doc) {
        var c = capture;
        if (isCalc(c, doc)) {
            // Already open: bring it to this page.
            if (c.page !== doc.pageNum) { moveCalc(c, doc.pageNum); }
            later(function () { if (capture === c) { focusEntry(c); } });
            return;
        }
        var sel = selectedTape(doc);
        if (sel) { editTape(doc, sel.name, sel.page); return; }
        var kept = calcStash[docKey(doc)];
        if (kept) {
            delete calcStash[docKey(doc)];
            kept.status = "Picked up where you left off (Cancel clears it)";
            startCalc(doc, kept, doc.pageNum);
            return;
        }
        startCalc(doc, { titl: "", ents: "", init: getGlobal("ART_initials", ""), editing: null }, doc.pageNum);
    }

    function buildReport(doc, reg, present) {
        var labels = {};
        var name;
        var tapes = 0;
        var missingTapes = 0;
        for (name in reg.items) {
            if (!reg.items.hasOwnProperty(name)) { continue; }
            var it = reg.items[name];
            if (it.kind === "tape") {
                if (present[name]) { tapes++; } else { missingTapes++; }
                continue;
            }
            var L = labels[it.label] || (labels[it.label] = { s1: null, s2: null, lost: [] });
            var a = present[name];
            if (a) { L["s" + it.side] = a.page + 1; } else { L.lost.push(it.side); }
        }
        var keys = [];
        for (name in labels) { if (labels.hasOwnProperty(name)) { keys.push(name); } }
        keys.sort(function (x, y) {
            var mx = x.match(/^(.*?)(\d+)$/);
            var my = y.match(/^(.*?)(\d+)$/);
            if (mx && my && mx[1] === my[1]) { return Number(mx[2]) - Number(my[2]); }
            return x < y ? -1 : (x > y ? 1 : 0);
        });
        var ok = [];
        var unmatched = [];
        var broken = [];
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var t = labels[k];
            if (t.lost.length) {
                broken.push(k + "  (side " + t.lost.join(" & ") + " missing - run Repair Tags)");
            } else if (t.s1 && t.s2) {
                ok.push(pad(k, 8) + " p." + t.s1 + "  <->  p." + t.s2);
            } else {
                unmatched.push(k + "  on p." + (t.s1 || t.s2) + " has no matching tag" + (reg.pending === k ? " (waiting)" : ""));
            }
        }
        var out = [];
        out.push("Tags: " + keys.length + "    Linked: " + ok.length + "    Unmatched: " + unmatched.length + "    Broken: " + broken.length);
        out.push("Tapes: " + tapes + (missingTapes ? "    Missing tapes: " + missingTapes : ""));
        out.push("");
        if (broken.length) { out.push("BROKEN"); out = out.concat(broken); out.push(""); }
        if (unmatched.length) { out.push("UNMATCHED"); out = out.concat(unmatched); out.push(""); }
        if (ok.length) { out.push("LINKED"); out = out.concat(ok); }
        if (!keys.length) { out.push("No tags in this document yet."); }
        return { text: out.join("\n"), broken: broken.length, unmatched: unmatched.length, ok: ok.length, missingTapes: missingTapes };
    }

    function showText(title, text) {
        app.execDialog({
            initialize: function (d) { d.load({ rept: text }); },
            description: {
                name: title,
                elements: [
                    { type: "edit_text", item_id: "rept", multiline: true, readonly: true, width: 460, height: 360 },
                    { type: "ok" }
                ]
            }
        });
    }

    function tagCheck(doc) {
        var reg = loadReg(doc);
        var present = sync(doc, reg);
        saveReg(doc, reg);
        var rep = buildReport(doc, reg, present);
        showText("Tag Check", rep.text);
        return rep;
    }

    function missingItems(reg, present) {
        var out = [];
        for (var name in reg.items) {
            if (reg.items.hasOwnProperty(name) && !present[name]) { out.push(name); }
        }
        return out;
    }

    function describe(reg, name) {
        var it = reg.items[name];
        if (it.kind === "tag") { return "Tag " + it.label + " (side " + it.side + ") on p." + (it.page + 1); }
        var first = String(it.contents || "").split("\n")[0];
        return "Tape \"" + first + "\" on p." + (it.page + 1);
    }

    function repairTags(doc) {
        if (capture) { cancelCapture(doc); }
        var reg = loadReg(doc);
        var present = sync(doc, reg);
        var missing = missingItems(reg, present);
        var restored = 0;
        var skipped = [];
        if (missing.length) {
            var list = [];
            for (var i = 0; i < missing.length && i < 25; i++) { list.push(describe(reg, missing[i])); }
            if (missing.length > 25) { list.push("... and " + (missing.length - 25) + " more"); }
            var ans = app.alert({
                cTitle: "Repair Tags",
                nIcon: 2,
                nType: 3,
                cMsg: missing.length + " item(s) are in the register but missing from the document:\n\n" +
                    list.join("\n") + "\n\n" +
                    "Yes: restore them\nNo: forget them (they were deleted on purpose)\nCancel: do nothing"
            });
            if (ans === 2) { return; }
            for (var j = 0; j < missing.length; j++) {
                var nm = missing[j];
                var it = reg.items[nm];
                if (ans === 3) { delete reg.items[nm]; continue; }
                if (it.page >= doc.numPages) { skipped.push(describe(reg, nm)); continue; }
                restoreItem(doc, reg, nm, it);
                restored++;
            }
        }
        // Refresh every link so moved or restored tags are clickable, and
        // make sure every tape (and only a tape) has its double-click button.
        present = sync(doc, reg);
        var linked = 0;
        for (var n in present) {
            if (!present.hasOwnProperty(n)) { continue; }
            if (reg.items[n].kind === "tag") { rebuildLink(doc, present[n], reg); linked++; }
            else { try { ensureTapeButton(doc, present[n], tapeFs(present[n], reg)); } catch (e3) {} }
        }
        cleanTapeButtons(doc, present);
        saveReg(doc, reg);
        var msg = "Repair complete.\n\nRestored: " + restored + "\nLinks refreshed: " + linked;
        if (skipped.length) { msg += "\n\nCould not restore (page no longer exists):\n" + skipped.join("\n"); }
        app.alert({ cMsg: msg, nIcon: 3, cTitle: "Repair Tags" });
        return { restored: restored, linked: linked, skipped: skipped.length };
    }

    function replacePage(doc) {
        if (capture) { cancelCapture(doc); }
        var p = doc.pageNum;
        var ok = app.alert({
            cTitle: "Replace Page (Keep Tags)",
            nIcon: 2,
            nType: 2,
            cMsg: "Replace page " + (p + 1) + " with a page from another PDF?\n\n" +
                "Tags and tapes on this page will be put back on the new page."
        });
        if (ok !== 4) { return; }
        var pick = ART_privBrowseForDoc();
        if (!pick || !pick.cPath) { return; }
        var sp = app.response({ cQuestion: "Which page of the new file should be used?", cTitle: "Replace Page", cDefault: "1" });
        if (sp === null || sp === undefined) { return; }
        var srcPage = parseInt(sp, 10);
        if (!(srcPage >= 1)) { app.alert("Please enter a page number, e.g. 1."); return; }

        var reg = loadReg(doc);
        sync(doc, reg);
        var onPage = getAnnots(doc, p);
        var arts = [];
        var others = [];
        var i;
        for (i = 0; i < onPage.length; i++) { (isArt(onPage[i]) ? arts : others).push(onPage[i]); }

        var carryOthers = false;
        if (others.length) {
            carryOthers = app.alert({
                cTitle: "Replace Page",
                nIcon: 2,
                nType: 2,
                cMsg: "This page also has " + others.length + " other comment(s). Carry them over to the new page too?"
            }) === 4;
        }
        var artNames = [];
        for (i = 0; i < arts.length; i++) { artNames.push(arts[i].name); }
        var otherProps = [];
        if (carryOthers) { for (i = 0; i < others.length; i++) { otherProps.push(others[i].getProps()); } }

        // Take our links off the old page first.
        for (i = 0; i < arts.length; i++) { destroyArt(doc, reg, arts[i]); }

        var srcOpts = { nPage: p, cPath: pick.cPath, nStart: srcPage - 1, nEnd: srcPage - 1 };
        if (pick.cFS) { srcOpts.cFS = pick.cFS; }
        try {
            ART_privReplacePages(doc, srcOpts);
        } catch (e) {
            // Put things back if the replace failed.
            for (i = 0; i < artNames.length; i++) { restoreItem(doc, reg, artNames[i], reg.items[artNames[i]], p); }
            saveReg(doc, reg);
            app.alert("The page could not be replaced:\n\n" + e);
            return;
        }

        // Remove anything Acrobat carried over so nothing is duplicated.
        var after = getAnnots(doc, p);
        var existing = {};
        for (i = 0; i < after.length; i++) {
            if (isArt(after[i])) { destroyArt(doc, reg, after[i]); } else if (after[i].name) { existing[after[i].name] = true; }
        }
        for (i = 0; i < artNames.length; i++) {
            var it = reg.items[artNames[i]];
            it.linkRect = null;
            restoreItem(doc, reg, artNames[i], it, p);
        }
        for (i = 0; i < otherProps.length; i++) {
            var op = otherProps[i];
            if (op.name && existing[op.name]) { continue; }
            op.page = p;
            try { doc.addAnnot(op); } catch (e2) {}
        }
        saveReg(doc, reg);

        var tagList = [];
        for (i = 0; i < artNames.length; i++) { tagList.push(describe(reg, artNames[i])); }
        var msg = "Page " + (p + 1) + " replaced.";
        if (tagList.length) {
            msg += "\n\nRestored in their previous positions:\n" + tagList.join("\n") +
                "\n\nIf the new page's figures sit in different spots, use Move Tag to adjust.";
        }
        app.alert({ cMsg: msg, nIcon: 3, cTitle: "Replace Page" });
        return { restored: artNames.length, carried: otherProps.length };
    }

    function askLabel(doc, reg, title) {
        var r = app.response({ cQuestion: "Tag label:", cTitle: title, cDefault: reg.pending || "" });
        if (r === null || r === undefined) { return null; }
        return trim(r);
    }

    function moveTag(doc) {
        if (capture) { cancelCapture(doc); }
        var reg = loadReg(doc);
        var present = sync(doc, reg);
        var label = askLabel(doc, reg, "Move Tag");
        if (!label) { return; }
        var here = [];
        for (var side = 1; side <= 2; side++) {
            var a = present[tagName(label, side)];
            if (a && a.page === doc.pageNum) { here.push(side); }
        }
        if (!here.length) {
            app.alert("Tag " + label + " isn't on this page. Go to the page with the tag you want to move, then try again.");
            return;
        }
        var which = here[0];
        if (here.length === 2) {
            var ans = app.alert({ cTitle: "Move Tag", nIcon: 2, nType: 3, cMsg: "Both " + label + " tags are on this page.\n\nYes: move the first one\nNo: move the second one" });
            if (ans === 2) { return; }
            which = ans === 4 ? 1 : 2;
        }
        saveReg(doc, reg);
        startCapture(doc, "move", { name: tagName(label, which) }, "move", "Click the new spot for tag " + label + ".");
    }

    /** Click-to-delete: click any reference tag (any page) to remove it. */
    function deleteTag(doc) {
        if (capture) {
            // In reference mode, the same thing as the bar's Delete button.
            if (capture.mode === "ref" && capture.doc === doc) { barClick("del", doc); return; }
            cancelCapture(doc);
        }
        startCapture(doc, "del", {}, "delmode",
            "Click a reference tag to delete it. You'll be asked whether to delete both sides or just that one.\n\n" +
            "Click Done on the bar at the top of the page when you've finished.",
            { allPages: true, bar: true, keep: true, buttons: DELETE_BAR_BUTTONS });
        setBarStatus(doc, "Click a tag to delete it");
    }

    // -----------------------------------------------------------------------
    // Updates
    // -----------------------------------------------------------------------
    /** Compare "1.2.10" with "v1.3.0": returns -1, 0 or 1. */
    function compareVersions(a, b) {
        function parts(v) {
            var core = String(v || "").replace(/^\s*v/i, "").split(/[-+]/)[0];
            var p = core.split(".");
            var out = [];
            for (var i = 0; i < 3; i++) { out.push(parseInt(p[i], 10) || 0); }
            return out;
        }
        var x = parts(a);
        var y = parts(b);
        for (var i = 0; i < 3; i++) {
            if (x[i] < y[i]) { return -1; }
            if (x[i] > y[i]) { return 1; }
        }
        return 0;
    }

    /** Pull what we need out of a GitHub "latest release" API response. */
    function parseRelease(body) {
        var r = fromJSON(body);
        if (!r || !r.tag_name) { return null; }
        return {
            version: String(r.tag_name).replace(/^v/i, ""),
            url: r.html_url || RELEASES_URL,
            // Release notes are Markdown; show them as plain text.
            notes: String(r.body || "").replace(/\r/g, "").replace(/\*\*|__|`/g, "")
        };
    }

    function shorten(text, max) {
        text = trim(text);
        return text.length > max ? text.slice(0, max) + "\n..." : text;
    }

    var UPDATER_URL = "reftool-update:install";

    function isWindows() {
        try { return /^WIN/i.test(app.platform); } catch (e) { return false; }
    }

    /** Start the installed Windows updater (registered by the installer). */
    function launchUpdater() {
        ART_privLaunchURL(UPDATER_URL);
    }

    function offerUpdate(rel) {
        var notes = rel.notes ? shorten(rel.notes, 600) + "\n\n" : "";
        if (isWindows()) {
            var ans = app.alert({
                cTitle: "Reference Tool update",
                nIcon: 2,
                nType: 2,
                cMsg: "Version " + rel.version + " is available (you have " + VERSION + ").\n\n" + notes +
                    "Install it now? The updater downloads and checks the new version, " +
                    "then Windows asks for permission to install it. " +
                    "Restart Acrobat when it's done.\n\n" +
                    "Your open PDFs aren't affected."
            });
            if (ans !== 4) { return; }
            try {
                launchUpdater();
                return;
            } catch (e) {
                app.alert({
                    cTitle: "Reference Tool update",
                    nIcon: 1,
                    cMsg: "The updater couldn't be started from Acrobat (" + e + ").\n\n" +
                        "Run \"Update Reference Tool\" from the Start menu instead. The download page will open now."
                });
                openReleasesPage(rel.url);
                return;
            }
        }
        var ans2 = app.alert({
            cTitle: "Reference Tool update",
            nIcon: 2,
            nType: 2,
            cMsg: "Version " + rel.version + " is available (you have " + VERSION + ").\n\n" + notes +
                "Open the download page now?"
        });
        if (ans2 === 4) { openReleasesPage(rel.url); }
    }

    function openReleasesPage(url) {
        try { ART_privLaunchURL(url || RELEASES_URL); } catch (e) {
            app.alert("Open this page in your browser:\n\n" + (url || RELEASES_URL));
        }
    }

    /**
     * Ask GitHub for the latest release. quiet = true for the automatic
     * startup check: say nothing unless there is an update.
     */
    function checkForUpdates(doc, quiet) {
        setGlobal("ART_lastUpdateCheck", new Date().getTime());
        var handled = false;
        function done(err, body) {
            if (handled) { return; }
            handled = true;
            var rel = err ? null : parseRelease(body);
            if (!rel) {
                if (quiet) { return; }
                var ans = app.alert({
                    cTitle: "Check for Updates",
                    nIcon: 2,
                    nType: 2,
                    cMsg: "Acrobat couldn't reach GitHub to check for updates" +
                        (err ? " (" + err + ")" : "") + ".\n\n" +
                        "You have version " + VERSION + ". Open the releases page in your browser?"
                });
                if (ans === 4) { openReleasesPage(RELEASES_URL); }
                return;
            }
            if (compareVersions(rel.version, VERSION) > 0) {
                offerUpdate(rel);
            } else if (!quiet) {
                app.alert({ cTitle: "Check for Updates", nIcon: 3, cMsg: "You have the latest version (" + VERSION + ")." });
            }
        }
        try {
            ART_privHttpGet(LATEST_API, done);
        } catch (e) {
            done(e, null);
        }
        return handled;
    }

    function autoCheckDue() {
        if (!cfg.autoUpdateCheck) { return false; }
        var last = Number(getGlobal("ART_lastUpdateCheck", 0)) || 0;
        return (new Date().getTime() - last) > cfg.checkIntervalDays * 86400000;
    }

    function about() {
        app.alert({
            cTitle: "Reference Tool",
            nIcon: 3,
            cMsg: "Workpaper Reference Tool " + VERSION + "\n" + RELEASES_URL + "\n\n" +
                "Find these commands under Menu > Plugins > For editing > Reference Tool (new Acrobat) or Edit > Reference Tool (classic).\n\n" +
                "Reference Tool: click it, then click a figure and click its match (any page). Numbers run on automatically; " +
                "use the bar at the top of the page to Undo, change Options or finish (Done).\n" +
                "Calc Tape: a calculator at the top of the page. Type an amount, then + or - (or * / by the next number); " +
                "Place on page, then click where the tape goes. Double-click a tape to change it; drag a corner to resize it.\n" +
                "Tag Check: list all tags and flag unmatched or broken ones.\n" +
                "Replace Page: swap in a new version of a page and keep its tags.\n" +
                "Repair Tags: restore tags or tapes lost outside the tool.\n\n" +
                "Toolbar: add the buttons via the toolbar's Customize option (look under Add-on tools / Custom tools)."
        });
    }

    // -----------------------------------------------------------------------
    // Toolbar buttons and menu
    // -----------------------------------------------------------------------
    /** True when Acrobat refused because the PDF is protected. */
    function isProtectedError(e) {
        var t = String((e && e.name) || "") + " " + String(e);
        return /NotAllowedError|Security settings prevent/i.test(t);
    }

    function showError(id, e) {
        if (isProtectedError(e)) {
            app.alert({
                cTitle: "Reference Tool",
                nIcon: 1,
                cMsg: "This PDF is protected, so Acrobat won't let anything be added to it. " +
                    "It may be certified or digitally signed (look for a blue bar at the top), " +
                    "or secured with a password or restrictions.\n\n" +
                    "To reference it, work from an unprotected copy:\n" +
                    "- combine it into your work paper with Combine Files and tag the combined PDF, or\n" +
                    "- print it to \"Adobe PDF\"/\"Microsoft Print to PDF\" and use that copy.\n\n" +
                    "Keep the original file with your support if the signature matters."
            });
            return;
        }
        app.alert("Reference Tool error in " + id + ":\n\n" + e + (e && e.lineNumber ? " (line " + e.lineNumber + ")" : ""));
    }

    // -----------------------------------------------------------------------
    // Toolbar icons (20 x 20). Letters are colours; "." is transparent.
    // -----------------------------------------------------------------------
    var ICON_COLORS = { r: "FFC62828", b: "FF1F4E9A", k: "FF333333", g: "FF2E7D32", y: "FFFFF59D", w: "FFFFFFFF" };
    var ICONS = {
        placeTag: [
            "....................",
            "....................",
            "rrrrrrrr............",
            "ryyyyyyr............",
            "ryrrryyr............",
            "ryryryyr............",
            "ryrrryyr............",
            "ryryryyr...bb.......",
            "ryryryyr..b..b......",
            "rrrrrrrrbb....b.....",
            ".........b.....b....",
            "..........b.....bbbb",
            "...........b....b..b",
            "............b..b...b",
            "............rrrrrrrr",
            "............ryyyyyyr",
            "............ryrrryyr",
            "............ryryryyr",
            "............ryrrryyr",
            "............rrrrrrrr"
        ],
        calcTape: [
            "...kkkkkkkkkkkk.....",
            "...kwwwwwwwwwwk.....",
            "...kwbbbbbbbbwk.....",
            "...kwbbbbbbbbwk.....",
            "...kwwwwwwwwwwk.....",
            "...kwkkwkkwkkwk.....",
            "...kwkkwkkwkkwk.....",
            "...kwwwwwwwwwwk.....",
            "...kwkkwkkwkkwk.....",
            "...kwkkwkkwkkwk.....",
            "...kwwwwwwwwwwk.....",
            "...kwkkwkkwrrwk.....",
            "...kwkkwkkwrrwk.....",
            "...kwwwwwwwwwwk.....",
            "...kkkkkkkkkkkk.....",
            ".....wwwwwwwwww.....",
            ".....wkkkkkkkkw.....",
            ".....wwwwwwwwww.....",
            ".....wkkkkkkw.......",
            ".....wwwwwwww......."
        ],
        tagCheck: [
            "....................",
            "..kkkkkkkkkkkk......",
            "..kwwwwwwwwwwk......",
            "..kwrrrwwwwwwk......",
            "..kwwwwwwwwwwk......",
            "..kwrrrwkkkkwk......",
            "..kwwwwwwwwwwk......",
            "..kwrrrwkkkkwk......",
            "..kwwwwwwwwwwk......",
            "..kwrrrwkkkwwk.....g",
            "..kwwwwwwwwwwk....gg",
            "..kwrrrwkkkk.....gg.",
            "..kwwwwwwwww....gg..",
            "..kwrrrwkk.g...gg...",
            "..kwwwwwww.gg.gg....",
            "..kkkkkkkk..ggg.....",
            ".............g......",
            "....................",
            "....................",
            "...................."
        ],
        replacePage: [
            "kkkkkkkkk...........",
            "kwwwwwwwk...........",
            "kwkkkkkwk...........",
            "kwwwwwwwk...........",
            "kwkkkkkwk...b.......",
            "kwwwwwwwk...bb......",
            "kwkkkkkwkbbbbbb.....",
            "kwwwwwwwk...bb......",
            "kkkkkkkkk...b.......",
            "...........bbbbbbbbb",
            "...........bwwwwwwwb",
            "...........bwrrwwwwb",
            "...........bwwwwwwwb",
            "...........bwbbbbbwb",
            "...........bwwwwwwwb",
            "...........bwbbbbbwb",
            "...........bwwwwwwwb",
            "...........bwbbbwwwb",
            "...........bwwwwwwwb",
            "...........bbbbbbbbb"
        ],
        repairTags: [
            "....................",
            ".......bbbbbb.......",
            ".....bb......bb.....",
            "....b..........b....",
            "...b............b...",
            "..b..............b..",
            "..b...rrrrrrr....bbb",
            ".b....ryyyyyr.....b.",
            ".b....ryrrryr.......",
            ".b....ryrryyr.......",
            ".b....ryrrryr.....b.",
            ".b....ryyyyyr.....b.",
            "bbb...rrrrrrr....b..",
            ".b...............b..",
            "..................b.",
            "...b.............b..",
            "....b..........b....",
            ".....bb......bb.....",
            ".......bbbbbb.......",
            "...................."
        ]
    };

    /** Build the icon object Acrobat's addToolButton expects. */
    function makeIcon(rows) {
        var hex = "";
        for (var y = 0; y < rows.length; y++) {
            for (var x = 0; x < 20; x++) {
                var ch = rows[y].charAt(x);
                hex += ICON_COLORS[ch] || "00000000";
            }
        }
        return {
            count: 0,
            width: 20,
            height: 20,
            read: function (nBytes) { return hex.slice(this.count, this.count += 2 * nBytes); }
        };
    }

    var COMMANDS = [
        { id: "placeTag", label: "Reference Tool", short: "Reference", tip: "Reference tool: click a figure, then its match. Click again to finish.", toolbar: true },
        { id: "calcTape", label: "Calc Tape", tip: "Calculator that leaves a tape on the page (select a tape first to change it)", toolbar: true },
        { id: "tagCheck", label: "Tag Check", tip: "List all tags and flag unmatched or broken ones", toolbar: true },
        { id: "replacePage", label: "Replace Page (Keep Tags)", tip: "Replace this page and keep its tags and tapes", toolbar: true },
        { id: "repairTags", label: "Repair Tags", tip: "Restore lost tags/tapes and refresh links", toolbar: true },
        { id: "moveTag", label: "Move Tag", tip: "Move a tag to a new spot", toolbar: false },
        { id: "deleteTag", label: "Delete Tag", tip: "Click a tag to delete it", toolbar: false },
        { id: "checkForUpdates", label: "Check for Updates", tip: "See if a newer version is available", toolbar: false },
        { id: "about", label: "About / Help", tip: "How to use the Reference Tool", toolbar: false }
    ];

    var api = {
        version: VERSION,
        config: cfg,
        placeTag: placeTag,
        calcTape: calcTape,
        tagCheck: tagCheck,
        replacePage: replacePage,
        repairTags: repairTags,
        moveTag: moveTag,
        deleteTag: deleteTag,
        about: about,
        checkForUpdates: function (doc) { return checkForUpdates(doc, false); },
        run: function (id, doc) {
            try {
                if (!doc && id !== "about" && id !== "checkForUpdates") { app.alert("Open a PDF first."); return; }
                rememberDoc(doc);
                return api[id](doc);
            } catch (e) {
                showError(id, e);
            }
        },
        isActive: function () { return refIsActive(); },
        _bar: function (id, doc) {
            try { barClick(id, doc); } catch (e) { showError("reference bar", e); }
        },
        _onCapture: function (doc, page, x, y) {
            try { onCapture(doc, page, x, y); } catch (e) { showError("placing", e); }
        },
        _followPage: function () {
            try { followPage(); } catch (e) { stopFollow(); }
        },
        _calcKey: function (doc, ev) {
            try { calcKey(doc, ev); } catch (e) { showError("Calc Tape", e); }
        },
        _calcEdit: function (doc, ev, id) {
            try { calcEdit(doc, ev, id); } catch (e) { showError("Calc Tape", e); }
        },
        _calcFocus: function (doc, on) {
            if (capture && capture.mode === "calc" && capture.doc === doc) { capture.focused = !!on; }
        },
        _calcBtn: function (doc, id) {
            try { calcButton(doc, id); } catch (e) { showError("Calc Tape", e); }
        },
        _tapeClick: function (doc, name, page, x, y) {
            try { tapeClick(doc, name, page, x, y); } catch (e) { showError("Calc Tape", e); }
        },
        _runLater: function () { runLater(); },
        _watch: function () {
            try { watchTick(); } catch (e) {}
        },
        _removeCapture: function () {
            var d = api._pendingRemoval;
            api._pendingRemoval = null;
            try { if (ART_timer) { app.clearTimeOut(ART_timer); } } catch (e) {}
            ART_timer = null;
            if (d) { removeCaptureField(d); }
        },
        _pendingRemoval: null,
        // exposed for testing
        _autoCheck: function () {
            try { if (autoCheckDue()) { checkForUpdates(null, true); } } catch (e) {}
        },
        _internal: {
            compareVersions: compareVersions,
            parseRelease: parseRelease,
            computeTape: computeTape,
            formatTape: formatTape,
            parseTapeText: parseTapeText,
            calcKeyAction: calcKeyAction,
            refitTape: refitTape,
            tapeSize: tapeSize,
            tapeBodyRect: tapeBodyRect,
            watchState: function () { return watch; },
            parseAmount: parseAmount,
            fmt: fmt,
            loadReg: loadReg,
            sync: sync,
            linkScript: linkScript,
            toRotatedRect: toRotatedRect,
            buildReport: buildReport,
            getCapture: function () { return capture; },
            makeIcon: makeIcon,
            tapePreview: tapePreview,
            icons: ICONS
        },
        installUI: function () {
            var i;
            var c;
            // Edit first. Classic Acrobat shows it as Edit > Reference Tool; the new
            // Acrobat shows add-on items from Edit under Menu > Plugins > For editing.
            // The new Acrobat's top-level "AV2::HamburgerMenu" accepts a submenu without
            // an error but never displays it (Acrobat 26.0, 2026-09-25), so it's last.
            var parents = ["Edit", "Tools", "Help", "AV2::HamburgerMenu"];
            api.menuParent = null;
            for (i = 0; i < parents.length && !api.menuParent; i++) {
                try {
                    app.addSubMenu({ cName: "ARTMenu", cUser: "Reference Tool", cParent: parents[i] });
                    api.menuParent = parents[i];
                } catch (e) {}
            }
            for (i = 0; i < COMMANDS.length; i++) {
                c = COMMANDS[i];
                var exec = "ARTool.run('" + c.id + "', event.target);";
                try {
                    app.addMenuItem({ cName: "ARTMenu_" + c.id, cUser: c.label, cParent: "ARTMenu", cExec: exec });
                } catch (e2) {}
                if (c.toolbar) {
                    var btn = {
                        cName: "ARTBtn_" + c.id,
                        cLabel: c.short || c.label.replace(" (Keep Tags)", ""),
                        cExec: exec,
                        cTooltext: c.tip,
                        cEnable: "event.rc = (event.target != null);"
                    };
                    if (c.id === "placeTag") { btn.cMarked = "event.rc = ARTool.isActive();"; }
                    if (ICONS[c.id]) { btn.oIcon = makeIcon(ICONS[c.id]); }
                    try {
                        app.addToolButton(btn);
                    } catch (e3) {
                        // Older Acrobat may reject an icon; try without.
                        try { delete btn.oIcon; app.addToolButton(btn); } catch (e4) {}
                    }
                }
            }
        }
    };
    return api;
})();

ARTool.installUI();

// Quiet update check a few seconds after Acrobat starts.
var ART_updateTimer = app.setTimeOut("ARTool._autoCheck()", 8000);

// Tape watcher: re-fits a tape's text after it's resized and keeps its
// double-click button on it. Only looks at the page being viewed.
try { ART_watchTimer = app.setInterval("ARTool._watch()", 500); } catch (e) {}

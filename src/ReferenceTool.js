/*
 * Workpaper Reference Tool for Adobe Acrobat Pro
 * ------------------------------------------------
 * Folder-level JavaScript add-on. Copy this file into Acrobat's
 * JavaScripts folder (see README.md) and restart Acrobat.
 *
 * Features
 *   - Place Tag    : paired reference tags (e.g. A-1 on the financial
 *                    statements <-> A-1 on the support). Clicking either
 *                    tag jumps to its match. The jump works in any copy of
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

var ART_timer = null;

var ARTool = (function () {
    var VERSION = "0.2.2";
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
        if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
        if (s.charAt(0) === "-") { neg = !neg; s = s.slice(1); }
        if (s.charAt(s.length - 1) === "%") { pct = true; s = s.slice(0, -1); }
        if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) { return null; }
        var v = parseFloat(s);
        if (pct) { v = v / 100; }
        return neg ? -v : v;
    }

    /**
     * Parse tape entries, one per line:
     *   [op] amount [description]
     * op is one of + - * x / (default +). "=" or "sub" on its own line
     * inserts a subtotal. Returns {rows, total, errors}.
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
            var m = line.match(/^([+\-*\/xX×÷])(?=[\s\d.($])\s*(.*)$/);
            if (m) {
                op = m[1];
                if (op === "x" || op === "X" || op === "×") { op = "*"; }
                if (op === "÷") { op = "/"; }
                line = m[2];
            }
            var nm = line.match(/^(\(?\$?\s*(?:[\d,]*\.?\d+)\)?%?)\s*(.*)$/);
            var val = nm ? parseAmount(nm[1]) : null;
            if (val === null) {
                errors.push("Line " + (i + 1) + ": can't read an amount in \"" + trim(lines[i]) + "\"");
                continue;
            }
            var desc = nm[2] ? trim(nm[2]) : "";
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
            rows.push({ op: op, value: val, desc: desc });
        }
        if (!rows.length && !errors.length) { errors.push("Enter at least one amount."); }
        return { rows: rows, total: total, errors: errors };
    }

    /** Render a computed tape as monospaced text. */
    function formatTape(title, calc, initials) {
        var nums = [];
        var i;
        for (i = 0; i < calc.rows.length; i++) {
            var r = calc.rows[i];
            nums.push(r.op === "*" || r.op === "/" ? String(r.value) : fmt(r.value));
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
            out.push(pad(nums[i], w, true) + " " + sym + (row.desc ? "  " + row.desc : ""));
        }
        out.push(pad("", w + 2).replace(/ /g, "="));
        out.push(pad(totalStr, w, true) + " T  Total");
        out.push("Prepared" + (initials ? " by " + trim(initials) : "") + " " + today());
        return out.join("\n");
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
        var h = cfg.tagFontSize + 6;
        var w = Math.max(20, label.length * cfg.tagFontSize * 0.62 + 10);
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

    function addTag(doc, reg, label, side, page, rect) {
        rect = clampRect(doc, page, rect);
        var a = doc.addAnnot({
            type: "FreeText",
            page: page,
            rect: rect,
            name: tagName(label, side),
            author: "Reference Tool",
            subject: "Reference tag",
            contents: label,
            fillColor: cfg.tagFill,
            strokeColor: cfg.tagBorder,
            width: 0.75,
            textFont: "Helvetica-Bold",
            textSize: cfg.tagFontSize,
            alignment: 1
        });
        try {
            var sp = {};
            sp.text = label;
            sp.textColor = cfg.tagText;
            sp.textSize = cfg.tagFontSize;
            sp.fontWeight = 700;
            sp.alignment = "center";
            a.richContents = [sp];
        } catch (e) {}
        try { a.print = true; } catch (e2) {}
        // Read-only so clicks pass through to the link underneath.
        try { a.readOnly = true; } catch (e3) {}
        reg.items[a.name] = { kind: "tag", label: label, side: side, page: page, rect: copyRect(a.rect) };
        rebuildLink(doc, a, reg);
        return a;
    }

    function tapeSize(text) {
        var lines = String(text).split("\n");
        var longest = 0;
        for (var i = 0; i < lines.length; i++) { if (lines[i].length > longest) { longest = lines[i].length; } }
        return [longest * cfg.tapeFontSize * 0.6 + 12, lines.length * cfg.tapeFontSize * 1.2 + 10];
    }

    function addTape(doc, reg, page, rect, text, name) {
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
            textSize: cfg.tapeFontSize,
            alignment: 0
        });
        try {
            var sp = {};
            sp.text = text;
            sp.fontFamily = ["Courier", "monospace"];
            sp.textSize = cfg.tapeFontSize;
            sp.textColor = ["RGB", 0, 0, 0];
            a.richContents = [sp];
        } catch (e) {}
        try { a.print = true; } catch (e2) {}
        reg.items[a.name] = { kind: "tape", page: page, rect: copyRect(a.rect), contents: text };
        return a;
    }

    /** Re-create a tag or tape from its register entry. */
    function restoreItem(doc, reg, name, item, page) {
        var pg = (page === undefined) ? item.page : page;
        if (item.kind === "tag") { return addTag(doc, reg, item.label, item.side, pg, item.rect); }
        return addTape(doc, reg, pg, item.rect, item.contents, name);
    }

    function destroyArt(doc, reg, annot) {
        var item = reg.items[annot.name];
        if (item && item.kind === "tag") {
            if (item.linkRect && item.linkPage === annot.page) { removeLinkAt(doc, item.linkPage, item.linkRect); }
            removeLinkAt(doc, annot.page, toRotatedRect(doc, annot.page, annot.rect));
        }
        try { annot.destroy(); } catch (e) {}
    }

    // -----------------------------------------------------------------------
    // Click capture: a temporary transparent button covering the page
    // records where the user clicks, then removes itself.
    // -----------------------------------------------------------------------
    function removeCaptureField(doc) {
        try { if (doc.getField(CAPTURE_FIELD)) { doc.removeField(CAPTURE_FIELD); } } catch (e) {}
    }

    function cancelCapture(doc) {
        removeCaptureField(doc);
        if (capture && capture.doc !== doc) { removeCaptureField(capture.doc); }
        capture = null;
    }

    function startCapture(doc, mode, data, tipKey, tipMsg) {
        cancelCapture(doc);
        var p = doc.pageNum;
        var box = doc.getPageBox("Crop", p);
        var f = doc.addField(CAPTURE_FIELD, "button", p, box);
        try { f.borderStyle = border.d; } catch (e) {}
        try { f.lineWidth = 2; } catch (e2) {}
        try { f.strokeColor = color.blue; } catch (e3) {}
        try { f.fillColor = color.transparent; } catch (e4) {}
        try { f.highlight = highlight.n; } catch (e5) {}
        try { f.display = display.noPrint; } catch (e6) {}
        try { f.userName = "Click to place (Reference Tool)"; } catch (e7) {}
        f.setAction("MouseUp",
            "if(typeof ARTool!=='undefined'){ARTool._onCapture(this,event.target.page,this.mouseX,this.mouseY);}" +
            "else{try{this.removeField('" + CAPTURE_FIELD + "');}catch(e){}}");
        capture = { doc: doc, page: p, mode: mode, data: data };
        if (tipKey) { tip(tipKey, tipMsg); }
    }

    function onCapture(doc, page, mx, my) {
        var c = capture;
        capture = null;
        // Remove the capture field after this click event has finished.
        ART_timer = app.setTimeOut("ARTool._removeCapture()", 50);
        ARTool._pendingRemoval = doc;
        if (!c || c.doc !== doc) { return; }
        if (typeof page !== "number") { page = c.page; }
        var g = pageGeom(doc, page);
        var x = Number(mx);
        var y = Number(my);
        if (cfg.mouseYFromTop) { y = g.h - y; }
        x = Math.max(0, Math.min(g.w, x));
        y = Math.max(0, Math.min(g.h, y));
        var reg = loadReg(doc);
        sync(doc, reg);
        if (c.mode === "tag") {
            finishTag(doc, reg, c.data.label, c.data.side, page, tagRectAt(c.data.label, x, y));
        } else if (c.mode === "tape") {
            var s = tapeSize(c.data.text);
            addTape(doc, reg, page, [x, y - s[1], x + s[0], y], c.data.text);
        } else if (c.mode === "move") {
            var a = findAnnot(doc, c.data.name);
            if (a) {
                var p = parseName(a.name);
                var item = reg.items[a.name];
                destroyArt(doc, reg, a);
                var nr = tagRectAt(p.label, x, y);
                if (page !== item.page) { item.linkRect = null; }
                addTag(doc, reg, p.label, p.side, page, nr);
            }
        }
        saveReg(doc, reg);
    }

    function finishTag(doc, reg, label, side, page, rect) {
        addTag(doc, reg, label, side, page, rect);
        var m = label.match(/^(.*?)(\d+)$/);
        if (m && m[1] === reg.prefix && Number(m[2]) >= reg.next) { reg.next = Number(m[2]) + 1; }
        if (side === 1) {
            reg.pending = label;
            saveReg(doc, reg);
            tip("afterSide1", "Tag " + label + " placed (1 of 2).\n\nGo to the supporting page and click Place Tag again to place its match.");
        } else {
            reg.pending = null;
            saveReg(doc, reg);
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
    function placeTag(doc) {
        if (capture) { cancelCapture(doc); return; }
        var reg = loadReg(doc);
        var present = sync(doc, reg);
        var label = null;
        var side = 1;

        if (reg.pending) {
            var ans = app.alert({
                cTitle: "Place Tag",
                nIcon: 2,
                nType: 3,
                cMsg: "Tag " + reg.pending + " is waiting for its match.\n\n" +
                    "Yes: place the matching " + reg.pending + " now\n" +
                    "No: leave it unmatched and start a new tag\n" +
                    "Cancel: do nothing"
            });
            if (ans === 4) { label = reg.pending; side = 2; }
            else if (ans === 3) { reg.pending = null; }
            else { return; }
        }

        if (!label) {
            var dflt = reg.prefix + reg.next;
            var r = app.response({
                cQuestion: "Label for this reference tag:",
                cTitle: "Place Tag",
                cDefault: dflt
            });
            if (r === null || r === undefined) { return; }
            r = trim(r);
            if (!r || r.indexOf(":") >= 0) { app.alert("Please use a label without colons, e.g. " + dflt + "."); return; }
            if (present[tagName(r, 1)] || present[tagName(r, 2)]) {
                app.alert("Tag " + r + " is already in use. Choose another label, or use Move Tag / Delete Tag.");
                return;
            }
            var m = r.match(/^(.*?)(\d+)$/);
            if (m && m[1] !== reg.prefix) { reg.prefix = m[1]; reg.next = Number(m[2]); }
            label = r;
            side = 1;
        }

        // Shortcut: if one ordinary comment (e.g. a rectangle drawn around
        // the number) is selected, put the tag just to its right.
        var marker = selectedMarker(doc);
        if (marker) {
            var mr = marker.rect;
            var s = tagSize(label);
            var cx = mr[2] + s[0] / 2 + 2;
            var cy = (mr[1] + mr[3]) / 2;
            finishTag(doc, reg, label, side, marker.page, tagRectAt(label, cx, cy));
            return;
        }

        saveReg(doc, reg);
        startCapture(doc, "tag", { label: label, side: side }, "capture",
            "Click on the page where tag " + label + " should go.\n\n" +
            "(A blue dashed frame shows the page is waiting for your click. " +
            "Click Place Tag again to cancel.)");
    }

    function tapeDialog(prefill) {
        var result = null;
        var dlg = {
            initialize: function (d) {
                d.load({ titl: prefill.titl, ents: prefill.ents, init: prefill.init, prev: "" });
            },
            prvw: function (d) {
                var r = d.store();
                var calc = computeTape(r.ents);
                var txt = formatTape(r.titl, calc, r.init);
                if (calc.errors.length) { txt = calc.errors.join("\n") + "\n\n" + txt; }
                d.load({ prev: txt });
            },
            commit: function (d) { result = d.store(); },
            description: {
                name: "Calculator Tape",
                elements: [{
                    type: "view",
                    align_children: "align_row",
                    elements: [
                        {
                            type: "view",
                            align_children: "align_left",
                            elements: [
                                { type: "static_text", name: "Title:" },
                                { type: "edit_text", item_id: "titl", width: 300 },
                                { type: "static_text", name: "Entries (one per line):  [+ - * /] amount  description" },
                                { type: "static_text", name: "(800) or -800 = negative.   =  on its own line = subtotal." },
                                { type: "edit_text", item_id: "ents", multiline: true, width: 300, height: 220 },
                                { type: "static_text", name: "Initials:" },
                                { type: "edit_text", item_id: "init", width: 80 },
                                { type: "button", item_id: "prvw", name: "Preview tape" }
                            ]
                        },
                        {
                            type: "view",
                            align_children: "align_left",
                            elements: [
                                { type: "static_text", name: "Preview:" },
                                { type: "edit_text", item_id: "prev", multiline: true, readonly: true, width: 320, height: 330 }
                            ]
                        }
                    ]
                }, { type: "ok_cancel", ok_name: "Place on page" }]
            }
        };
        var btn = app.execDialog(dlg);
        return btn === "ok" ? result : null;
    }

    function calcTape(doc) {
        if (capture) { cancelCapture(doc); }
        var prefill = { titl: "", ents: "", init: getGlobal("ART_initials", "") };
        while (true) {
            var r = tapeDialog(prefill);
            if (!r) { return; }
            prefill = { titl: r.titl, ents: r.ents, init: r.init };
            var calc = computeTape(r.ents);
            if (calc.errors.length) {
                app.alert("Please fix these entries:\n\n" + calc.errors.join("\n"));
                continue;
            }
            setGlobal("ART_initials", r.init || "");
            var text = formatTape(r.titl, calc, r.init);
            startCapture(doc, "tape", { text: text }, "tape",
                "Click where the top-left corner of the tape should go.\n\nYou can drag the tape afterwards.");
            return;
        }
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
        // Refresh every link so moved or restored tags are clickable.
        present = sync(doc, reg);
        var linked = 0;
        for (var n in present) {
            if (present.hasOwnProperty(n) && reg.items[n].kind === "tag") { rebuildLink(doc, present[n], reg); linked++; }
        }
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

    function deleteTag(doc) {
        if (capture) { cancelCapture(doc); }
        var reg = loadReg(doc);
        var present = sync(doc, reg);
        var label = askLabel(doc, reg, "Delete Tag");
        if (!label) { return; }
        var n1 = tagName(label, 1);
        var n2 = tagName(label, 2);
        if (!reg.items[n1] && !reg.items[n2]) { app.alert("No tag named " + label + " was found."); return; }
        if (app.alert({ cTitle: "Delete Tag", nIcon: 2, nType: 2, cMsg: "Delete both " + label + " tags?" }) !== 4) { return; }
        var names = [n1, n2];
        for (var i = 0; i < names.length; i++) {
            if (present[names[i]]) { destroyArt(doc, reg, present[names[i]]); }
            delete reg.items[names[i]];
        }
        if (reg.pending === label) { reg.pending = null; }
        saveReg(doc, reg);
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
            notes: String(r.body || "").replace(/\r/g, "")
        };
    }

    function shorten(text, max) {
        text = trim(text);
        return text.length > max ? text.slice(0, max) + "\n..." : text;
    }

    function offerUpdate(rel) {
        var ans = app.alert({
            cTitle: "Reference Tool update",
            nIcon: 2,
            nType: 2,
            cMsg: "Version " + rel.version + " is available (you have " + VERSION + ").\n\n" +
                (rel.notes ? shorten(rel.notes, 600) + "\n\n" : "") +
                "To install it: close Acrobat and run \"Update Reference Tool\" from the Start menu " +
                "(Windows), or download the new release and run the installer.\n\n" +
                "Open the download page now?"
        });
        if (ans === 4) { openReleasesPage(rel.url); }
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
                "Find these commands under Menu > Reference Tool (new Acrobat) or Edit > Reference Tool (classic).\n\n" +
                "Place Tag: click Place Tag, click the figure; go to the support, click Place Tag, click the matching figure.\n" +
                "Calc Tape: enter the calculation, then click where the tape goes.\n" +
                "Tag Check: list all tags and flag unmatched or broken ones.\n" +
                "Replace Page: swap in a new version of a page and keep its tags.\n" +
                "Repair Tags: restore tags or tapes lost outside the tool.\n\n" +
                "Tip: draw a rectangle comment around a figure and keep it selected before clicking Place Tag to put the tag right beside it."
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

    var COMMANDS = [
        { id: "placeTag", label: "Place Tag", tip: "Place a reference tag (statement, then support)", toolbar: true },
        { id: "calcTape", label: "Calc Tape", tip: "Calculator that leaves a tape on the page", toolbar: true },
        { id: "tagCheck", label: "Tag Check", tip: "List all tags and flag unmatched or broken ones", toolbar: true },
        { id: "replacePage", label: "Replace Page (Keep Tags)", tip: "Replace this page and keep its tags and tapes", toolbar: true },
        { id: "repairTags", label: "Repair Tags", tip: "Restore lost tags/tapes and refresh links", toolbar: true },
        { id: "moveTag", label: "Move Tag", tip: "Move a tag to a new spot", toolbar: false },
        { id: "deleteTag", label: "Delete Tag", tip: "Delete both sides of a tag", toolbar: false },
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
                return api[id](doc);
            } catch (e) {
                showError(id, e);
            }
        },
        _onCapture: function (doc, page, x, y) {
            try { onCapture(doc, page, x, y); } catch (e) { showError("placing", e); }
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
            parseAmount: parseAmount,
            fmt: fmt,
            loadReg: loadReg,
            sync: sync,
            linkScript: linkScript,
            toRotatedRect: toRotatedRect,
            buildReport: buildReport,
            getCapture: function () { return capture; }
        },
        installUI: function () {
            var i;
            var c;
            // New Acrobat interface: the hamburger "Menu" (top left).
            // Classic interface: the Edit menu. Use the first that exists.
            var parents = ["AV2::HamburgerMenu", "Edit", "Tools", "Help"];
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
                    try {
                        app.addToolButton({
                            cName: "ARTBtn_" + c.id,
                            cLabel: c.label.replace(" (Keep Tags)", ""),
                            cExec: exec,
                            cTooltext: c.tip,
                            cEnable: "event.rc = (event.target != null);"
                        });
                    } catch (e3) {}
                }
            }
        }
    };
    return api;
})();

ARTool.installUI();

// Quiet update check a few seconds after Acrobat starts.
var ART_updateTimer = app.setTimeOut("ARTool._autoCheck()", 8000);

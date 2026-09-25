/*
 * Test harness: runs ReferenceTool.js against a mock of the Acrobat
 * JavaScript API in Node. This checks the add-on's logic (tapes, tag
 * pairing, register, repair, replace page); it cannot check how Acrobat
 * itself draws things, so a manual test in Acrobat Pro is still needed.
 *
 *   node test/run-tests.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// ---------------------------------------------------------------- mocks
function makeEnvWith(menuParents) { return makeEnv(menuParents); }
function makeEnv(menuParents) {
  const env = { menuParents: menuParents || null, httpRequests: [], launched: [], alerts: [], alertAnswers: [], responses: [], dialogs: [], dialogResults: [], timers: [] };

  class Annot {
    constructor(doc, props) { this._doc = doc; Object.assign(this, props); if (!this.name) this.name = "auto" + Math.random(); this.rect = props.rect.slice(); }
    getProps() { const o = {}; for (const k of Object.keys(this)) if (k[0] !== "_") o[k] = Array.isArray(this[k]) ? this[k].slice() : this[k]; return o; }
    destroy() {
      if (this.readOnly) throw new Error("NotAllowedError: annotation is read-only"); // like Acrobat
      this._doc._annots = this._doc._annots.filter(a => a !== this);
    }
  }
  class Link {
    constructor(page, rect) { this.page = page; this.rect = rect; this.action = null; }
    setAction(s) { this.action = s; }
  }
  class Doc {
    constructor(pages) {
      this.numPages = pages; this.pageNum = 0; this.info = {}; this._annots = []; this._links = []; this._fields = {};
      this._rot = {}; this.selectedAnnots = [];
    }
    syncAnnotScan() {}
    getAnnots(o) { const r = this._annots.filter(a => !o || a.page === o.nPage); return r.length ? r : null; }
    addAnnot(p) {
      if (p.page >= this.numPages) throw new Error("bad page");
      const a = new Annot(this, p);
      this._annots.push(a);
      return a;
    }
    addLink(p, r) { const l = new Link(p, r); this._links.push(l); return l; }
    removeLinks(p, r) {
      this._links = this._links.filter(l => !(l.page === p && l.rect[0] >= r[0] && l.rect[1] >= r[1] && l.rect[2] <= r[2] && l.rect[3] <= r[3]));
    }
    addField(name, type, p, box) {
      let f = this._fields[name];
      if (!f) {
        f = { name, widgets: [], caption: "", setAction(ev, s) { this.script = s; }, buttonSetCaption(c) { this.caption = c; } };
        this._fields[name] = f;
      }
      f.widgets.push({ page: p, box });
      f.page = f.widgets.length === 1 ? p : f.widgets.map(w => w.page);
      return f;
    }
    getField(n) { return this._fields[n] || null; }
    removeField(n) { for (const k of Object.keys(this._fields)) if (k === n || k.indexOf(n + ".") === 0) delete this._fields[k]; }
    get numFields() { return Object.keys(this._fields).length; }
    getNthFieldName(i) { return Object.keys(this._fields)[i]; }
    fieldNames() { return Object.keys(this._fields).sort(); }
    getPageBox(t, p) { const r = this._rot[p] || 0; return (r === 90 || r === 270) ? [0, 612, 792, 0] : [0, 792, 612, 0]; } // rotated user space, like Acrobat
    getPageRotation(p) { return this._rot[p] || 0; }
    replacePages(o) {
      // Worst case: the new page arrives with nothing on it.
      this._annots = this._annots.filter(a => a.page !== o.nPage);
      this._links = this._links.filter(l => l.page !== o.nPage);
      this._replaced = o;
    }
    scroll() {}
    // helper: simulate a user click on the page (the capture field over it)
    click(x, y, page) {
      if (page === undefined) page = this.pageNum;
      const f = this._fields["ART_CAP.p" + page];
      assert(f, "capture field should exist on page " + page);
      const fn = new (vm.runInContext("Function", ctx))("event", f.script.replace(/this\.mouseX/g, x).replace(/this\.mouseY/g, y));
      fn.call(this, { target: f });
      runTimers();
    }
    // helper: click a button on the reference options bar
    bar(id) {
      const f = this._fields["ART_BAR." + id];
      assert(f, "bar button " + id + " should exist");
      new (vm.runInContext("Function", ctx))("event", f.script).call(this, { target: f });
      runTimers();
    }
    status() { const f = this._fields["ART_BAR.status"]; return f ? f.caption : null; }
  }

  let ctx;
  const app = {
    trustedFunction: f => f, beginPriv() {}, endPriv() {},
    alert(o) {
      env.alerts.push(typeof o === "string" ? o : o.cMsg);
      if (o && o.oCheckbox) o.oCheckbox.bAfterValue = true; // hide tips after first time
      return env.alertAnswers.length ? env.alertAnswers.shift() : 4;
    },
    response() { return env.responses.shift(); },
    execDialog(d) {
      env.dialogs.push(d);
      const loaded = {};
      let res = env.dialogResults.shift();
      if (res === undefined) res = {}; // accept the dialog as shown
      const dlg = { enable() {}, load(o) { Object.assign(loaded, o); }, store() { return Object.assign({}, loaded, typeof res === "object" ? res : {}); } };
      if (d.initialize) d.initialize(dlg);
      if (d.prvw) d.prvw(dlg);
      env.lastPreview = loaded.prev;
      if (res === "cancel") return "cancel";
      if (d.commit) d.commit(dlg);
      return "ok";
    },
    browseForDoc() { return { cPath: "/new-statement.pdf", cFS: "DOS" }; },
    launchURL(u) { env.launched.push(u); },
    setTimeOut(expr) { env.timers.push(expr); return { id: 1 }; },
    clearTimeOut() {},
    addSubMenu(o) {
      if (env.menuParents && env.menuParents.indexOf(o.cParent) < 0) throw new TypeError("Invalid argument type.");
      (env.submenus = env.submenus || []).push(o.cParent);
    },
    addMenuItem(o) { (env.menuItems = env.menuItems || []).push(o.cUser); }, addToolButton(o) { (env.buttons = env.buttons || []).push(o.cLabel); (env.buttonObjs = env.buttonObjs || []).push(o); }
  };
  function runTimers() { while (env.timers.length) vm.runInContext(env.timers.shift(), ctx); }

  ctx = vm.createContext({
    app, JSON, Math, Date, String, Number, Array, Object, RegExp, Error, parseInt, parseFloat,
    color: { blue: ["RGB", 0, 0, 1], transparent: ["T"] },
    border: { d: "dashed", s: "solid" }, highlight: { n: "none", p: "push" }, display: { noPrint: 3 },
    global: { setPersistent() {} },
    console: { println: console.log },
    Net: { HTTP: { request(o) {
      env.httpRequests.push(o.cURL);
      const r = env.httpResponse || { err: "offline" };
      o.oHandler.response(r.body || null, o.cURL, r.err || undefined);
    } } },
    SOAP: { stringFromStream: s => s }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "ReferenceTool.js"), "utf8"), ctx, { filename: "ReferenceTool.js" });
  env.ctx = ctx;
  env.ART = ctx.ARTool;
  env.Doc = Doc;
  env.runTimers = runTimers;
  return env;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok   " + name); }
  catch (e) { console.log("  FAIL " + name + "\n       " + (e.stack || e)); process.exitCode = 1; }
}
const names = d => d._annots.map(a => a.name).sort();
// Place one or more reference pairs with the Reference tool: [[page, x, y], [page, x, y]], ...
function refPairs(env, doc, clicks, opts) {
  env.dialogResults.push(opts || {});
  env.ART.run("placeTag", doc);            // start (options dialog accepted)
  for (const c of clicks) doc.click(c[1], c[2], c[0]);
  env.ART.run("placeTag", doc);            // finish
}
const followLink = (env, doc, link) => { new (vm.runInContext("Function", env.ctx))(link.action).call(doc); return doc.pageNum; };

console.log("Reference Tool tests");

test("toolbar buttons install", () => {
  const env = makeEnv();
  assert.deepStrictEqual(env.buttons, ["Reference", "Calc Tape", "Tag Check", "Replace Page", "Repair Tags"]);
});

test("menu goes under the new Acrobat 'Menu', falling back to Edit on classic Acrobat", () => {
  let env = makeEnv();
  assert.strictEqual(env.ART.menuParent, "AV2::HamburgerMenu");
  assert.ok(env.menuItems.indexOf("Reference Tool") >= 0 && env.menuItems.indexOf("Check for Updates") >= 0);
  // classic UI: no hamburger menu
  env = (function () { const e = makeEnvWith(["Edit", "Tools", "Help"]); return e; })();
  assert.strictEqual(env.ART.menuParent, "Edit");
});

test("amount parsing", () => {
  const { parseAmount } = makeEnv().ART._internal;
  assert.strictEqual(parseAmount("1,234.50"), 1234.5);
  assert.strictEqual(parseAmount("(800)"), -800);
  assert.strictEqual(parseAmount("$12"), 12);
  assert.strictEqual(parseAmount("5%"), 0.05);
  assert.strictEqual(parseAmount("abc"), null);
});

test("tape maths: add, subtract, negatives, subtotal, multiply", () => {
  const { computeTape } = makeEnv().ART._internal;
  const c = computeTape("12,400 Cash per bank\n+3,250 Deposit in transit\n-800 O/S cheque\n=\n(50) bank fee\nx 1.1 gross-up");
  assert.strictEqual(c.errors.length, 0);
  assert.strictEqual(c.total, Math.round((12400 + 3250 - 800 - 50) * 1.1 * 1e6) / 1e6);
  assert.strictEqual(c.rows[3].op, "=");
  assert.strictEqual(c.rows[3].value, 14850);
});

test("tape errors are reported, not guessed", () => {
  const { computeTape } = makeEnv().ART._internal;
  assert.strictEqual(computeTape("hello").errors.length, 1);
  assert.strictEqual(computeTape("* 5").errors.length, 1);
  assert.strictEqual(computeTape("10\n/ 0").errors.length, 1);
  assert.strictEqual(computeTape("").errors.length, 1);
});

test("tape formatting lines up", () => {
  const { computeTape, formatTape } = makeEnv().ART._internal;
  const t = formatTape("Bank rec", computeTape("12,400 Cash\n-800 O/S cheque\n=\n5 misc"), "GR");
  const lines = t.split("\n");
  console.log("\n" + t.split("\n").map(l => "         | " + l).join("\n"));
  assert.ok(lines[0].startsWith("TAPE: Bank rec"));
  assert.ok(/11,605\.00  T  Total/.test(t));
  assert.ok(/ 800\.00  -  O\/S cheque/.test(t));
  assert.ok(/Prepared by GR \d{4}-\d{2}-\d{2}/.test(t));
  const numCols = lines.filter(l => /\d\.\d\d[ )]/.test(l) && !/Prepared/.test(l)).map(l => l.search(/[ )] [+\-xST/]/));
  assert.ok(numCols.every(c => c === numCols[0]), "number column aligned: " + numCols);
});

test("reference mode: click, click, click - numbers run on without prompts", () => {
  const env = makeEnv(); const doc = new env.Doc(20);
  env.ART.run("placeTag", doc);
  assert.strictEqual(env.dialogs.length, 1, "options panel shown on start");
  assert.ok(doc.getField("ART_CAP.p0") && doc.getField("ART_CAP.p19"), "capture on every page");
  assert.ok(/A-1 .*click the figure/.test(doc.status()), doc.status());
  const promptsBefore = env.alerts.length + env.responses.length;
  doc.click(300, 400, 0);
  assert.ok(/A-1 .*match/.test(doc.status()), doc.status());
  doc.click(100, 200, 13);                // match on another page, no prompt
  assert.ok(/A-2 .*figure/.test(doc.status()), doc.status());
  doc.click(310, 380, 0);
  doc.click(120, 220, 14);
  assert.ok(/A-3/.test(doc.status()));
  assert.strictEqual(env.dialogs.length, 1, "no more dialogs while placing");
  env.ART.run("placeTag", doc);           // finish
  assert.strictEqual(doc.fieldNames().length, 0, "all capture/bar fields removed");
  assert.deepStrictEqual(names(doc), ["ART:T:A-1:1", "ART:T:A-1:2", "ART:T:A-2:1", "ART:T:A-2:2"]);
  const reg = JSON.parse(doc.info.ARTRegister);
  assert.strictEqual(reg.pending, null);
  assert.strictEqual(reg.next, 3);
  const s1 = doc._annots.find(a => a.name === "ART:T:A-1:1");
  assert.ok(s1.rect[0] < 300 && s1.rect[2] > 300 && s1.rect[1] < 400 && s1.rect[3] > 400, "tag centred on click");
  assert.strictEqual(s1.readOnly, true);
  const l1 = doc._links.find(l => l.page === 0 && l.rect[0] < 300 && l.rect[2] > 300);
  const l2 = doc._links.find(l => l.page === 13);
  doc.pageNum = 5; assert.strictEqual(followLink(env, doc, l1), 13);
  assert.strictEqual(followLink(env, doc, l2), 0);
});

test("reference mode picks up the sequence next time", () => {
  const env = makeEnv(); const doc = new env.Doc(5);
  refPairs(env, doc, [[0, 10, 10], [1, 10, 10]]);
  env.ART.run("placeTag", doc);
  assert.ok(/^A-2/.test(doc.status()), doc.status());
  const dlgInit = {}; env.dialogs[1].initialize({ load(o) { Object.assign(dlgInit, o); }, enable() {} });
  assert.strictEqual(dlgInit.next, "A-2", "options panel suggests the next number");
});

test("finishing with a half-placed pair resumes at its match", () => {
  const env = makeEnv(); const doc = new env.Doc(5);
  refPairs(env, doc, [[0, 10, 10]]);
  assert.ok(env.alerts.some(a => /A-1 doesn't have its match yet/.test(a)));
  env.ART.run("placeTag", doc);
  assert.ok(/A-1 .*match/.test(doc.status()), doc.status());
  doc.click(50, 50, 3);
  env.ART.run("placeTag", doc);
  assert.deepStrictEqual(names(doc), ["ART:T:A-1:1", "ART:T:A-1:2"]);
});

test("options panel: choose start number, colour and size", () => {
  const env = makeEnv(); const doc = new env.Doc(5);
  refPairs(env, doc, [[0, 100, 100], [1, 100, 100]], { next: "B-10", colr: { Red: -1, Blue: 1, Green: -1, Black: -1 }, size: { Small: -1, Medium: -1, Large: 1 } });
  assert.deepStrictEqual(names(doc), ["ART:T:B-10:1", "ART:T:B-10:2"]);
  const t = doc._annots[0];
  assert.strictEqual(t.textSize, 10, "large");
  assert.strictEqual(JSON.stringify(t.strokeColor), JSON.stringify(["RGB", 0, 0.25, 0.75]), "blue");
  env.ART.run("placeTag", doc);
  assert.ok(/^B-11/.test(doc.status()), "sequence continues from B-10");
});

test("options panel can be switched off; bar Options still opens it", () => {
  const env = makeEnv(); const doc = new env.Doc(3);
  env.dialogResults.push({ show: false });
  env.ART.run("placeTag", doc); env.ART.run("placeTag", doc);
  const n = env.dialogs.length;
  env.ART.run("placeTag", doc);
  assert.strictEqual(env.dialogs.length, n, "starts straight away");
  doc.bar("opts");
  assert.strictEqual(env.dialogs.length, n + 1);
});

test("duplicate start number is refused", () => {
  const env = makeEnv(); const doc = new env.Doc(5);
  refPairs(env, doc, [[0, 10, 10], [1, 10, 10]]);
  env.dialogResults.push({ next: "A-1" }, "cancel");
  env.ART.run("placeTag", doc);
  assert.ok(env.alerts.some(a => /A-1 is already used/.test(a)));
  assert.strictEqual(doc.fieldNames().length, 0, "didn't start");
});

test("bar: Undo removes the last tag and steps back", () => {
  const env = makeEnv(); const doc = new env.Doc(5);
  env.ART.run("placeTag", doc);
  doc.click(10, 10, 0); doc.click(20, 20, 1); doc.click(30, 30, 0);   // A-1 pair + A-2 side 1
  doc.bar("undo");
  assert.ok(/A-2 .*figure/.test(doc.status()), doc.status());
  assert.deepStrictEqual(names(doc), ["ART:T:A-1:1", "ART:T:A-1:2"]);
  doc.bar("undo");
  assert.ok(/A-1 .*match/.test(doc.status()), doc.status());
  assert.deepStrictEqual(names(doc), ["ART:T:A-1:1"]);
  assert.strictEqual(doc._links.filter(l => l.page === 1).length, 0, "link removed too");
  doc.click(40, 40, 2);
  assert.deepStrictEqual(names(doc), ["ART:T:A-1:1", "ART:T:A-1:2"]);
});

test("bar: Done finishes and cleans up", () => {
  const env = makeEnv(); const doc = new env.Doc(4);
  env.ART.run("placeTag", doc);
  assert.strictEqual(env.ART.isActive(), true);
  doc.bar("done");
  assert.strictEqual(env.ART.isActive(), false);
  assert.strictEqual(doc.fieldNames().length, 0);
});

test("bar sits at the top of each page", () => {
  const env = makeEnv(); const doc = new env.Doc(3);
  env.ART.run("placeTag", doc);
  const st = doc.getField("ART_BAR.status");
  assert.strictEqual(st.widgets.length, 3, "one on each page");
  assert.ok(st.widgets[0].box[1] <= 792 && st.widgets[0].box[1] > 770, "near the top");
  ["undo", "opts", "done"].forEach(id => assert.ok(doc.getField("ART_BAR." + id)));
});

test("links still work after pages are reordered", () => {
  const env = makeEnv(); const doc = new env.Doc(20);
  refPairs(env, doc, [[0, 300, 400], [10, 100, 100]]);
  doc._annots.forEach(a => { if (a.page === 10) a.page = 2; });
  doc._links.forEach(l => { if (l.page === 10) l.page = 2; });
  const l1 = doc._links.find(l => l.page === 0);
  assert.strictEqual(followLink(env, doc, l1), 2);
});

test("leftover capture fields from a crash are cleaned up", () => {
  const env = makeEnv(); const doc = new env.Doc(2);
  doc.addField("ART_CAP.p0", "button", 0, [0, 792, 612, 0]).setAction("MouseUp", "ARTool._onCapture(this,0,1,1)");
  doc.addField("ART_BAR.status", "button", 0, [0, 792, 100, 780]);
  doc.click(5, 5, 0);                     // stray click: no session
  assert.strictEqual(doc.fieldNames().length, 0);
  assert.strictEqual(doc._annots.length, 0);
});

test("toolbar buttons have icons; Reference button shows when active", () => {
  const env = makeEnv();
  const ref = env.buttonObjs.find(b => b.cName === "ARTBtn_placeTag");
  assert.strictEqual(ref.cLabel, "Reference");
  assert.ok(/isActive/.test(ref.cMarked));
  env.buttonObjs.forEach(b => {
    assert.ok(b.oIcon, "icon for " + b.cName);
    assert.strictEqual(b.oIcon.width, 20);
    const hex = b.oIcon.read(20 * 20 * 4);
    assert.strictEqual(hex.length, 20 * 20 * 8, "full 20x20 ARGB icon for " + b.cName);
  });
  Object.keys(env.ART._internal.icons).forEach(k => env.ART._internal.icons[k].forEach((row, i) =>
    assert.strictEqual(row.length, 20, k + " row " + i)));
});

test("calc tape posts a monospaced comment where clicked", () => {
  const env = makeEnv(); const doc = new env.Doc(3); doc.pageNum = 1;
  env.dialogResults.push({ titl: "AR rollforward", ents: "1000\n+250\n-100", init: "GR" });
  env.ART.run("calcTape", doc);
  doc.click(50, 700);
  const tape = doc._annots.find(a => a.name.startsWith("ART:P:"));
  assert.ok(tape, "tape exists");
  assert.strictEqual(tape.page, 1);
  assert.strictEqual(tape.textFont, "Courier");
  assert.ok(/1,150\.00  T  Total/.test(tape.contents));
  assert.ok(Math.abs(tape.rect[3] - 700) < 0.01 && Math.abs(tape.rect[0] - 50) < 0.01, "top-left at click");
});

test("calc tape preview and total update as you type", () => {
  const env = makeEnv(); const doc = new env.Doc(1);
  let dlg = null; const shown = {};
  env.ctx.app.execDialog = d => {
    dlg = d;
    const fields = { titl: "Bank rec", ents: "", init: "GR" };
    const h = { load(o) { Object.assign(shown, o); Object.assign(fields, o); }, store() { return Object.assign({}, fields); }, enable() {} };
    d.initialize(h);
    assert.strictEqual(shown.totl, "", "empty to start");
    fields.ents = "12,400 Cash"; d.ents(h);
    assert.strictEqual(shown.totl, "12,400.00");
    assert.ok(/12,400\.00 T  Total/.test(shown.prev), shown.prev);
    fields.ents = "12,400 Cash\n-800 cheque"; d.ents(h);
    assert.strictEqual(shown.totl, "11,600.00");
    fields.ents = "12,400 Cash\n-800 cheque\n+"; d.ents(h);   // half-typed line
    assert.strictEqual(shown.totl, "11,600.00", "total holds while a line is half typed");
    fields.titl = "Bank reconciliation"; d.titl(h);
    assert.ok(/TAPE: Bank reconciliation/.test(shown.prev));
    return "cancel";
  };
  env.ART.run("calcTape", doc);
  assert.ok(dlg && typeof dlg.ents === "function", "live handler on the entries box");
});

test("calc tape: type an amount, press Enter, it appears on the tape straight away", () => {
  const env = makeEnv(); const doc = new env.Doc(1);
  let placed = null;
  env.ctx.app.execDialog = d => {
    const fields = {}; const shown = {};
    const h = { load(o) { Object.assign(shown, o); Object.assign(fields, o); }, store() { return Object.assign({}, fields); }, enable() {}, focus(id) { h.focused = id; } };
    d.initialize(h);
    assert.strictEqual(h.focused, "entr", "cursor starts in the amount box");
    fields.entr = "12,400 Cash per bank";
    assert.strictEqual(d.validate(h), false, "Enter adds the line and keeps the dialog open");
    assert.strictEqual(shown.totl, "12,400.00");
    assert.strictEqual(fields.entr, "", "amount box cleared for the next number");
    fields.entr = "-800 O/S cheque"; d.validate(h);
    fields.entr = "+3,250 DIT"; d.addl(h);          // the Add button does the same
    assert.strictEqual(shown.totl, "14,850.00");
    assert.ok(/14,850\.00  T  Total/.test(shown.prev), shown.prev);
    fields.entr = "hello"; assert.strictEqual(d.validate(h), false);
    assert.ok(/Can't read "hello"/.test(shown.prev), "bad line explained, not added");
    assert.strictEqual(fields.entr, "hello", "bad line left in the box to fix");
    fields.entr = "";
    assert.strictEqual(d.validate(h), true, "Enter on an empty box = Place on page");
    d.commit(h); placed = fields.ents;
    return "ok";
  };
  env.ART.run("calcTape", doc);
  assert.strictEqual(env.alerts.filter(a => /error/i.test(a)).join(" | "), "");
  assert.strictEqual(placed, "12,400 Cash per bank\n-800 O/S cheque\n+3,250 DIT");
  doc.click(50, 700);
  assert.ok(/14,850\.00  T  Total/.test(doc._annots[0].contents));
});

test("calc tape with bad entry reopens dialog, then works", () => {
  const env = makeEnv(); const doc = new env.Doc(1);
  env.dialogResults.push({ titl: "", ents: "abc", init: "" }, { titl: "", ents: "5\n5", init: "" });
  env.ART.run("calcTape", doc);
  assert.ok(env.alerts.some(a => /fix these entries/.test(a)));
  assert.strictEqual(env.dialogs.length, 2);
  doc.click(10, 10);
  assert.ok(/10\.00  T/.test(doc._annots[0].contents));
});

test("tapes from combined files are adopted into the register", () => {
  const env = makeEnv(); const doc = new env.Doc(3);
  doc.addAnnot({ type: "FreeText", page: 2, rect: [0, 0, 100, 50], name: "ART:P:fromotherfile", contents: "TAPE: x\n 5.00 +" });
  env.ART.run("tagCheck", doc);
  const reg = JSON.parse(doc.info.ARTRegister);
  assert.ok(reg.items["ART:P:fromotherfile"]);
  let shown = null;
  env.ctx.app.execDialog = d => { d.initialize({ load(o) { shown = o.rept; } }); return "ok"; };
  env.ART.run("tagCheck", doc);
  assert.ok(/Tapes: 1/.test(shown), shown);
});

test("tag check flags unmatched and broken tags", () => {
  const env = makeEnv(); const doc = new env.Doc(10);
  refPairs(env, doc, [[0, 10, 10], [4, 10, 10], [4, 50, 50]]); // A-2 unmatched
  // A-1 side 2 deleted outside the tool
  (t => { t.readOnly = false; t.destroy(); })(doc._annots.find(a => a.name === "ART:T:A-1:2"));
  let loaded = null;
  env.ctx.app.execDialog = d => { const dl = { load(o) { loaded = o; } }; d.initialize(dl); return "ok"; };
  const rep = env.ART.run("tagCheck", doc);
  assert.strictEqual(rep.broken, 1);
  assert.strictEqual(rep.unmatched, 1);
  assert.ok(/A-1\s+\(side 2 missing/.test(loaded.rept));
  assert.ok(/A-2\s+on p\.5 has no matching tag/.test(loaded.rept));
});

test("repair restores tags and tapes lost to Acrobat's own Replace Pages", () => {
  const env = makeEnv(); const doc = new env.Doc(10);
  refPairs(env, doc, [[0, 200, 300], [6, 220, 330]]);
  doc.pageNum = 6;
  env.dialogResults.push({ titl: "t", ents: "1\n2", init: "" }); env.ART.run("calcTape", doc); doc.click(50, 500);
  const before = doc._annots.map(a => ({ n: a.name, r: a.rect.slice(), p: a.page, c: a.contents }));
  // Native replace of page 6 wipes everything on it
  doc.replacePages({ nPage: 6 });
  assert.deepStrictEqual(names(doc), ["ART:T:A-1:1"]);
  env.alertAnswers.push(4, 4); // Yes restore, then OK
  const res = env.ART.run("repairTags", doc);
  assert.strictEqual(res.restored, 2);
  const after = doc._annots.map(a => ({ n: a.name, r: a.rect.slice(), p: a.page, c: a.contents }));
  const sort = x => x.slice().sort((a, b) => a.n < b.n ? -1 : 1);
  assert.deepStrictEqual(sort(after), sort(before));
  assert.strictEqual(doc._links.length, 2, "one link per tag, no duplicates");
  const l = doc._links.find(l => l.page === 0);
  assert.strictEqual(followLink(env, doc, l), 6);
});

test("repair 'No' forgets deleted items instead of restoring", () => {
  const env = makeEnv(); const doc = new env.Doc(3);
  env.dialogResults.push({ titl: "t", ents: "1", init: "" }); env.ART.run("calcTape", doc); doc.click(50, 500);
  doc._annots[0].destroy();
  env.alertAnswers.push(3, 4);
  env.ART.run("repairTags", doc);
  assert.strictEqual(doc._annots.length, 0);
  assert.deepStrictEqual(JSON.parse(doc.info.ARTRegister).items, {});
});

test("repair is idempotent (no duplicate links)", () => {
  const env = makeEnv(); const doc = new env.Doc(3);
  refPairs(env, doc, [[0, 20, 20], [1, 20, 20]]);
  env.ART.run("repairTags", doc); env.ART.run("repairTags", doc);
  assert.strictEqual(doc._links.length, 2);
  assert.strictEqual(doc._annots.length, 2);
});

test("Replace Page (Keep Tags) keeps tags, tapes and optionally other comments", () => {
  const env = makeEnv(); const doc = new env.Doc(10);
  refPairs(env, doc, [[0, 100, 100], [3, 120, 140]], { next: "C-1" });
  doc.pageNum = 3;
  env.dialogResults.push({ titl: "t", ents: "1\n2", init: "" }); env.ART.run("calcTape", doc); doc.click(300, 600);
  doc.addAnnot({ type: "Text", page: 3, rect: [10, 10, 30, 30], name: "reviewnote", contents: "Please update" });
  const before = names(doc);
  env.alertAnswers.push(4 /*replace?*/, 4 /*carry others*/, 4 /*done*/);
  env.responses.push("2");
  const res = env.ART.run("replacePage", doc);
  assert.strictEqual(doc._replaced.nPage, 3);
  assert.strictEqual(doc._replaced.nStart, 1);
  assert.strictEqual(doc._replaced.cPath, "/new-statement.pdf");
  assert.strictEqual(res.restored, 2);
  assert.strictEqual(res.carried, 1);
  assert.deepStrictEqual(names(doc), before);
  assert.strictEqual(doc._links.length, 2);
  const l = doc._links.find(l => l.page === 0);
  assert.strictEqual(followLink(env, doc, l), 3);
  const t2 = doc._annots.find(a => a.name === "ART:T:C-1:2");
  assert.ok(t2.rect[0] < 120 && t2.rect[2] > 120, "same position");
});

test("Move Tag moves the tag and its link", () => {
  const env = makeEnv(); const doc = new env.Doc(4);
  refPairs(env, doc, [[0, 100, 100], [2, 100, 100]]);
  doc.pageNum = 2;
  env.responses.push("A-1");
  env.ART.run("moveTag", doc);
  doc.click(400, 500);
  const t = doc._annots.find(a => a.name === "ART:T:A-1:2");
  assert.ok(t.rect[0] < 400 && t.rect[2] > 400 && t.rect[1] < 500 && t.rect[3] > 500);
  const links2 = doc._links.filter(l => l.page === 2);
  assert.strictEqual(links2.length, 1, "old link removed");
  assert.ok(links2[0].rect[0] < 400 && links2[0].rect[2] > 400);
});

test("Delete Tag removes both sides and links", () => {
  const env = makeEnv(); const doc = new env.Doc(4);
  refPairs(env, doc, [[0, 100, 100], [2, 100, 100]]);
  env.responses.push("A-1"); env.alertAnswers.push(4);
  env.ART.run("deleteTag", doc);
  assert.strictEqual(doc._annots.length, 0);
  assert.strictEqual(doc._links.length, 0);
  env.ART.run("repairTags", doc);
  assert.strictEqual(doc._annots.length, 0, "repair doesn't resurrect deleted tags");
});


test("protected (certified/secured) PDF gets a plain-English explanation", () => {
  const env = makeEnv(); const doc = new env.Doc(2);
  doc.addField = () => { const e = new Error("Security settings prevent access to this property or method."); e.name = "NotAllowedError"; throw e; };
  env.ART.run("placeTag", doc);
  const msg = env.alerts[env.alerts.length - 1];
  assert.ok(/This PDF is protected/.test(msg) && /Combine Files/.test(msg), msg);
  assert.ok(!/line \d+/.test(msg), "no raw error");
});

test("rotated pages: link rectangle converted to rotated space", () => {
  const env = makeEnv(); const doc = new env.Doc(2); doc._rot[0] = 90;
  const r = env.ART._internal.toRotatedRect(doc, 0, [100, 200, 140, 214]);
  // page 612x792 rotated 90: x' = y, y' = 612 - x
  assert.strictEqual(JSON.stringify(r), "[200,472,214,512]");
});

test("errors are caught and shown, not thrown", () => {
  const env = makeEnv(); const doc = new env.Doc(1);
  doc.getAnnots = () => { throw new Error("boom"); };
  doc.syncAnnotScan = () => { throw new Error("boom"); };
  doc.addField = () => { throw new Error("cannot add field"); };
  env.ART.run("placeTag", doc);
  assert.ok(env.alerts.some(a => /Reference Tool error/.test(a)));
});


const release = (tag, notes) => ({ body: JSON.stringify({ tag_name: tag, html_url: "https://github.com/PhilipBanks0/Adobe-reference-tool/releases/tag/" + tag, body: notes || "" }) });

test("version comparison", () => {
  const { compareVersions } = makeEnv().ART._internal;
  assert.strictEqual(compareVersions("0.2.0", "0.1.9"), 1);
  assert.strictEqual(compareVersions("v0.10.0", "0.9.9"), 1);
  assert.strictEqual(compareVersions("1.0.0", "v1.0.0"), 0);
  assert.strictEqual(compareVersions("1.0", "1.0.1"), -1);
  assert.strictEqual(compareVersions("1.2.0-beta", "1.2.0"), 0);
});

test("check for updates: newer release offers the download page", () => {
  const env = makeEnv();
  env.httpResponse = release("v9.0.0", "New: tick marks");
  env.alertAnswers.push(4);
  env.ART.run("checkForUpdates", null);
  assert.ok(/api\.github\.com\/repos\/PhilipBanks0\/Adobe-reference-tool\/releases\/latest/.test(env.httpRequests[0]));
  assert.ok(/Version 9\.0\.0 is available/.test(env.alerts[0]) && /tick marks/.test(env.alerts[0]));
  assert.ok(/releases\/tag\/v9\.0\.0/.test(env.launched[0]));
});

test("Windows: 'Install now' starts the installed updater, no web page", () => {
  const env = makeEnv();
  env.ctx.app.platform = "WIN";
  env.httpResponse = release("v9.0.0", "New stuff");
  env.alertAnswers.push(4); // Yes, install now
  env.ART.run("checkForUpdates", null);
  assert.ok(/Install it now\?/.test(env.alerts[0]), env.alerts[0]);
  assert.deepStrictEqual(env.launched, ["reftool-update:install"]);
});

test("release notes are shown without Markdown symbols", () => {
  const { parseRelease } = makeEnv().ART._internal;
  const r = parseRelease(JSON.stringify({ tag_name: "v1.0.0", body: "- **One-click** updates via `reftool-update:`" }));
  assert.strictEqual(r.notes, "- One-click updates via reftool-update:");
});

test("Windows: if the updater can't be started, fall back to Start menu + download page", () => {
  const env = makeEnv();
  env.ctx.app.platform = "WIN";
  env.httpResponse = release("v9.0.0");
  let first = true;
  env.ctx.app.launchURL = u => { if (first) { first = false; throw new Error("blocked"); } env.launched.push(u); };
  env.alertAnswers.push(4, 4);
  env.ART.run("checkForUpdates", null);
  assert.ok(env.alerts.some(a => /Start menu/.test(a)));
  assert.ok(/releases\/tag\/v9\.0\.0/.test(env.launched[0]));
});

test("check for updates: up to date", () => {
  const env = makeEnv();
  env.httpResponse = release("v" + env.ART.version);
  env.ART.run("checkForUpdates", null);
  assert.ok(/latest version/.test(env.alerts[0]));
  assert.strictEqual(env.launched.length, 0);
});

test("check for updates: offline falls back to the releases page", () => {
  const env = makeEnv();
  env.httpResponse = { err: "network error" };
  env.alertAnswers.push(4);
  env.ART.run("checkForUpdates", null);
  assert.ok(/couldn't reach GitHub/.test(env.alerts[0]));
  assert.ok(/releases\/latest$/.test(env.launched[0]));
});

test("automatic startup check is silent unless there is an update", () => {
  let env = makeEnv();
  env.httpResponse = release("v" + env.ART.version);
  env.runTimers();
  assert.strictEqual(env.httpRequests.length, 1, "checks on startup");
  assert.strictEqual(env.alerts.length, 0, "no popup when up to date");
  env = makeEnv();
  env.httpResponse = { err: "offline" };
  env.runTimers();
  assert.strictEqual(env.alerts.length, 0, "no popup when offline");
  env = makeEnv();
  env.httpResponse = release("v99.0.0");
  env.alertAnswers.push(3);
  env.runTimers();
  assert.strictEqual(env.alerts.length, 1, "tells you about a new version");
});

test("automatic check respects the interval and the off switch", () => {
  let env = makeEnv();
  env.ctx.global.ART_lastUpdateCheck = Date.now() - 86400000; // yesterday
  env.runTimers();
  assert.strictEqual(env.httpRequests.length, 0);
  env = makeEnv();
  env.ART.config.autoUpdateCheck = false;
  env.runTimers();
  assert.strictEqual(env.httpRequests.length, 0);
});

console.log("\n" + passed + " passed" + (process.exitCode ? ", some FAILED" : ""));

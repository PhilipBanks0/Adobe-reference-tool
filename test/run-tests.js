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
let docCount = 0;
function makeEnv(menuParents) {
  const env = { dialogScripts: [], menuParents: menuParents || null, httpRequests: [], launched: [], alerts: [], alertAnswers: [], responses: [], dialogs: [], dialogResults: [], timers: [], intervals: [], widgetUpdates: 0 };

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
      const doc = this;
      // Like Acrobat: changing the PDF marks it as needing a save.
      this.numPages = pages; this.pageNum = 0; this._annots = []; this._links = []; this._fields = {}; this.dirty = false;
      this.info = new Proxy({}, { set(o, k, v) { o[k] = v; doc.dirty = true; return true; } });
      this._rot = {}; this.selectedAnnots = []; this.path = "/work-paper-" + (++docCount) + ".pdf";
    }
    syncAnnotScan() {}
    getAnnots(o) { const r = this._annots.filter(a => !o || a.page === o.nPage); return r.length ? r : null; }
    addAnnot(p) {
      if (p.page >= this.numPages) throw new Error("bad page");
      const a = new Annot(this, p);
      this._annots.push(a); this.dirty = true;
      return a;
    }
    addLink(p, r) { const l = new Link(p, r); this._links.push(l); return l; }
    removeLinks(p, r) {
      this._links = this._links.filter(l => !(l.page === p && l.rect[0] >= r[0] && l.rect[1] >= r[1] && l.rect[2] <= r[2] && l.rect[3] <= r[3]));
    }
    addField(name, type, p, box) {
      let f = this._fields[name];
      this.dirty = true;
      if (!f) {
        const raw = {
          name, widgets: [], caption: "", value: "", actions: {}, type,
          setAction(ev, s) { this.actions[ev] = s; if (ev === "MouseUp") this.script = s; },
          buttonSetCaption(c) { this.caption = c; env.widgetUpdates += raw.widgets.length; },
          setFocus() { env.focused = name; }
        };
        // Like Acrobat: setting a property on a field redraws every widget it has.
        f = new Proxy(raw, { set(o, k, v) { o[k] = v; if (k !== "page") env.widgetUpdates += o.widgets.length; return true; } });
        this._fields[name] = f;
      }
      f.widgets.push({ page: p, box });
      f.page = f.widgets.length === 1 ? p : f.widgets.map(w => w.page);
      f.rect = box.slice();
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
      for (const k of Object.keys(this._fields)) if (this._fields[k].page === o.nPage) delete this._fields[k];
      this._replaced = o;
    }
    scroll() {}
    // helper: the user goes to a page and waits a moment (the add-on's timer ticks)
    goTo(page) { this.pageNum = page; runIntervals(3); }
    // helper: simulate a user click on the page (the capture field over it)
    click(x, y, page) {
      if (page === undefined) page = this.pageNum;
      if (page !== this.pageNum) this.goTo(page);
      const f = this._fields["ART_CAP.p" + page];
      assert(f, "capture field should exist on page " + page);
      const fn = new (vm.runInContext("Function", ctx))("event", f.script.replace(/this\.mouseX/g, x).replace(/this\.mouseY/g, y));
      fn.call(this, { target: f });
      runTimers();
    }
    // helper: click a button on the reference options bar
    bar(id) {
      const f = this._fields["ART_BAR." + id + ".p" + this.pageNum];
      assert(f, "bar button " + id + " should exist");
      new (vm.runInContext("Function", ctx))("event", f.script).call(this, { target: f });
      runTimers();
    }
    status() { const f = this._fields["ART_BAR.status.p" + this.pageNum]; return f ? f.caption : null; }
    // helper: run a field's action like Acrobat does (this = the document)
    fire(f, trigger, ev) {
      new (vm.runInContext("Function", ctx))("event", f.actions[trigger]).call(this, Object.assign({ target: f, rc: true }, ev));
    }
    // helper: type into a text field one key at a time (Keystroke events, like Acrobat)
    type(name, text) {
      for (const ch of text) {
        const f = this._fields[name];
        assert(f, "field " + name + " should exist");
        const v = String(f.value);
        const ev = { target: f, change: ch, value: v, selStart: v.length, selEnd: v.length, willCommit: false, rc: true };
        if (f.actions.Keystroke) new (vm.runInContext("Function", ctx))("event", f.actions.Keystroke).call(this, ev);
        if (ev.rc !== false) this._fields[name].value = v.slice(0, ev.selStart) + ev.change + v.slice(ev.selEnd);
      }
    }
    // helper: leave a text field (key 2 = Enter, 1 = clicked elsewhere, 3 = Tab)
    commit(name, key) {
      const f = this._fields[name];
      assert(f, "field " + name + " should exist");
      if (f.actions.Keystroke) this.fire(f, "Keystroke", { value: String(f.value), willCommit: true, commitKey: key || 2 });
      runTimers();
    }
    // helper: click a button field (at x, y on the page)
    press(name, x, y) {
      const f = this._fields[name];
      assert(f, "button " + name + " should exist");
      const script = f.script.replace(/this\.mouseX/g, x || 0).replace(/this\.mouseY/g, y || 0);
      new (vm.runInContext("Function", ctx))("event", script).call(this, { target: f });
      runTimers();
    }
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
      if (env.dialogScripts.length) return runDialogScript(d, env.dialogScripts.shift());
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
    setInterval(expr) { const t = { expr }; env.intervals.push(t); return t; },
    clearInterval(t) { env.intervals = env.intervals.filter(x => x !== t); },
    addSubMenu(o) {
      if (env.menuParents && env.menuParents.indexOf(o.cParent) < 0) throw new TypeError("Invalid argument type.");
      (env.submenus = env.submenus || []).push(o.cParent);
    },
    addMenuItem(o) { (env.menuItems = env.menuItems || []).push(o.cUser); }, addToolButton(o) { (env.buttons = env.buttons || []).push(o.cLabel); (env.buttonObjs = env.buttonObjs || []).push(o); }
  };
  // A scripted user in a dialog: type into boxes, press Enter, click buttons, OK or Cancel.
  function runDialogScript(d, script) {
    const fields = {};
    const h = { load(o) { Object.assign(fields, o); }, store() { return Object.assign({}, fields); }, enable() {}, focus(id) { h.focused = id; } };
    if (d.initialize) d.initialize(h);
    const ui = {
      d, h, fields,
      get(id) { return fields[id]; },
      type(id, v) { fields[id] = v; },                  // replace a box's text
      leave(id) { if (d[id]) d[id](h); },                // click out of a box after changing it
      enter(text) { if (text !== undefined) fields.entr = text; return d.validate(h) === false ? null : "ok"; },
      click(id) { d[id](h); },
      ok() { if (d.validate && d.validate(h) === false) return null; if (d.commit) d.commit(h); return "ok"; }
    };
    const r = script(ui);
    return r || "cancel";
  }
  function runTimers() { while (env.timers.length) vm.runInContext(env.timers.shift(), ctx); }
  function runIntervals(ticks) { for (let i = 0; i < (ticks || 1); i++) env.intervals.slice().forEach(t => vm.runInContext(t.expr, ctx)); }

  ctx = vm.createContext({
    app, JSON, Math, Date, String, Number, Array, Object, RegExp, Error, parseInt, parseFloat,
    color: { blue: ["RGB", 0, 0, 1], transparent: ["T"] }, font: { Cour: "Courier", Helv: "Helvetica" },
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
  env.runIntervals = runIntervals;
  env.followTimers = () => env.intervals.filter(t => /_followPage/.test(t.expr)).length;
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
// Make a tape with the calculator: type the lines, Place on page, click the page.
function makeTape(env, doc, t, x, y) {
  env.dialogScripts.push(ui => {
    if (t.titl) { ui.type("titl", t.titl); ui.leave("titl"); }
    if (t.init !== undefined) { ui.type("init", t.init); ui.leave("init"); }
    for (const line of String(t.ents).split("\n")) ui.enter(line);
    return ui.ok();
  });
  env.ART.run("calcTape", doc);
  doc.click(x, y);
  return doc._annots.filter(a => a.name.startsWith("ART:P:")).pop();
}
const okName = ui => ui.d.description.elements[ui.d.description.elements.length - 1].ok_name;
const tapeBtn = (doc, tape) => doc._fields["ART_TBTN." + tape.name.slice(6)];
const doubleClick = (doc, tape, x, y) => { const n = "ART_TBTN." + tape.name.slice(6); doc.press(n, x, y); doc.press(n, x, y); };
const followLink = (env, doc, link) => { new (vm.runInContext("Function", env.ctx))(link.action).call(doc); return doc.pageNum; };

console.log("Reference Tool tests");

test("toolbar buttons install", () => {
  const env = makeEnv();
  assert.deepStrictEqual(env.buttons, ["Reference", "Calc Tape", "Tag Check", "Replace Page", "Repair Tags"]);
});

test("menu goes under Edit (new Acrobat: Menu > Plugins > For editing), not the hamburger menu", () => {
  let env = makeEnv();
  assert.strictEqual(env.ART.menuParent, "Edit");
  assert.ok(env.menuItems.indexOf("Reference Tool") >= 0 && env.menuItems.indexOf("Check for Updates") >= 0);
  // The hamburger menu is only a last resort: it accepts submenus but doesn't show them.
  env = makeEnvWith(["AV2::HamburgerMenu"]);
  assert.strictEqual(env.ART.menuParent, "AV2::HamburgerMenu");
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
  assert.ok(doc.getField("ART_CAP.p0") && !doc.getField("ART_CAP.p19"), "only the page being viewed is set up at the start");
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
  assert.strictEqual(env.followTimers(), 0, "page-following timer stopped");
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

test("bar sits at the top of each page, with its own buttons on every page", () => {
  const env = makeEnv(); const doc = new env.Doc(3);
  env.ART.run("placeTag", doc);
  env.runIntervals(3);
  assert.ok(doc.getField("ART_BAR.status.p1") && !doc.getField("ART_BAR.status.p2"), "neighbouring page set up, far page not yet");
  doc.goTo(2);
  [0, 1, 2].forEach(p => {
    const st = doc.getField("ART_BAR.status.p" + p);
    assert.ok(st, "bar on page " + p);
    assert.strictEqual(st.widgets.length, 1, "not shared with other pages");
    assert.ok(st.widgets[0].box[1] <= 792 && st.widgets[0].box[1] > 770, "near the top");
    ["undo", "opts", "done"].forEach(id => assert.ok(doc.getField("ART_BAR." + id + ".p" + p)));
  });
});

test("large work paper: starting and clicking don't slow down with page count", () => {
  const env = makeEnv(); const doc = new env.Doc(2000);
  doc.pageNum = 1000;
  env.ART.run("placeTag", doc);
  const atStart = env.widgetUpdates;
  assert.ok(atStart < 150, "start touches one page, not 2,000 (" + atStart + " redraws)");
  assert.ok(doc.fieldNames().length <= 6, "fields on one page only: " + doc.fieldNames().length);
  // Work through 60 pages, a pair per page; every click should cost about the same.
  const costs = [];
  for (let p = 1000; p < 1060; p++) {
    const before = env.widgetUpdates;
    doc.click(100, 100, p);
    doc.click(200, 200, p + 1);
    costs.push(env.widgetUpdates - before);
  }
  assert.ok(Math.max(...costs) < 3 * Math.min(...costs) + 60, "click cost stays flat: " + costs.slice(0, 3) + " ... " + costs.slice(-3));
  assert.ok(Object.values(doc._fields).every(f => f.widgets.length === 1), "no field shared across pages");
  env.ART.run("placeTag", doc);
  assert.strictEqual(doc.fieldNames().length, 0);
  assert.strictEqual(names(doc).length, 120);
});

test("status on a page visited earlier catches up when you go back", () => {
  const env = makeEnv(); const doc = new env.Doc(50);
  env.ART.run("placeTag", doc);
  doc.click(10, 10, 0);                   // A-1 figure on page 1
  doc.click(20, 20, 30);                  // its match on page 31
  doc.goTo(0);
  assert.ok(/^A-2/.test(doc.status()), "page 1's bar shows the new status: " + doc.status());
});

test("closing the document stops reference mode's timer", () => {
  const env = makeEnv(); const doc = new env.Doc(5);
  env.ART.run("placeTag", doc);
  assert.strictEqual(env.followTimers(), 1);
  Object.defineProperty(doc, "pageNum", { get() { throw new Error("closed"); } });
  env.runIntervals(1);
  assert.strictEqual(env.followTimers(), 0);
  assert.strictEqual(env.ART.isActive(), false);
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

test("tape maths: 250 x 12 adds 3,000, like an adding machine", () => {
  const { computeTape, formatTape } = makeEnv().ART._internal;
  const c = computeTape("1,000 Opening\n250 x 12 Rent\n-2 x 50 Refunds\nx 1.1 Gross-up\n1,200 / 12");
  assert.strictEqual(c.errors.length, 0, c.errors.join());
  assert.strictEqual(c.total, Math.round(((1000 + 3000 - 100) * 1.1 + 100) * 1e6) / 1e6);
  const t = formatTape("Rent", c, "GR");
  assert.ok(/ 3,000\.00  \+  250 x 12  Rent/.test(t), t);
  assert.ok(/ 100\.00  -  2 x 50  Refunds/.test(t), t);
  assert.ok(/ 100\.00  \+  1,200 \/ 12/.test(t), t);
  assert.strictEqual(computeTape("10 x 0\n5 / 0").errors.length, 1, "divide by zero caught");
  assert.strictEqual(computeTape("800 O/S cheque").rows[0].desc, "O/S cheque", "O/S is a description, not a divide");
});

test("calculator keys: + - act on the number typed, * / on the next number", () => {
  const { calcKeyAction: k } = makeEnv().ART._internal;
  const eq = (a, b) => assert.deepStrictEqual(a === null ? null : { line: a.line, next: a.next }, b);
  eq(k("1,250", "+"), { line: "1,250", next: "" });
  eq(k("800", "-"), { line: "-800", next: "" });
  eq(k("(800)", "+"), { line: "(800)", next: "" });
  eq(k("250", "*"), { line: null, next: "250 x " });
  eq(k("250 x 12", "+"), { line: "250 x 12", next: "" });
  eq(k("250 x 12", "-"), { line: "-250 x 12", next: "" });
  eq(k("250 x 12", "/"), { line: null, next: "250 x 12 / " });
  eq(k("250 x ", "/"), { line: null, next: "250 / " });
  eq(k("x 1.05", "+"), { line: "x 1.05", next: "" });
  eq(k("*1.05", "*"), { line: "x 1.05", next: "x " });
  eq(k("x", "/"), { line: null, next: "/ " });
  eq(k("", "-"), null);                  // a minus sign to start a negative number
  eq(k("", "*"), null);                  // "*" then a number: multiply the total
  eq(k("250 x ", "-"), null);            // a sign for the next number
  eq(k("800 O", "/"), null);             // typing "O/S cheque"
  eq(k("800 Year", "-"), null);          // typing "Year-end"
  eq(k("800 2023", "/"), null);
});

test("Calc Tape opens a pop-up window with the cursor in the Amount box", () => {
  const env = makeEnv(); const doc = new env.Doc(2);
  let seen;
  env.dialogScripts.push(ui => { seen = { focused: ui.h.focused, ok: okName(ui), stat: ui.get("stat") }; return "cancel"; });
  env.ART.run("calcTape", doc);
  assert.strictEqual(env.dialogs.length, 1);
  assert.strictEqual(seen.focused, "entr");
  assert.strictEqual(seen.ok, "Place on page");
  assert.ok(/Enter/.test(seen.stat), seen.stat);
  assert.strictEqual(doc.fieldNames().length, 0, "nothing added to the page");
});

test("calculator: + - * / are read when you press Enter, several at a time if you like", () => {
  const env = makeEnv(); const doc = new env.Doc(1);
  const seen = [];
  const snap = ui => seen.push({ totl: ui.get("totl"), entr: ui.get("entr"), stat: ui.get("stat"), ents: ui.get("ents"), prev: ui.get("prev") });
  env.dialogScripts.push(ui => {
    ui.enter("12,400+"); snap(ui);          // 0
    ui.enter("800-"); snap(ui);             // 1
    ui.enter("250*"); snap(ui);             // 2: waits for the next number
    ui.enter("250 x 12"); snap(ui);         // 3
    ui.enter("*1.1"); snap(ui);             // 4: multiplies the total
    ui.enter("800 O/S cheque"); snap(ui);   // 5: the / is part of the description
    ui.enter("/2+-100+"); snap(ui);         // 6: two at once
    ui.enter("100+200-50"); snap(ui);       // 7: Enter adds the last one
    return "cancel";
  });
  env.ART.run("calcTape", doc);
  assert.deepStrictEqual([seen[0].totl, seen[0].entr], ["12,400.00", ""]);
  assert.strictEqual(seen[1].totl, "11,600.00");
  assert.deepStrictEqual([seen[2].totl, seen[2].entr], ["11,600.00", "250 x "]);
  assert.ok(/250 x .*next number/.test(seen[2].stat), seen[2].stat);
  assert.strictEqual(seen[3].totl, "14,600.00", "250 x 12 = 3,000 added");
  assert.strictEqual(seen[4].totl, "16,060.00");
  assert.strictEqual(seen[5].totl, "16,860.00");
  assert.strictEqual(seen[6].totl, "8,330.00");
  assert.strictEqual(seen[7].totl, "8,280.00");
  assert.strictEqual(seen[7].ents, "12,400\n-800\n250 x 12\n*1.1\n800 O/S cheque\n/ 2\n-100\n100\n-200\n50");
  assert.ok(/3,000\.00  \+  250 x 12/.test(seen[7].prev), seen[7].prev);
  assert.ok(/8,280\.00  T  Total/.test(seen[7].prev));
  assert.ok(seen.every(x => x.entr === "" || x.entr === "250 x "), "box cleared after each Enter");
});

test("calculator: what it can't read stays in the Amount box with an explanation", () => {
  const env = makeEnv(); const doc = new env.Doc(1);
  const seen = [];
  const snap = ui => seen.push({ totl: ui.get("totl"), entr: ui.get("entr"), stat: ui.get("stat"), ents: ui.get("ents") });
  env.dialogScripts.push(ui => {
    ui.enter("*5"); snap(ui);
    ui.enter("hello"); snap(ui);
    ui.enter("5+250 x"); snap(ui);
    ui.enter("100+abc+7"); snap(ui);
    return "cancel";
  });
  env.ART.run("calcTape", doc);
  assert.ok(/Start with an amount/.test(seen[0].stat), seen[0].stat);
  assert.strictEqual(seen[0].entr, "*5");
  assert.ok(/Can't read "hello"/.test(seen[1].stat), seen[1].stat);
  assert.deepStrictEqual([seen[1].entr, seen[1].ents], ["hello", ""]);
  assert.deepStrictEqual([seen[2].totl, seen[2].entr], ["5.00", "250 x "]);
  assert.ok(/next number/.test(seen[2].stat));
  assert.deepStrictEqual([seen[3].totl, seen[3].entr], ["105.00", "abc+7"], "the good part is added, the rest left to fix");
});

test("calculator: Enter on an empty Amount box places the tape; a number left in the box is added first", () => {
  const env = makeEnv(); const doc = new env.Doc(1);
  let stayed;
  env.dialogScripts.push(ui => {
    ui.enter("5+6");
    ui.type("entr", "7");
    stayed = ui.ok();                       // Place with 7 still in the box: added, window stays open
    return ui.enter("") && ui.ok();         // Enter on the empty box: done
  });
  env.ART.run("calcTape", doc);
  assert.strictEqual(stayed, null);
  doc.click(10, 500);
  assert.ok(/18\.00  T/.test(doc._annots[0].contents), doc._annots[0].contents);
});

test("calculator: Place on page, then click - the tape keeps its lines for changing later", () => {
  const env = makeEnv(); const doc = new env.Doc(3); doc.pageNum = 1;
  const tape = makeTape(env, doc, { titl: "AR rollforward", ents: "1000\n+250\n-100", init: "GR" }, 50, 700);
  assert.ok(tape, "tape exists");
  assert.strictEqual(tape.page, 1);
  assert.strictEqual(tape.textFont, "Courier");
  assert.ok(/^TAPE: AR rollforward/.test(tape.contents));
  assert.ok(/1,150\.00  T  Total/.test(tape.contents));
  assert.ok(/Prepared by GR/.test(tape.contents));
  assert.ok(Math.abs(tape.rect[3] - 700) < 0.01 && Math.abs(tape.rect[0] - 50) < 0.01, "top-left at click");
  const item = JSON.parse(doc.info.ARTRegister).items[tape.name];
  assert.deepStrictEqual(item.src, { titl: "AR rollforward", ents: "1000\n+250\n-100", init: "GR" });
  // The double-click button covers the figures, not the title line or the edges.
  const b = tapeBtn(doc, tape);
  assert.ok(b, "double-click button on the tape");
  assert.strictEqual(b.display, 3, "button doesn't print");
  const r = b.rect; const t = tape.rect;
  assert.ok(r[0] > t[0] && r[2] < t[2] && r[3] > t[1], "inside the tape's edges: " + r + " / " + t);
  assert.ok(r[1] <= t[3] - 5 - 8 * 1.2 + 0.01, "title line left clear to drag by");
});

test("calculator: Undo line, and editing the lines directly", () => {
  const env = makeEnv(); const doc = new env.Doc(1);
  const seen = [];
  env.dialogScripts.push(ui => {
    ui.enter("5+6+");
    ui.click("undo"); seen.push([ui.get("totl"), ui.get("ents"), ui.h.focused]);
    ui.type("ents", "5\n20 fees"); ui.leave("ents"); seen.push([ui.get("totl")]);
    return "cancel";
  });
  env.ART.run("calcTape", doc);
  assert.deepStrictEqual(seen[0], ["5.00", "5", "entr"]);
  assert.deepStrictEqual(seen[1], ["25.00"], "edited lines count when you leave the box");
  assert.strictEqual(doc._annots.length, 0, "Cancel: nothing placed");
  assert.strictEqual(doc.fieldNames().length, 0);
});

test("calculator: lines it can't read are caught at Place, and the window reopens", () => {
  const env = makeEnv(); const doc = new env.Doc(1);
  let reopened;
  env.dialogScripts.push(ui => { ui.type("ents", "abc"); return ui.ok(); });
  env.dialogScripts.push(ui => { reopened = ui.get("ents"); ui.type("ents", "5\n5"); return ui.ok(); });
  env.ART.run("calcTape", doc);
  assert.ok(env.alerts.some(a => /fix these lines/.test(a)));
  assert.strictEqual(reopened, "abc", "your lines are still there to fix");
  doc.click(10, 10);
  assert.ok(/10\.00  T/.test(doc._annots[0].contents));
});

test("double-click a tape: the calculator opens filled in, and Update changes the tape in place", () => {
  const env = makeEnv(); const doc = new env.Doc(2);
  const tape = makeTape(env, doc, { titl: "Rent", ents: "250 x 12\n-500 credit", init: "GR" }, 60, 600);
  const name = tape.name; const top = tape.rect[3]; const left = tape.rect[0];
  const n = env.dialogs.length;
  doc.press("ART_TBTN." + name.slice(6), 80, 560);
  assert.strictEqual(env.dialogs.length, n, "a single click doesn't open it");
  let seen;
  env.dialogScripts.push(ui => {
    seen = { titl: ui.get("titl"), ents: ui.get("ents"), init: ui.get("init"), ok: okName(ui), totl: ui.get("totl"), name: ui.d.description.name };
    ui.enter("100+");
    return ui.ok();
  });
  doubleClick(doc, tape, 80, 560);
  assert.deepStrictEqual(seen, { titl: "Rent", ents: "250 x 12\n-500 credit", init: "GR", ok: "Update tape", totl: "2,500.00", name: "Calculator Tape - change tape" });
  const after = doc._annots.filter(a => a.name.startsWith("ART:P:"));
  assert.strictEqual(after.length, 1, "same tape, not a new one");
  assert.strictEqual(after[0].name, name);
  assert.ok(/2,600\.00  T  Total/.test(after[0].contents), after[0].contents);
  assert.strictEqual(after[0].rect[3], top); assert.strictEqual(after[0].rect[0], left);
  assert.ok(!doc.getField("ART_CAP.p0"), "no click needed to place it again");
  assert.strictEqual(JSON.parse(doc.info.ARTRegister).items[name].src.ents, "250 x 12\n-500 credit\n100");
  const b = tapeBtn(doc, after[0]);
  assert.ok(b.rect[1] > after[0].rect[1] && b.rect[1] < after[0].rect[3], "button follows the taller tape");
});

test("select a tape and click Calc Tape: opens it for changing", () => {
  const env = makeEnv(); const doc = new env.Doc(1);
  const tape = makeTape(env, doc, { ents: "5\n6" }, 60, 600);
  doc.selectedAnnots = [tape];
  let seen;
  env.dialogScripts.push(ui => { seen = [okName(ui), ui.get("ents")]; return "cancel"; });
  env.ART.run("calcTape", doc);
  assert.deepStrictEqual(seen, ["Update tape", "5\n6"]);
});

const trim2 = n => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
test("tapes made before 0.4.0 get a double-click button and open with their lines", () => {
  const env = makeEnv(); const doc = new env.Doc(2);
  const { computeTape, formatTape } = env.ART._internal;
  const text = formatTape("Old one", computeTape("12,400 Cash\n-800 O/S cheque\n=\n250 x 4 Rent\n(50) fee\nx 1.1"), "AB");
  const old = doc.addAnnot({ type: "FreeText", page: 0, rect: [40, 400, 240, 520], name: "ART:P:oldtape", contents: text, textSize: 8 });
  env.ART.run("tagCheck", doc);                       // any command, or Acrobat's list of open PDFs
  env.runIntervals(1);
  assert.ok(doc._fields["ART_TBTN.oldtape"], "button added when its page is viewed");
  let seen;
  env.dialogScripts.push(ui => { seen = { titl: ui.get("titl"), init: ui.get("init"), ents: ui.get("ents"), totl: ui.get("totl") }; return "cancel"; });
  doubleClick(doc, old, 100, 450);
  assert.strictEqual(seen.titl, "Old one");
  assert.strictEqual(seen.init, "AB");
  assert.strictEqual(seen.ents, "12,400.00 Cash\n-800.00 O/S cheque\n=\n250 x 4 Rent\n(50.00) fee\nx 1.1");
  assert.strictEqual(seen.totl, trim2(computeTape("12,400 Cash\n-800 O/S cheque\n=\n250 x 4 Rent\n(50) fee\nx 1.1").total));
});

test("a posted tape reads back into the same lines", () => {
  const { computeTape, formatTape, parseTapeText } = makeEnv().ART._internal;
  const src = "1,000 Opening\n250 x 12 Rent\n-2 x 50 Refunds\n=\n(75) Bank fee\n- -30 reversal\nx 1.1 Gross-up\n/ 4\n= Per quarter";
  const t1 = formatTape("Rent", computeTape(src), "GR");
  const back = parseTapeText(t1);
  assert.strictEqual(back.titl, "Rent"); assert.strictEqual(back.init, "GR");
  assert.strictEqual(formatTape(back.titl, computeTape(back.ents), back.init), t1);
  assert.strictEqual(parseTapeText("not a tape"), null);
});

test("tape watcher: protected PDFs and closed PDFs don't cause trouble", () => {
  const env = makeEnv(); const doc = new env.Doc(1);
  const text = "TAPE\n    5.00  +\n=======\n    5.00  T  Total\nPrepared 2026-01-01";
  doc.addAnnot({ type: "FreeText", page: 0, rect: [0, 0, 300, 300], name: "ART:P:locked", contents: text, textSize: 8 });
  let tries = 0;
  doc.addField = () => { tries++; const e = new Error("Security settings prevent access"); e.name = "NotAllowedError"; throw e; };
  env.ART.run("tagCheck", doc);
  env.runIntervals(5);
  assert.ok(tries <= 1, "not retried every tick: " + tries);
  assert.strictEqual(env.alerts.filter(a => /error|protected/i.test(a)).length, 0, "no pop-ups from the background timer");
  Object.defineProperty(doc, "pageNum", { get() { throw new Error("closed"); } });
  env.runIntervals(1);
  assert.strictEqual(env.ART._internal.watchState().docs.indexOf(doc), -1, "closed PDF forgotten");
});

test("a tape's text changed directly in Acrobat isn't undone by a later double-click edit", () => {
  const env = makeEnv(); const doc = new env.Doc(1);
  const tape = makeTape(env, doc, { titl: "Bank", ents: "12,400 Cash\n-800 O/S cheque" }, 50, 700);
  tape.contents = tape.contents.replace("Cash", "Cash at bank").replace(/\n/g, "\r");   // edited in the tape; Acrobat uses \r
  env.runIntervals(1);
  let ents;
  env.dialogScripts.push(ui => { ents = ui.get("ents"); ui.enter("5+"); return ui.ok(); });
  doubleClick(doc, tape, 70, 660);
  assert.strictEqual(ents, "12,400.00 Cash at bank\n-800.00 O/S cheque");
  assert.ok(/Cash at bank/.test(tape.contents) && /11,605\.00  T/.test(tape.contents), tape.contents);
});

test("just viewing a PDF with tapes doesn't mark it as changed", () => {
  const env = makeEnv(); const doc = new env.Doc(2);
  makeTape(env, doc, { ents: "1\n2" }, 50, 700);
  const regBefore = doc.info.ARTRegister;
  const env2 = makeEnv();                            // Acrobat restarted, same PDF opened
  Object.setPrototypeOf(doc, env2.Doc.prototype);
  doc.dirty = false;
  env2.ART.run("tagCheck", doc); doc.dirty = false;
  env2.runIntervals(3);
  assert.strictEqual(doc.dirty, false, "no 'Save changes?' for looking");
  // An old tape gets its button, still without marking the PDF changed.
  doc.addAnnot({ type: "FreeText", page: 1, rect: [40, 400, 240, 520], name: "ART:P:old", contents: "TAPE\n 5.00  +\n=====\n 5.00  T  Total\nPrepared 2026-01-01", textSize: 8 });
  doc.dirty = false; doc.goTo(1);
  assert.ok(doc._fields["ART_TBTN.old"]);
  assert.strictEqual(doc.dirty, false);
  assert.ok(regBefore);
});

test("a reference tag on a tape's figures still jumps to its match", () => {
  const env = makeEnv(); const doc = new env.Doc(3);
  const tape = makeTape(env, doc, { ents: "1\n2\n3\n4\n5" }, 50, 700);
  refPairs(env, doc, [[0, 80, 650], [2, 300, 300]]);   // A-1 on the tape's total, its match on page 3
  doc.pageNum = 0;
  const n = env.dialogs.length;
  doc.press(tapeBtn(doc, tape).name, 80, 650);
  assert.strictEqual(doc.pageNum, 2, "went to the match");
  assert.strictEqual(env.dialogs.length, n, "calculator didn't open");
});

test("calculator: a tape whose click was abandoned is picked up by the next Calc Tape", () => {
  const env = makeEnv(); const doc = new env.Doc(3);
  env.dialogScripts.push(ui => { ui.type("titl", "Accruals"); ui.enter("100+200+3"); return ui.ok() || (ui.enter("") && ui.ok()); });
  env.ART.run("calcTape", doc);
  assert.ok(doc.getField("ART_CAP.p0"), "waiting for the click");
  env.ART.run("repairTags", doc);                     // something else instead of the click
  let seen;
  env.dialogScripts.push(ui => { seen = { totl: ui.get("totl"), titl: ui.get("titl"), stat: ui.get("stat") }; return "cancel"; });
  env.ART.run("calcTape", doc);
  assert.deepStrictEqual([seen.totl, seen.titl], ["303.00", "Accruals"]);
  assert.ok(/Picked up/.test(seen.stat), seen.stat);
  env.dialogScripts.push(ui => { seen = { totl: ui.get("totl") }; return "cancel"; });
  env.ART.run("calcTape", doc);
  assert.strictEqual(seen.totl, "", "Cancel then Calc Tape starts afresh");
  // Clicking Calc Tape while the tape is waiting for its click also brings it back.
  env.dialogScripts.push(ui => { ui.enter("7+"); return ui.enter("") && ui.ok(); });
  env.ART.run("calcTape", doc);
  env.dialogScripts.push(ui => { seen = { totl: ui.get("totl") }; return "cancel"; });
  env.ART.run("calcTape", doc);
  assert.strictEqual(seen.totl, "7.00");
});

test("fields left by 0.4.0's on-page calculator are tidied away", () => {
  const env = makeEnv(); const doc = new env.Doc(1);
  doc.addField("ART_CALC.entr", "text", 0, [270, 780, 600, 760]).setAction("Keystroke", "if(typeof ARTool!=='undefined'){ARTool._calcKey(this,event);}");
  doc.addField("ART_CALC.place", "button", 0, [270, 740, 400, 720]).setAction("MouseUp", "if(typeof ARTool!=='undefined'){ARTool._calcBtn(this,'place');}");
  doc.type("ART_CALC.entr", "5"); env.runTimers();
  assert.strictEqual(doc.fieldNames().length, 0);
  assert.strictEqual(env.alerts.length, 0);
});

test("invisible buttons left by deleted tapes are tidied when the PDF is next used", () => {
  const env = makeEnv(); const doc = new env.Doc(3);
  const tape = makeTape(env, doc, { ents: "1" }, 50, 700);
  env.runIntervals(1);
  doc.pageNum = 2; tape.destroy();                    // deleted from the Comments list while on another page
  env.runIntervals(1);
  assert.ok(tapeBtn(doc, tape), "still there this session");
  const env2 = makeEnv(); Object.setPrototypeOf(doc, env2.Doc.prototype);
  env2.ART.run("tagCheck", doc); env2.runIntervals(1);
  assert.strictEqual(tapeBtn(doc, tape), undefined, "tidied next session");
});

test("two tapes with the same name (page inserted from a copy) both keep working", () => {
  const env = makeEnv(); const doc = new env.Doc(3);
  const t1 = makeTape(env, doc, { titl: "One", ents: "1\n2" }, 50, 700);
  const t2 = doc.addAnnot(Object.assign(t1.getProps(), { page: 2, contents: t1.contents.replace("One", "Copy") }));
  doc.addField("ART_TBTN." + t1.name.slice(6), "button", 2, [55, 680, 100, 660]);   // Acrobat merges the buttons
  doc.goTo(2); doc.goTo(0); doc.goTo(2);
  assert.strictEqual(tapeBtn(doc, t1).widgets.length, 2, "shared button left alone");
  let titl;
  env.dialogScripts.push(ui => { titl = ui.get("titl"); return "cancel"; });
  doc.press(tapeBtn(doc, t1).name, 70, 670); doc.press(tapeBtn(doc, t1).name, 70, 670);
  assert.strictEqual(titl, "Copy", "opens the tape on the page you're looking at");
  assert.ok(t2);
});

test("resizing a tape re-fits the text instead of cutting it off", () => {
  const env = makeEnv(); const doc = new env.Doc(1);
  const { tapeSize } = env.ART._internal;
  const tape = makeTape(env, doc, { titl: "Bank rec", ents: "12,400 Balance per bank\n+3,250 Deposit in transit\n-800 O/S cheque" }, 50, 700);
  const r0 = tape.rect.slice(); const w0 = r0[2] - r0[0]; const h0 = r0[3] - r0[1];
  assert.strictEqual(tape.textSize, 8);
  // Drag the right edge in to 60% of the width.
  tape.rect = [r0[0], r0[1], r0[0] + w0 * 0.6, r0[3]];
  env.runIntervals(1);
  assert.ok(tape.textSize <= 5 && tape.textSize >= 4.25, "smaller text: " + tape.textSize);
  let s = tapeSize(tape.contents, tape.textSize);
  assert.ok(Math.abs(tape.rect[2] - tape.rect[0] - s[0]) < 0.01 && Math.abs(tape.rect[3] - tape.rect[1] - s[1]) < 0.01, "box fits the text exactly");
  assert.ok(tape.rect[2] - tape.rect[0] <= w0 * 0.6 + 0.01, "no wider than you dragged it: " + (tape.rect[2] - tape.rect[0]));
  assert.ok(tape.rect[3] - tape.rect[1] < h0 * 0.7, "shorter too, so the text isn't cut off at the bottom");
  assert.strictEqual(tape.rect[0], r0[0]); assert.strictEqual(tape.rect[3], r0[3]);
  assert.strictEqual(tape.richContents[0].textSize, tape.textSize, "the text itself is resized");
  // Drag the bottom edge down: the whole tape scales up.
  const r1 = tape.rect.slice();
  tape.rect = [r1[0], r1[3] - (r1[3] - r1[1]) * 3, r1[2], r1[3]];
  env.runIntervals(1);
  assert.ok(tape.textSize > 10, "bigger text: " + tape.textSize);
  s = tapeSize(tape.contents, tape.textSize);
  assert.ok(Math.abs(tape.rect[2] - tape.rect[0] - s[0]) < 0.01, "width grew to match");
  const b = tapeBtn(doc, tape).rect;
  assert.ok(b[0] > tape.rect[0] && b[2] < tape.rect[2] && b[3] > tape.rect[1] && b[1] < tape.rect[3], "button resized with it");
  assert.strictEqual(JSON.parse(doc.info.ARTRegister).items[tape.name].fs, tape.textSize, "size remembered for Repair");
  // Nothing more happens on later ticks.
  const r2 = tape.rect.slice(); env.runIntervals(3);
  assert.deepStrictEqual(tape.rect, r2);
});

test("moving a tape moves its double-click button; deleting it removes the button", () => {
  const env = makeEnv(); const doc = new env.Doc(1);
  const tape = makeTape(env, doc, { ents: "1\n2" }, 50, 700);
  const r0 = tape.rect.slice();
  tape.rect = [r0[0] + 200, r0[1] - 300, r0[2] + 200, r0[3] - 300];
  env.runIntervals(1);
  assert.strictEqual(tape.textSize, 8, "text size unchanged");
  const b = tapeBtn(doc, tape).rect;
  assert.ok(b[0] > 250 && b[1] < 400, "button moved with the tape: " + b);
  tape.destroy();                                     // Delete key
  env.runIntervals(1);
  assert.strictEqual(tapeBtn(doc, tape), undefined);
  // A tape deleted while another page was showing: Repair Tags tidies its button.
  const t2 = makeTape(env, doc, { ents: "3" }, 50, 300);
  doc.pageNum = 0; t2.destroy();
  env.alertAnswers.push(3, 4);                        // forget it, OK
  env.ART.run("repairTags", doc);
  assert.strictEqual(doc.fieldNames().length, 0);
});

test("clicking on a tape while placing a reference places the tag there", () => {
  const env = makeEnv(); const doc = new env.Doc(2);
  const tape = makeTape(env, doc, { ents: "1\n2\n3\n4" }, 50, 700);
  env.ART.run("placeTag", doc);
  const n = env.dialogs.length;
  const b = tapeBtn(doc, tape);
  doc.press(b.name, 70, 660);
  const tag = doc._annots.find(a => a.name === "ART:T:A-1:1");
  assert.ok(tag && tag.rect[0] < 70 && tag.rect[2] > 70, "tag placed where clicked");
  assert.strictEqual(env.dialogs.length, n, "calculator didn't open");
  env.ART.run("placeTag", doc);
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
  makeTape(env, doc, { titl: "t", ents: "1\n2" }, 50, 500);
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
  makeTape(env, doc, { titl: "t", ents: "1" }, 50, 500);
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
  makeTape(env, doc, { titl: "t", ents: "1\n2" }, 300, 600);
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

const tagNamed = (doc, n) => doc._annots.find(a => a.name === n);
const linkOn = (doc, page) => doc._links.find(l => l.page === page);

test("Delete Tag: each click deletes a whole reference straight away, no questions", () => {
  const env = makeEnv(); const doc = new env.Doc(4);
  refPairs(env, doc, [[0, 100, 100], [2, 300, 300], [1, 200, 200], [3, 400, 400]]);   // A-1 p.1/p.3, A-2 p.2/p.4
  env.ART.run("deleteTag", doc);
  doc.goTo(0); doc.goTo(3);
  assert.ok(doc.getField("ART_CAP.p0") && doc.getField("ART_CAP.p3"), "click anywhere in the document");
  assert.ok(/Click a tag to delete it/.test(doc.status()), doc.status());
  const alerts = env.alerts.length;
  doc.click(300, 300, 2);                   // A-1's match on page 3
  assert.deepStrictEqual(names(doc), ["ART:T:A-2:1", "ART:T:A-2:2"], "both A-1 tags gone");
  assert.ok(!linkOn(doc, 0) && !linkOn(doc, 2), "and their links");
  assert.ok(/A-1 deleted .*Undo/.test(doc.status()), doc.status());
  doc.click(200, 200, 1);                   // still deleting: the next click deletes A-2
  assert.strictEqual(doc._annots.length, 0);
  assert.strictEqual(doc._links.length, 0);
  assert.strictEqual(env.alerts.length, alerts, "no pop-ups while deleting");
  doc.bar("done");
  assert.strictEqual(doc.fieldNames().length, 0);
  env.ART.run("repairTags", doc);
  assert.strictEqual(doc._annots.length, 0, "repair doesn't resurrect deleted tags");
});

test("Delete Tag: Undo on the bar puts deleted references back, links and all", () => {
  const env = makeEnv(); const doc = new env.Doc(4);
  refPairs(env, doc, [[0, 100, 100], [2, 300, 300], [1, 200, 200], [3, 400, 400]],
    { colr: { Red: -1, Blue: 1, Green: -1, Black: -1 }, size: { Small: -1, Medium: -1, Large: 1 } });
  const before = doc._annots.map(a => a.name + " " + a.page + " " + a.rect.join(",")).sort();
  env.ART.run("deleteTag", doc);
  doc.click(300, 300, 2);                   // A-1
  doc.click(400, 400, 3);                   // A-2
  assert.strictEqual(doc._annots.length, 0);
  doc.bar("undo");
  assert.deepStrictEqual(names(doc), ["ART:T:A-2:1", "ART:T:A-2:2"], "last one first");
  assert.ok(/A-2 put back/.test(doc.status()), doc.status());
  doc.bar("undo");
  assert.deepStrictEqual(doc._annots.map(a => a.name + " " + a.page + " " + a.rect.join(",")).sort(), before, "same places");
  const t = tagNamed(doc, "ART:T:A-1:1");
  assert.strictEqual(t.textSize, 10, "same size");
  assert.strictEqual(JSON.stringify(t.strokeColor), JSON.stringify(["RGB", 0, 0.25, 0.75]), "same colour");
  assert.strictEqual(t.readOnly, true);
  doc.pageNum = 1;
  assert.strictEqual(followLink(env, doc, linkOn(doc, 0)), 2, "A-1 jumps to its match again");
  assert.strictEqual(followLink(env, doc, linkOn(doc, 3)), 1, "A-2 too");
  doc.bar("undo");
  assert.ok(/Nothing left to undo/.test(doc.status()), doc.status());
  assert.strictEqual(doc._annots.length, 4);
  doc.bar("done");
  assert.strictEqual(JSON.parse(doc.info.ARTRegister).items["ART:T:A-1:2"].page, 2, "register knows they're back");
});

test("Delete Tag: clicking empty space says so on the bar, no pop-up, and deletes nothing", () => {
  const env = makeEnv(); const doc = new env.Doc(2);
  refPairs(env, doc, [[0, 100, 100], [1, 100, 100]]);
  env.ART.run("deleteTag", doc);
  const alerts = env.alerts.length;
  doc.click(400, 600, 0);
  assert.ok(/No tag there/.test(doc.status()), doc.status());
  assert.strictEqual(env.alerts.length, alerts);
  assert.strictEqual(doc._annots.length, 2);
  doc.click(100, 100, 0);                   // still on: a click on the tag deletes it
  assert.strictEqual(doc._annots.length, 0);
});

test("Delete Tag deletes an unmatched tag on its own", () => {
  const env = makeEnv(); const doc = new env.Doc(3);
  refPairs(env, doc, [[0, 100, 100], [1, 100, 100], [2, 50, 50]]);   // A-1 pair + A-2 waiting for its match
  env.ART.run("deleteTag", doc);
  doc.click(50, 50, 2);
  assert.deepStrictEqual(names(doc), ["ART:T:A-1:1", "ART:T:A-1:2"]);
  assert.strictEqual(doc._links.length, 2, "A-1's links untouched");
  doc.bar("done");
  assert.strictEqual(JSON.parse(doc.info.ARTRegister).pending, null, "nothing left waiting for a match");
});

test("reference mode: Delete stays on for tag after tag, and shows it's on", () => {
  const env = makeEnv(); const doc = new env.Doc(4);
  env.ART.run("placeTag", doc);
  doc.click(100, 100, 0); doc.click(100, 100, 1);    // A-1 pair
  doc.click(200, 200, 0); doc.click(200, 200, 2);    // A-2 pair
  doc.click(300, 300, 0); doc.click(300, 300, 3);    // A-3 pair
  const alerts = env.alerts.length;
  doc.goTo(0);
  const off = JSON.stringify(doc.getField("ART_BAR.del.p0").fillColor);
  doc.bar("del");
  assert.ok(/Click a tag to delete it/.test(doc.status()), doc.status());
  const on = JSON.stringify(doc.getField("ART_BAR.del.p0").fillColor);
  assert.notStrictEqual(on, off, "Delete button changes colour while it's on");
  doc.click(100, 100, 1);                             // A-1's match: both A-1 tags go
  assert.ok(/A-1 deleted/.test(doc.status()), doc.status());
  doc.click(200, 200, 0);                             // A-2's figure: both A-2 tags go
  assert.deepStrictEqual(names(doc), ["ART:T:A-3:1", "ART:T:A-3:2"]);
  assert.strictEqual(env.alerts.length, alerts, "no questions");
  doc.goTo(3);
  assert.strictEqual(JSON.stringify(doc.getField("ART_BAR.del.p3").fillColor), on, "shows on other pages too");
  doc.bar("undo");                                    // A-2 back
  assert.deepStrictEqual(names(doc), ["ART:T:A-2:1", "ART:T:A-2:2", "ART:T:A-3:1", "ART:T:A-3:2"]);
  doc.bar("del");                                     // off: back to placing
  assert.strictEqual(JSON.stringify(doc.getField("ART_BAR.del.p3").fillColor), off);
  assert.ok(/^A-4 .*figure/.test(doc.status()), doc.status());
  doc.click(400, 400, 3);
  assert.ok(tagNamed(doc, "ART:T:A-4:1"), "clicks place tags again");
  doc.goTo(0);
  assert.strictEqual(JSON.stringify(doc.getField("ART_BAR.del.p0").fillColor), off, "page 1 caught up");
  doc.bar("undo");                                    // Undo goes back through placing and deleting in order: A-4 ...
  assert.ok(!tagNamed(doc, "ART:T:A-4:1"));
  doc.bar("undo");                                    // ... then the A-1 delete
  env.ART.run("placeTag", doc);
  assert.deepStrictEqual(names(doc), ["ART:T:A-1:1", "ART:T:A-1:2", "ART:T:A-2:1", "ART:T:A-2:2", "ART:T:A-3:1", "ART:T:A-3:2"]);
});

test("reference mode: deleting the half-placed pair, then Undo, carries on waiting for its match", () => {
  const env = makeEnv(); const doc = new env.Doc(4);
  env.ART.run("placeTag", doc);
  doc.click(100, 100, 0); doc.click(100, 100, 1);    // A-1 pair
  doc.click(200, 200, 0);                             // A-2 figure, waiting for its match
  doc.bar("del");
  doc.click(200, 200, 0);                             // delete A-2
  doc.bar("del");
  assert.ok(/^A-2 .*click the figure/.test(doc.status()), "A-2 starts again: " + doc.status());
  doc.bar("undo");                                    // put it back
  assert.ok(/^A-2 .*now click its match/.test(doc.status()), doc.status());
  doc.click(250, 250, 3);
  assert.ok(/^A-3 /.test(doc.status()), doc.status());
  doc.pageNum = 2;
  assert.strictEqual(followLink(env, doc, doc._links.find(l => l.page === 0 && l.rect[0] < 200 && l.rect[2] > 200)), 3);
  env.ART.run("placeTag", doc);
  assert.strictEqual(JSON.parse(doc.info.ARTRegister).pending, null);
});

test("Undo after choosing a new number in Options: the half-placed pair still gets its match", () => {
  const env = makeEnv(); const doc = new env.Doc(4);
  env.ART.run("placeTag", doc);
  doc.click(100, 100, 0); doc.click(100, 100, 1);    // A-1 pair
  doc.click(200, 200, 0);                             // A-2 figure, waiting
  doc.bar("del"); doc.click(200, 200, 0); doc.bar("del");
  env.dialogResults.push({ next: "B-1" });
  doc.bar("opts");
  assert.ok(/^B-1/.test(doc.status()), doc.status());
  doc.bar("undo");                                    // A-2 figure back: its match comes first
  assert.ok(/^A-2 .*now click its match/.test(doc.status()), doc.status());
  doc.click(250, 250, 3);
  assert.ok(tagNamed(doc, "ART:T:A-2:2"));
  env.ART.run("placeTag", doc);
  assert.strictEqual(JSON.parse(doc.info.ARTRegister).pending, null);
});

test("Undo never leaves the next click on a number that's back in use", () => {
  const env = makeEnv(); const doc = new env.Doc(4);
  env.ART.run("placeTag", doc);
  doc.click(100, 100, 0); doc.click(100, 100, 1);    // A-1
  doc.click(200, 200, 0); doc.click(200, 200, 1);    // A-2
  doc.bar("del"); doc.click(100, 100, 0); doc.bar("del");
  env.dialogResults.push({ next: "A-1" });            // allowed: A-1 is gone
  doc.bar("opts");
  doc.bar("undo");                                    // A-1 is back
  assert.ok(!/^A-1 /.test(doc.status()) && !/^A-2 /.test(doc.status()), doc.status());
  doc.click(300, 300, 2); doc.click(300, 300, 3);
  env.ART.run("placeTag", doc);
  const n = names(doc);
  assert.strictEqual(new Set(n).size, n.length, "no two tags with the same name: " + n);
  assert.strictEqual(n.length, 6);
});

test("while deleting, the bar on the page you clicked shows what happened (several pages on screen)", () => {
  const env = makeEnv(); const doc = new env.Doc(6);
  refPairs(env, doc, [[0, 100, 100], [4, 400, 400]]);
  env.ART.run("deleteTag", doc);
  doc.goTo(4); doc.goTo(0);                           // pages 1 and 5 set up; Acrobat calls page 1 current
  const f = doc._fields["ART_CAP.p4"];
  new (vm.runInContext("Function", env.ctx))("event", f.script.replace(/this\.mouseX/g, 400).replace(/this\.mouseY/g, 400)).call(doc, { target: f });
  env.runTimers();
  assert.strictEqual(doc._annots.length, 0);
  assert.ok(/A-1 deleted/.test(doc._fields["ART_BAR.status.p4"].caption), doc._fields["ART_BAR.status.p4"].caption);
  assert.ok(/A-1 deleted/.test(doc._fields["ART_BAR.status.p0"].caption));
});

test("Undo while deleting says what it did each time", () => {
  const env = makeEnv(); const doc = new env.Doc(3);
  env.ART.run("placeTag", doc);
  doc.click(100, 100, 0); doc.click(100, 100, 1);    // A-1
  doc.bar("del"); doc.click(100, 100, 1);
  doc.bar("undo");
  assert.ok(/A-1 put back/.test(doc.status()), doc.status());
  doc.bar("undo");
  assert.ok(/A-1 tag taken off/.test(doc.status()), doc.status());
  assert.deepStrictEqual(names(doc), ["ART:T:A-1:1"]);
});

test("Undo puts back the tag you clicked even when a copied page has one with the same name", () => {
  const env = makeEnv(); const doc = new env.Doc(5);
  refPairs(env, doc, [[0, 100, 100], [1, 100, 100]]);
  const copy = doc.addAnnot(Object.assign(tagNamed(doc, "ART:T:A-1:1").getProps(), { page: 4 }));  // page inserted from a copy
  env.ART.run("deleteTag", doc);
  doc.click(100, 100, 0);
  doc.bar("undo");
  assert.strictEqual(doc._annots.filter(a => a.name === "ART:T:A-1:1" && a.page === 0).length, 1, "page 1's tag is back");
  assert.ok(doc._annots.includes(copy), "the copy is untouched");
});

test("Delete Tag from the menu while placing switches the bar's Delete on", () => {
  const env = makeEnv(); const doc = new env.Doc(3);
  env.ART.run("placeTag", doc);
  doc.click(100, 100, 0); doc.click(100, 100, 1);
  env.ART.run("deleteTag", doc);
  env.ART.run("deleteTag", doc);                      // a second time doesn't switch it off
  assert.ok(/Click a tag to delete it/.test(doc.status()), doc.status());
  doc.click(100, 100, 1);
  assert.strictEqual(doc._annots.length, 0);
  assert.strictEqual(env.ART.isActive(), true, "still in reference mode");
});

test("a tag left waiting to be put back by 0.4.1's 'just this one' is still asked for first", () => {
  const env = makeEnv(); const doc = new env.Doc(4);
  refPairs(env, doc, [[0, 100, 100], [2, 300, 300]]);
  const t = tagNamed(doc, "ART:T:A-1:2"); t.readOnly = false; t.destroy();
  doc._links = doc._links.filter(l => l.page !== 2);
  const reg = JSON.parse(doc.info.ARTRegister);
  delete reg.items["ART:T:A-1:2"]; reg.redo = { label: "A-1", side: 2 };
  doc.info.ARTRegister = JSON.stringify(reg);
  env.ART.run("placeTag", doc);
  assert.ok(/A-1 .*click where it should go/.test(doc.status()), doc.status());
  doc.click(320, 350, 3);
  assert.strictEqual(tagNamed(doc, "ART:T:A-1:2").page, 3);
  assert.ok(/A-2 .*click the figure/.test(doc.status()), doc.status());
  assert.strictEqual(followLink(env, doc, linkOn(doc, 0)), 3, "link follows the re-placed tag");
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

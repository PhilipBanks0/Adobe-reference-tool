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
function makeEnv() {
  const env = { httpRequests: [], launched: [], alerts: [], alertAnswers: [], responses: [], dialogs: [], dialogResults: [], timers: [] };

  class Annot {
    constructor(doc, props) { this._doc = doc; Object.assign(this, props); if (!this.name) this.name = "auto" + Math.random(); this.rect = props.rect.slice(); }
    getProps() { const o = {}; for (const k of Object.keys(this)) if (k[0] !== "_") o[k] = Array.isArray(this[k]) ? this[k].slice() : this[k]; return o; }
    destroy() { this._doc._annots = this._doc._annots.filter(a => a !== this); }
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
      const f = { name, page: p, box, setAction(ev, s) { this.script = s; } };
      this._fields[name] = f; return f;
    }
    getField(n) { return this._fields[n] || null; }
    removeField(n) { delete this._fields[n]; }
    getPageBox(t, p) { const r = this._rot[p] || 0; return (r === 90 || r === 270) ? [0, 612, 792, 0] : [0, 792, 612, 0]; } // rotated user space, like Acrobat
    getPageRotation(p) { return this._rot[p] || 0; }
    replacePages(o) {
      // Worst case: the new page arrives with nothing on it.
      this._annots = this._annots.filter(a => a.page !== o.nPage);
      this._links = this._links.filter(l => l.page !== o.nPage);
      this._replaced = o;
    }
    scroll() {}
    // helper: simulate a user click on the capture field
    click(x, y) {
      const f = this._fields.ART_CAPTURE;
      assert(f, "capture field should exist");
      const self = this;
      const fn = new (vm.runInContext("Function", ctx))("event", f.script.replace(/this\.mouseX/g, x).replace(/this\.mouseY/g, y));
      fn.call(self, { target: { page: f.page } });
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
      const loaded = {};
      const res = env.dialogResults.shift();
      if (res === undefined) throw new Error("unexpected dialog");
      const dlg = { load(o) { Object.assign(loaded, o); }, store() { return Object.assign({}, loaded, typeof res === "object" ? res : {}); } };
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
    addSubMenu() {}, addMenuItem() {}, addToolButton(o) { (env.buttons = env.buttons || []).push(o.cLabel); }
  };
  function runTimers() { while (env.timers.length) vm.runInContext(env.timers.shift(), ctx); }

  ctx = vm.createContext({
    app, JSON, Math, Date, String, Number, Array, Object, RegExp, Error, parseInt, parseFloat,
    color: { blue: ["RGB", 0, 0, 1], transparent: ["T"] },
    border: { d: "dashed" }, highlight: { n: "none" }, display: { noPrint: 3 },
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
const followLink = (env, doc, link) => { new (vm.runInContext("Function", env.ctx))(link.action).call(doc); return doc.pageNum; };

console.log("Reference Tool tests");

test("toolbar buttons install", () => {
  const env = makeEnv();
  assert.deepStrictEqual(env.buttons, ["Place Tag", "Calc Tape", "Tag Check", "Replace Page", "Repair Tags"]);
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

test("place tag pair by clicking, links jump both ways", () => {
  const env = makeEnv(); const doc = new env.Doc(20);
  env.responses.push("A-1");
  env.ART.run("placeTag", doc);
  doc.click(300, 400);
  let reg = JSON.parse(doc.info.ARTRegister);
  assert.strictEqual(reg.pending, "A-1");
  assert.strictEqual(doc.getField("ART_CAPTURE"), null, "capture field removed");
  doc.pageNum = 13;
  env.alertAnswers.push(4); // yes, place the match
  env.ART.run("placeTag", doc);
  doc.click(100, 200);
  reg = JSON.parse(doc.info.ARTRegister);
  assert.strictEqual(reg.pending, null);
  assert.strictEqual(reg.next, 2);
  assert.deepStrictEqual(names(doc), ["ART:T:A-1:1", "ART:T:A-1:2"]);
  assert.strictEqual(doc._links.length, 2);
  const s1 = doc._annots.find(a => a.name.endsWith(":1"));
  assert.strictEqual(s1.page, 0);
  assert.ok(s1.rect[0] < 300 && s1.rect[2] > 300 && s1.rect[1] < 400 && s1.rect[3] > 400, "tag centred on click");
  assert.strictEqual(s1.readOnly, true);
  const l1 = doc._links.find(l => l.page === 0);
  const l2 = doc._links.find(l => l.page === 13);
  doc.pageNum = 5; assert.strictEqual(followLink(env, doc, l1), 13);
  assert.strictEqual(followLink(env, doc, l2), 0);
});

test("links still work after pages are reordered", () => {
  const env = makeEnv(); const doc = new env.Doc(20);
  env.responses.push("A-1"); env.ART.run("placeTag", doc); doc.click(300, 400);
  doc.pageNum = 10; env.ART.run("placeTag", doc); doc.click(100, 100);
  // simulate moving page 10 to page 2
  doc._annots.forEach(a => { if (a.page === 10) a.page = 2; });
  doc._links.forEach(l => { if (l.page === 10) l.page = 2; });
  const l1 = doc._links.find(l => l.page === 0);
  assert.strictEqual(followLink(env, doc, l1), 2);
});

test("next label auto-increments", () => {
  const env = makeEnv(); const doc = new env.Doc(5);
  env.responses.push("A-1"); env.ART.run("placeTag", doc); doc.click(10, 10);
  doc.pageNum = 1; env.ART.run("placeTag", doc); doc.click(10, 10);
  let asked = null;
  env.ctx.app.response = o => { asked = o.cDefault; return null; };
  env.ART.run("placeTag", doc);
  assert.strictEqual(asked, "A-2");
});

test("duplicate labels are refused", () => {
  const env = makeEnv(); const doc = new env.Doc(5);
  env.responses.push("A-1"); env.ART.run("placeTag", doc); doc.click(10, 10);
  env.alertAnswers.push(3); // No: leave unmatched, start new
  env.responses.push("A-1");
  env.ART.run("placeTag", doc);
  assert.ok(env.alerts.some(a => /already in use/.test(a)));
  assert.strictEqual(doc.getField("ART_CAPTURE"), null);
});

test("selected rectangle comment places tag beside it", () => {
  const env = makeEnv(); const doc = new env.Doc(5);
  const box = doc.addAnnot({ type: "Square", page: 2, rect: [100, 100, 160, 115], name: "userbox" });
  doc.selectedAnnots = [box];
  env.responses.push("B-1");
  env.ART.run("placeTag", doc);
  const t = doc._annots.find(a => a.name === "ART:T:B-1:1");
  assert.ok(t && t.page === 2 && t.rect[0] >= 160, "tag to the right of the box");
  assert.strictEqual(doc.getField("ART_CAPTURE"), null, "no capture needed");
  assert.ok(doc._annots.includes(box), "user's rectangle kept");
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
  env.responses.push("A-1"); env.ART.run("placeTag", doc); doc.click(10, 10);
  doc.pageNum = 4; env.ART.run("placeTag", doc); doc.click(10, 10);
  env.alertAnswers.push(3); env.responses.push("A-2"); env.ART.run("placeTag", doc); doc.click(50, 50); // A-2 unmatched
  // A-1 side 2 deleted outside the tool
  doc._annots.find(a => a.name === "ART:T:A-1:2").destroy();
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
  env.responses.push("A-1"); env.ART.run("placeTag", doc); doc.click(200, 300);
  doc.pageNum = 6; env.ART.run("placeTag", doc); doc.click(220, 330);
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
  env.responses.push("A-1"); env.ART.run("placeTag", doc); doc.click(20, 20);
  doc.pageNum = 1; env.ART.run("placeTag", doc); doc.click(20, 20);
  env.ART.run("repairTags", doc); env.ART.run("repairTags", doc);
  assert.strictEqual(doc._links.length, 2);
  assert.strictEqual(doc._annots.length, 2);
});

test("Replace Page (Keep Tags) keeps tags, tapes and optionally other comments", () => {
  const env = makeEnv(); const doc = new env.Doc(10);
  env.responses.push("C-1"); env.ART.run("placeTag", doc); doc.click(100, 100);
  doc.pageNum = 3; env.ART.run("placeTag", doc); doc.click(120, 140);
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
  env.responses.push("A-1"); env.ART.run("placeTag", doc); doc.click(100, 100);
  doc.pageNum = 2; env.ART.run("placeTag", doc); doc.click(100, 100);
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
  env.responses.push("A-1"); env.ART.run("placeTag", doc); doc.click(100, 100);
  doc.pageNum = 2; env.ART.run("placeTag", doc); doc.click(100, 100);
  env.responses.push("A-1"); env.alertAnswers.push(4);
  env.ART.run("deleteTag", doc);
  assert.strictEqual(doc._annots.length, 0);
  assert.strictEqual(doc._links.length, 0);
  env.ART.run("repairTags", doc);
  assert.strictEqual(doc._annots.length, 0, "repair doesn't resurrect deleted tags");
});

test("clicking Place Tag again cancels click mode", () => {
  const env = makeEnv(); const doc = new env.Doc(2);
  env.responses.push("A-1"); env.ART.run("placeTag", doc);
  assert.ok(doc.getField("ART_CAPTURE"));
  env.ART.run("placeTag", doc);
  assert.strictEqual(doc.getField("ART_CAPTURE"), null);
  assert.strictEqual(doc._annots.length, 0);
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
  env.responses.push("A-1");
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

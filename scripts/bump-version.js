#!/usr/bin/env node
// Sets the version everywhere it lives and adds a CHANGELOG stub.
//   node scripts/bump-version.js 0.3.0
"use strict";
const fs = require("fs");
const path = require("path");
const v = (process.argv[2] || "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(v)) { console.error("Usage: node scripts/bump-version.js X.Y.Z"); process.exit(1); }
const root = path.join(__dirname, "..");

const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.version = v;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const jsPath = path.join(root, "src", "ReferenceTool.js");
const js = fs.readFileSync(jsPath, "utf8");
const js2 = js.replace(/var VERSION = "[^"]+";/, `var VERSION = "${v}";`);
if (js === js2 && !js.includes(`var VERSION = "${v}";`)) { console.error("VERSION line not found in ReferenceTool.js"); process.exit(1); }
fs.writeFileSync(jsPath, js2);

const clPath = path.join(root, "CHANGELOG.md");
let cl = fs.existsSync(clPath) ? fs.readFileSync(clPath, "utf8") : "# Changelog\n";
if (!cl.includes(`## ${v}`)) {
  const today = new Date().toISOString().slice(0, 10);
  cl = cl.replace(/^# Changelog\n/, `# Changelog\n\n## ${v} - ${today}\n\n- Describe the changes here.\n`);
  fs.writeFileSync(clPath, cl);
}
console.log(`Version set to ${v}. Edit CHANGELOG.md, commit, then: git tag v${v} && git push && git push origin v${v}`);

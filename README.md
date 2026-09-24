# Workpaper Reference Tool for Adobe Acrobat Pro

An Acrobat add-on for preparing accounting work papers.

| Feature | What it does |
|---|---|
| **Place Tag** | Puts a matching pair of reference tags (e.g. `A-1`) on a figure in the financial statements and on the same figure in the support. Clicking either tag jumps to the other. |
| **Calc Tape** | A calculator that leaves its tape on the page as a comment, so the reviewer can see how a figure was worked out. |
| **Tag Check** | Lists every tag with its page numbers and flags tags that are unmatched or broken. |
| **Replace Page (Keep Tags)** | Swaps a page for a new version (for example a reissued bank statement) and puts back the tags and tapes that were on it. |
| **Repair Tags** | Restores tags or tapes that were lost outside the tool, for example after using Acrobat's own *Replace Pages*, and refreshes all links. |
| **Move Tag / Delete Tag** | Moves one tag to a new spot, or removes both sides of a tag. |

**Reviewers don't need the add-on.** The tags and tapes are ordinary PDF comments and links, so anyone using Acrobat or Acrobat Reader can see them and click through.

---

## Requirements

- **Adobe Acrobat Pro** (Standard should work too) on Windows or Mac. Creating tags needs Acrobat; Reader users can only view and follow them.
- JavaScript turned on: *Preferences → JavaScript → Enable Acrobat JavaScript*.

## Install

1. Go to the **[latest release](https://github.com/PhilipBanks0/Adobe-reference-tool/releases/latest)** and download `ReferenceTool-vX.Y.Z.zip`.
2. Unzip it (right-click → **Extract All**). Don't run it from inside the zip.
3. Close Acrobat.
4. Install:
   - **Windows:** double-click `Install.cmd`.
   - **Mac:** right-click `install.command` → **Open**.
5. Open Acrobat. Everything is under **Menu → Reference Tool**: the Menu button at the top left. In classic Acrobat it's **Edit → Reference Tool**.

The Windows installer:

- copies the add-on into Acrobat's program folder (`C:\Program Files\Adobe\Acrobat DC\Acrobat\Javascripts`). Current Acrobat versions only load add-ons from there, so **Windows asks once for permission: click Yes**,
- installs an updater and an uninstaller,
- adds **Start menu → Reference Tool** shortcuts.

**Where the toolbar buttons appear** (Place Tag, Calc Tape, Tag Check, Replace Page, Repair Tags) depends on the Acrobat version:

- Classic interface: *View → Tools → Add-on Tools*.
- New interface: *All tools*.
- If you can't find them, *Menu → Reference Tool* always has every command.

If the menu doesn't show up, go to *Preferences → JavaScript* and tick *Enable Acrobat JavaScript*.

**Manual install:** copy `ReferenceTool.js` from the release into your Acrobat JavaScripts folder:

- Windows: `C:\Program Files\Adobe\Acrobat DC\Acrobat\Javascripts\` (needs admin). To find the exact folder, open the JavaScript console with Ctrl+J and run `app.getPath("app","javascript")`.
- Mac: `~/Library/Application Support/Adobe/Acrobat/DC/JavaScripts/`

## Updating

- **In Acrobat:** *Menu → Reference Tool → Check for Updates*. Acrobat also checks quietly about once a week after it starts, and pops up only when there's a new version. To turn the automatic check off, set `autoUpdateCheck: false` in the settings. Acrobat may ask once whether it may connect to `api.github.com`; allow it.
- **Windows:** close Acrobat and run *Start menu → Reference Tool → Update Reference Tool*. It:
  1. shows what's new,
  2. downloads the release,
  3. checks it against the release's SHA-256 checksums,
  4. installs it.
- **Mac:** run `~/Library/Application Support/ReferenceTool/update.command`.

To uninstall on Windows, use *Start menu → Reference Tool → Uninstall Reference Tool*. PDFs you've already tagged keep working.

## Publishing a new release (maintainers)

```
node scripts/bump-version.js 0.3.0      # sets the version in package.json and ReferenceTool.js
# edit CHANGELOG.md; the 0.3.0 section becomes the release notes
git commit -am "Release 0.3.0"
git tag v0.3.0
git push && git push origin v0.3.0
```

Pushing the tag triggers the **Release** GitHub Action (`.github/workflows/release.yml`). It:

1. runs the tests,
2. checks that the tag matches the version,
3. builds `ReferenceTool-v0.3.0.zip`, `ReferenceTool.js` and `SHA256SUMS.txt`,
4. publishes them as a GitHub release.

Everyone's updater picks up the new release from there. To build the files locally, run `npm run build` (output goes to `dist/`).

**The repository must be public for updates to work.** The updater and Acrobat read releases without logging in.

## How to use

### Suggested workflow

1. **Tapes first, on the individual PDFs.** Open each support PDF and add calculator tapes where they're needed.
2. **Combine.** Use Acrobat's *Combine Files* to build the work paper. The tapes come across automatically.
3. **Reference.** In the combined PDF, tag each figure on the statements to its support.
4. **Before review:** run **Tag Check** and fix anything it flags.

### Place Tag

1. Go to the page with the figure (for example Cash on the balance sheet) and click **Place Tag**.
2. Accept the suggested label (`A-1`, `A-2`, …) or type your own, such as `B-3` or `Cash-1`. A blue dashed frame shows the page is waiting for a click.
3. Click the figure. Side 1 of the tag is placed.
4. Go to the supporting page and click **Place Tag** again. Answer **Yes** to place the match, then click the matching figure.

Click **Place Tag** again at any time to cancel click mode.

To jump between the two sides, click a tag with the normal Hand/Select tool.

**Tip:** If you draw a rectangle comment around a figure and keep it selected before clicking Place Tag, the tag goes right next to the rectangle and you skip the click step. The rectangle stays on the page as a highlight.

### Calc Tape

1. Go to the page where the tape should go and click **Calc Tape**.
2. Enter one line per entry: `[+ - * /] amount description`. For example:

   ```
   12,400      Balance per bank
   + 3,250     Deposit in transit
   - 800       Outstanding cheque #1042
   =
   (50)        Bank fee not recorded
   ```

   - Negatives can be written as `(800)` or `-800`.
   - A line with only `=` inserts a subtotal.
   - `x 5%` multiplies the running total by 5%.
3. Click **Preview tape** to check it, then **Place on page**, then click where the top-left corner of the tape should go.

The tape records your initials and the date. You can drag it to a new position afterwards.

```
TAPE: Bank rec
  12,400.00  +  Balance per bank
   3,250.00  +  Deposit in transit
     800.00  -  Outstanding cheque #1042
  ----------
  14,850.00  S  Subtotal
     (50.00) +  Bank fee not recorded
=============
  14,800.00  T  Total
Prepared by GR 2026-09-24
```

### Tag Check

Shows a list like this:

```
Tags: 12    Linked: 10    Unmatched: 1    Broken: 1
Tapes: 4

BROKEN
A-7  (side 2 missing - run Repair Tags)

UNMATCHED
A-12  on p.3 has no matching tag (waiting)

LINKED
A-1      p.1  <->  p.14
...
```

### Replace Page (Keep Tags)

Use this when a page needs a newer version, for example a reissued statement or an updated schedule.

1. Go to the page and click **Replace Page**.
2. Choose the new PDF and which of its pages to use.
3. Choose whether to carry over other comments on the page, such as reviewer notes.

The tags and tapes go back in the same positions. If the figures on the new page sit somewhere else, use **Menu → Reference Tool → Move Tag**.

### Repair Tags

The add-on keeps a hidden register of every tag and tape inside the PDF, in its document properties. If something goes missing, **Repair Tags** lists it and offers three choices:

- **Yes:** restore it.
- **No:** forget it, because it was deleted on purpose.
- **Cancel:** do nothing.

Repair Tags also rebuilds every link, which is useful after moving tags or reordering pages.

---

## Good to know

- **Page reordering is safe.** Links find their partner by name when they're clicked, not by page number.
- **Tags are locked** so a click goes to the link rather than selecting the comment. Use **Move Tag** and **Delete Tag** to change them.
- **Protected PDFs** can't be tagged. Acrobat won't let anything be added to a PDF that's certified, digitally signed (blue bar at the top) or secured. Combine it into your work paper with *Combine Files*, or print it to PDF, and tag that copy.
- **Don't flatten** the work paper until review is complete. Flattening turns tags and tapes into static marks with no links.
- **Deleting a tape by hand:** Repair Tags will offer to restore it. Answer **No** to forget it.
- **Browser PDF viewers:** tags and tapes are visible, but the jump between tags needs Acrobat or Reader, because the links use Acrobat JavaScript.

## Settings

The top of `src/ReferenceTool.js` has a `cfg` block you can edit to change:

- the default label prefix,
- tag and tape font sizes,
- colours,
- `mouseYFromTop`. If tags land at the wrong height when you click, set this to `true`.

## Testing

- `npm test`: the add-on's logic, run against a mock of Acrobat's JavaScript API.
- `pwsh test/installer.tests.ps1`: Windows install, update (including a tampered-download check) and uninstall, run against a mock GitHub.
- `bash test/mac-installer.test.sh`: the same for Mac.

The **Tests** GitHub Action runs all three on Linux, Windows (PowerShell 5.1 and 7) and macOS for every push.

The mock can't show how Acrobat itself behaves, so a manual check in Acrobat Pro is also needed. Sample files are in `samples/`; regenerate them with `python3 samples/make_sample.py`.

**Manual test checklist (first run in Acrobat)**

- [ ] The *Menu → Reference Tool* menu and the toolbar buttons appear.
- [ ] Place Tag: the tag lands where you click.
  - If the height is off, set `mouseYFromTop: true`.
- [ ] Clicking a tag jumps to its match, and back again.
- [ ] Calc Tape: the tape's columns line up in a monospaced font.
- [ ] Save, close and reopen the PDF. Tags still link, and the next suggested label continues the sequence.
- [ ] Combine two PDFs that have tapes, then run Tag Check. The tapes are counted.
- [ ] Replace Page with `samples/updated-bank-statement.pdf`. The tags come back.
- [ ] Use Acrobat's own *Organize Pages → Replace*, then **Repair Tags**. The tags are restored.
- [ ] Test a landscape (rotated) page. The link sits on top of the tag.
- [ ] Open the file in Acrobat Reader. The tags are visible and clickable.
- [ ] *Check for Updates* reaches GitHub (allow the connection if Acrobat asks).
- [ ] The Start menu *Update Reference Tool* shortcut reports "up to date" on the latest release.

## Roadmap ideas

- A tag index page that can be exported into the work paper.
- Cross-file tags, for binders kept as separate PDFs.
- Tick-mark stamps (✓, footed, cross-footed, agreed to GL).
- Tying a tape's total to a tag automatically.

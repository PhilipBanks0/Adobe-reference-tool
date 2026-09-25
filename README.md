# Workpaper Reference Tool for Adobe Acrobat Pro

An Acrobat add-on for preparing accounting work papers.

| Feature | What it does |
|---|---|
| **Reference** | Click a figure in the financial statements, then its match in the support. Numbers run on automatically (A-1, A-2, …), and clicking either tag jumps to the other. |
| **Calc Tape** | A 10-key style calculator that leaves its tape on the page as a comment, so the reviewer can see how a figure was worked out. Double-click a tape to change it. |
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
5. Open Acrobat. Everything is in the **Reference Tool menu**: **Menu → Plugins → For editing → Reference Tool** (the Menu button at the top left, where Acrobat puts add-ons). In classic Acrobat it's **Edit → Reference Tool**.

The Windows installer:

- copies the add-on into Acrobat's program folder (`C:\Program Files\Adobe\Acrobat DC\Acrobat\Javascripts`, or `C:\Program Files (x86)\...` for 32-bit Acrobat). Current Acrobat versions only load add-ons from there, so **Windows asks once for permission: click Yes**,
- installs an updater and an uninstaller,
- lets Acrobat start the updater: it registers a `reftool-update:` link and adds it to Acrobat's allowed link types (same permission prompt),
- adds **Start menu → Reference Tool** shortcuts.

**Adding the buttons to your toolbar** (Reference, Calc Tape, Tag Check, Replace Page, Repair Tags):

- New interface: click the **⋯** at the bottom of the left-hand quick-tools bar, choose **Customize toolbar**, and add them from the add-on/custom tools section.
- Classic interface: *View → Tools → Add-on Tools*.
- If you can't find them, the Reference Tool menu (*Menu → Plugins → For editing → Reference Tool*) always has every command.

If the menu doesn't show up, go to *Preferences → JavaScript* and tick *Enable Acrobat JavaScript*.

**If the installer says NOT FINISHED**, the add-on isn't in Acrobat's program folder yet, and the installer says why:

- *Permission was declined:* run `Install.cmd` again and click **Yes**.
- *Your account isn't an administrator / security software stopped it / the copy failed:* the installer prints a note to send IT, with the exact folder. IT can enter an administrator's name and password when you run `Install.cmd`, or copy `ReferenceTool.js` into that folder themselves. The note also includes an optional `icacls` command that lets later updates install without IT.
- *Acrobat wasn't found:* in Acrobat, press Ctrl+J, type `app.getPath("app","javascript")` and press Ctrl+Enter. Then, in a Command Prompt in the installer folder, run `Install.cmd -AcrobatFolder "<the folder it shows>"`.

Installing from a network drive is fine: the installer copies the add-on to your PC first, because Windows' administrator window can't see network drives.

**Manual install:** copy `ReferenceTool.js` from the release into your Acrobat JavaScripts folder:

- Windows: `C:\Program Files\Adobe\Acrobat DC\Acrobat\Javascripts\`, or `C:\Program Files (x86)\Adobe\Acrobat DC\Acrobat\Javascripts\` for 32-bit Acrobat (needs admin). To find the exact folder, open the JavaScript console with Ctrl+J and run `app.getPath("app","javascript")` (Ctrl+Enter runs it). Copy the file from a folder on your PC, not a network drive: Windows' administrator copy can't see network drives.
- Mac: `~/Library/Application Support/Adobe/Acrobat/DC/JavaScripts/`

## Updating

- **In Acrobat:** *Reference Tool menu → Check for Updates*. Acrobat also checks quietly about once a week after it starts. When there's a new version, click **Yes**:
  1. the updater downloads it,
  2. checks it against the release's SHA-256 checksums,
  3. installs it (Windows asks for permission once).

  Restart Acrobat when it's done. The first time, Acrobat may ask whether it can connect to `api.github.com`; allow it. If **Yes** does nothing (an Acrobat update can reset its allowed link types), run the Start menu updater below once; it turns the link back on. To turn the weekly check off, set `autoUpdateCheck: false` in the settings.
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

### Reference (placing tags)

1. Click **Reference** on the toolbar, or go to **Reference Tool menu → Reference Tool**.
2. The options panel opens. Check the next reference (e.g. `A-1`) and pick a colour and size, then click **Start**.
3. Click the figure on the financial statements, then click the matching figure in the support, on any page.
4. Keep going: the next click places `A-2`, then its match, and so on. You don't type numbers.
5. When you're finished, click **Done** on the bar at the top of the page, or click **Reference** again.

While reference mode is on, a small bar sits at the top of the page. It appears on each page a moment after you get there (the add-on sets pages up as you reach them, so it's just as quick on a very large work paper); if a click doesn't place a tag, wait for the bar:

- **Status:** shows what your next click places, e.g. `A-3 - now click its match`.
- **Undo:** removes the last tag you placed.
- **Delete:** click it, then click any tag to delete it.
  - **Yes** deletes both sides.
  - **No** deletes just the one you clicked; your next click puts it back in the right place.
- **Options:** change the next number, colour or size.
- **Done:** finishes reference mode.

The bar doesn't print and goes away when you finish.

**Fixing mistakes later:** go to **Reference Tool menu → Delete Tag**, then click the tag on any page. **Yes** removes both sides. **No** removes only that one: start the Reference tool again and your first click puts it back.

To jump between the two sides of a reference, click either tag with the normal Hand/Select tool.

### Calc Tape

1. Go to the page where the tape should go and click **Calc Tape**. A calculator appears in the top-right corner of the page.
2. Type amounts like on a 10-key adding machine. Each key acts as soon as you press it, and the tape and **Total** update straight away:

   ```
   12400 +                        adds 12,400
   800 -                          subtracts 800
   250 * 12 +                     adds 3,000 (250 x 12)
   * 1.05 +                       multiplies the total so far by 1.05
   / 2 +                          divides the total so far by 2
   800 O/S cheque      Enter      a line with a description
   =                   Enter      subtotal
   ```

   - **+** and **-** act on the number you just typed. **\*** and **/** act on the next number.
   - The keys only act after a plain number, so descriptions such as `O/S` or `Year-end` type normally. Press **Enter** to add a line with a description.
   - Negatives: `(800)` or start the number with `-`.
   - **Undo line** takes the last line off. You can also edit the lines in the box on the left; the tape updates when you click out of it.
   - **Move** puts the calculator in another corner. It follows you as you move from page to page.
3. Click **Place on page**. Anything still in the Amount box is added first.
4. Click where the top-left corner of the tape should go.

The tape records your initials and the date. After it's placed:

- **Change it:** double-click its figures. The calculator opens with everything filled in; change it and click **Update tape**. (Or select the tape and click **Calc Tape**.)
- **Move it:** drag it by its title line or edge.
- **Resize it:** drag a corner or edge. The text grows or shrinks to fit, so nothing is cut off.

If another command interrupts a calculation, click **Calc Tape** again to pick it up where you left off. **Cancel** throws it away.

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

The tags and tapes go back in the same positions. If the figures on the new page sit somewhere else, use **Reference Tool menu → Move Tag**.

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

- [x] The Reference Tool menu appears under *Menu → Plugins → For editing* (verified in Acrobat 26.0, 32-bit, 2026-09-25).
- [ ] The toolbar buttons appear.
- [x] Reference: the tag lands where you click (verified in Acrobat 26.x), and clicking a tag jumps to its match.
  - If the height is off, set `mouseYFromTop: true`.
- [ ] Clicking a tag jumps to its match, and back again.
- [ ] Calc Tape: the tape's columns line up in a monospaced font.
- [ ] Calc Tape: + - * / act the moment they're pressed, and the Amount box clears; Enter keeps the cursor in the box.
- [ ] Calc Tape: scroll to another page. The calculator follows, with the cursor back in Amount.
- [ ] Double-click a tape's figures: the calculator opens filled in; Update tape changes it in place.
- [ ] Drag a tape's corner smaller and larger: the text re-fits and isn't cut off. Drag it by the title line to move it.
- [ ] A reference tag placed on a tape's total still jumps to its match.
- [ ] Open a PDF with tapes, just look, close: Acrobat doesn't ask to save.
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

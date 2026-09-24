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

1. Quit Acrobat.
2. Copy `src/ReferenceTool.js` into your Acrobat **user JavaScripts folder**:
   - **Windows:** `%APPDATA%\Adobe\Acrobat\DC\JavaScripts\`
     (paste that into File Explorer's address bar; create the `JavaScripts` folder if it doesn't exist)
   - **Mac:** `~/Library/Application Support/Adobe/Acrobat/DC/JavaScripts/`
   - If neither location works: open Acrobat, press **Ctrl+J** (Mac: **Cmd+J**) to open the JavaScript console, type `app.getPath("user","javascript")` and press **Ctrl+Enter**. The console shows the correct folder.
3. Start Acrobat and open a PDF.

**Where the buttons appear**

- **Menu:** *Edit → Reference Tool* has every command.
- **Toolbar buttons** (Place Tag, Calc Tape, Tag Check, Replace Page, Repair Tags) appear under Acrobat's add-on or custom tools. Where that is depends on the Acrobat version:
  - Classic interface: *View → Tools → Add-on Tools*.
  - New interface: look under *All tools*.
- If you can't find the buttons, the *Edit* menu always works.

To deploy to a team, copy the same file into each person's JavaScripts folder. IT can also push it to the application-level folder, for example `C:\Program Files\Adobe\Acrobat DC\Acrobat\Javascripts\`.

---

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

The tags and tapes go back in the same positions. If the figures on the new page sit somewhere else, use **Edit → Reference Tool → Move Tag**.

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

`test/run-tests.js` runs the add-on against a mock of Acrobat's JavaScript API. It covers tape maths and formatting, tag pairing, links after page reordering, Tag Check, Repair, Replace Page, Move Tag and Delete Tag.

```
npm test
```

The mock can't show how Acrobat itself behaves, so a manual check in Acrobat Pro is also needed. Sample files are in `samples/`; regenerate them with `python3 samples/make_sample.py`.

**Manual test checklist (first run in Acrobat)**

- [ ] The *Edit → Reference Tool* menu and the toolbar buttons appear.
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

## Roadmap ideas

- A tag index page that can be exported into the work paper.
- Cross-file tags, for binders kept as separate PDFs.
- Tick-mark stamps (✓, footed, cross-footed, agreed to GL).
- Tying a tape's total to a tag automatically.

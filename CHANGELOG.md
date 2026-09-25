# Changelog

## 0.4.0 - 2026-09-25

- **Calc Tape now works like a 10-key adding machine.** The calculator opens on the page itself (top-right corner) instead of a pop-up window, so it can react to each key the moment you press it:
  - Type an amount and press **+** to add it or **-** to subtract it. It goes straight onto the tape and the total updates.
  - **\*** or **/** multiplies or divides by the next number you type: `250 * 12 +` adds 3,000. Pressing **\*** or **/** on an empty box works on the total so far: `* 1.05 +` grosses up the running total.
  - **Enter** still adds a line, which is how you add one with a description (`800 O/S cheque`). The keys only act after a plain number, so the `/` in `O/S` or the `-` in `Year-end` type normally.
  - **Undo line** takes the last line off, **Move** puts the calculator in another corner, and it follows you from page to page as you scroll. Click **Place on page**, then click where the tape goes.
  - If another command interrupts a calculation, click **Calc Tape** again to pick it up where you left off. **Cancel** throws it away.
- **Double-click a tape to change it.** The calculator opens with the tape's title, lines and initials filled in. Change them and click **Update tape**; the tape updates where it is. You can also select a tape and click **Calc Tape**.
- **Resizing a tape no longer cuts off its text.** Drag any edge or corner and the text grows or shrinks to fill the box, and the box snaps to fit it.
- Move a tape by dragging its title line or edge (the figures are where you double-click). Reference tags placed on a tape's figures still jump to their match.
- Tapes from earlier versions get the double-click the first time you view their page, and their lines are read back from the tape itself.
- Each tape now carries an invisible, non-printing button over its figures. Acrobat may show its "This document contains form fields" bar on work papers with tapes. Reviewers without the add-on aren't affected.

## 0.3.10 - 2026-09-25

- **Fixed: Acrobat froze when you started the Reference tool (or Delete Tag) on a large work paper.** The add-on used to put its click-catcher and bar on every page at once, and because the bar's buttons were shared across pages, the work grew with the square of the page count: a 114-page file meant about 380,000 button redraws before the first click. Now it sets up the page you're on straight away and each page you move to a moment after you get there, so it starts just as fast on a 1,000-page work paper as on a 1-page one, and every click takes the same time however far you've gone.
- If a click on a page you've just scrolled to doesn't place a tag, wait until the bar appears at the top of that page; that's the sign it's ready.

## 0.3.9 - 2026-09-25

- **Fixed: the Reference Tool menu didn't show in the new Acrobat.** It's now under **Menu → Plugins → For editing → Reference Tool**, next to your other add-ons (in classic Acrobat: **Edit → Reference Tool**). Acrobat accepted the old spot directly in Menu without an error, but never displayed it.

## 0.3.8 - 2026-09-25

- **Fixed: installing from a network drive (for example Q:) never reached Acrobat's program folder.** After you click Yes, Windows runs the copy in a separate administrator window, and that window can't see network drives. The installer now copies the add-on to your PC's temp folder first, so it works from anywhere.
- **The installer says exactly why it couldn't finish, and what to do:** you clicked No, your account isn't an administrator, security software stopped it, or the copy failed (with the error). When IT is needed, it prints a note you can send them, with the exact folder and, optionally, a command that lets later updates install without them.
- It warns before the permission box when your account isn't an administrator, so you know Windows will ask for an administrator's name and password.
- The permission step now runs as a normal, visible PowerShell window instead of a hidden one with an encoded command, which security software tends to block.
- If the add-on is already in Acrobat's folder (for example IT copied it in), running the installer again doesn't ask for permission.
- Finds more Acrobat versions (2017, 2024 and others, 32- and 64-bit). If Acrobat is somewhere else, `Install.cmd -AcrobatFolder "<folder>"` installs there, and updates remember it.
- Updates from Acrobat or the Start menu now report it when the new version couldn't be put in Acrobat's folder, instead of saying it was updated.

## 0.3.7 - 2026-09-25

- Version bump.

## 0.3.6 - 2026-09-25

- **Fixed: clicking Yes to install an update from Acrobat did nothing.** Acrobat only passes a link to Windows if that link type is on its allowed list, and the updater link wasn't. The Windows installer now adds it, in the same permission prompt it already shows. Each update adds it back if an Acrobat update removed it, and the uninstaller takes it out.
- Takes effect once this version is installed with `Install.cmd` or **Start menu → Reference Tool → Update Reference Tool**. From then on, **Yes** in Acrobat starts the updater.

## 0.3.5 - 2026-09-25

- Version bump.

## 0.3.4 - 2026-09-25

- **Delete references by clicking them.** On the reference bar, click **Delete**, then click the tag. Outside reference mode, use **Menu → Reference Tool → Delete Tag**, then click any tag on any page.
- When you delete, choose **Yes** to remove both sides, or **No** to remove just the one you clicked. With No, the next click (or the next time you start the Reference tool) puts that tag back where it belongs, and its link follows.
- Release notes in Acrobat's update message no longer show Markdown symbols.

## 0.3.3 - 2026-09-25

- **One-click updates from Acrobat (Windows).** When a new version is found, click **Yes** and the updater downloads it, checks it against the release's SHA-256 checksum, and installs it. Windows asks for permission once. No more trips to the GitHub page. Restart Acrobat when it's done.
- The installer registers a small per-user `reftool-update:` link so Acrobat can start the updater; the uninstaller removes it.
- If Acrobat can't start the updater, it says so and falls back to the Start menu updater and the download page.

## 0.3.2 - 2026-09-25

- Calc Tape works like an adding machine: type an amount (and a description) in the entry box and press **Enter**. The line goes straight onto the tape and the total updates, with the cursor ready for the next number. Acrobat only refreshes a box when you leave it, so the tape now updates on Enter instead of on every keystroke.
- Press Enter on an empty entry box, or click **Place on page**, when you're done. A line that can't be read stays in the box with an explanation so you can fix it.
- You can still edit the tape lines directly; the preview updates when you click out of that box, or with **Refresh preview**.

## 0.3.1 - 2026-09-25

- Calc Tape: the preview and a running **Total** box now update as you type, so you can see the calculation build up. (A **Refresh preview** button is still there as a backup.)
- Fix: **Delete Tag** (and Undo / Move Tag) left the tag's box on the page. Tags are locked so clicks reach their link, and Acrobat won't delete a locked comment; they're now unlocked first. If deleting ever fails, you get an error message instead of nothing happening.

## 0.3.0 - 2026-09-25

- **Reference mode.** Click **Reference** (toolbar or Menu → Reference Tool), then click a figure and click its match on any page. The next number follows automatically (A-1, A-2, …); there are no prompts between clicks.
- **Options panel** when you start: next reference number, tag colour (red, blue, green, black) and size. Untick "Show these options each time" to skip it.
- **Options bar** at the top of every page while you're referencing: what the next click places, **Undo**, **Options** and **Done**. The bar doesn't print and disappears when you finish.
- Finishing with half a pair (a figure with no match yet) picks up at its match next time.
- Toolbar buttons now have icons, and the Reference button shows as pressed while reference mode is on.

## 0.2.2 - 2026-09-24

- Protected PDFs (certified, digitally signed or secured) now get a plain explanation and what to do, instead of a raw "NotAllowedError: Security settings prevent access" message. Acrobat doesn't allow tags or tapes on those files; combine them into the work paper or print them to PDF first.

## 0.2.1 - 2026-09-24

- Fix: the Reference Tool menu didn't appear in the new Acrobat interface (Acrobat 2024 and later), which has no Edit menu. It now appears under **Menu → Reference Tool** (the ☰ Menu button at the top left). Classic Acrobat still uses **Edit → Reference Tool**.
- Fix: current Acrobat versions don't load add-ons from the per-user JavaScripts folder. The Windows installer now installs into Acrobat's program folder (`C:\Program Files\Adobe\Acrobat DC\Acrobat\Javascripts`), asking once for admin permission, and removes old per-user copies. If permission is declined it falls back to the per-user folder and says so.

## 0.2.0 - 2026-09-24

- One-click installer for Windows (`Install.cmd`) and Mac (`install.command`) in each GitHub release.
- Updates: **Edit > Reference Tool > Check for Updates** in Acrobat, a quiet weekly check when Acrobat starts, and an **Update Reference Tool** Start menu shortcut that downloads, verifies and installs the latest release.
- Uninstaller (Start menu shortcut on Windows).

## 0.1.0 - 2026-09-24

- Paired reference tags with click-through links, calculator tapes, Tag Check, Replace Page (Keep Tags), Repair Tags, Move Tag, Delete Tag.

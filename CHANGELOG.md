# Changelog

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

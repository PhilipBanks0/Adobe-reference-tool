# Changelog

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

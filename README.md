# Toastmasters Workspace

A single-page web app for Toastmasters meeting prep: upcoming meetings, role assignments, speech drafts, rehearsal timing, feedback follow-up, and special-event planning.

This site is meant to be served at `tm.raymondmarr.com` with GitHub Pages. The app is static HTML, CSS, and JavaScript. There is no server, account, or third-party backend.

## Where your data lives

All notes, roles, speeches, practice logs, feedback, and event plans are stored in **this browser’s `localStorage`**. They never leave your device unless you export them. Clearing site data, switching browsers, or using a private window will look like an empty workspace.

## Export and import

Use **Export** in the app header to download a JSON backup of everything in the workspace. Keep that file somewhere safe, or copy it to another computer.

Use **Import** to restore from a previously exported JSON file. The app validates the file and asks for confirmation before replacing the current data.

**Reset** clears the workspace (after confirmation) and restores the built-in defaults, including a draft speech titled “History of Attention.”

## Privacy

The published page is unlisted (`noindex`). Keep personal details in your local data or in an exported backup, not in the source code.

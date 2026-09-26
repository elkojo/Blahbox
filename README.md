# Blahbox

A pocket soundboard that installs on your phone as an app (PWA) and works fully offline.

- Tap a pad to play its sound. Sounds can overlap; **Stop all** silences everything.
- **+** adds your own sound: pick an audio file or record one with the mic.
- **Long-press** a pad to change its name, emoji or color, or to delete it.
- **Edit** mode: drag pads to reorder, tap one to edit it.
- **⋯ Settings**: pads per row (2/3/4), export/import a backup, restore hidden built-in sounds.

Your own sounds are stored only on the phone (IndexedDB). Export a backup now and then —
clearing the browser's site data or uninstalling the app removes them.

## Publish on GitHub Pages

1. Create a repo on GitHub and push these files to the `main` branch.
2. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   branch `main`, folder `/ (root)`.
3. After a minute the app is live at `https://<your-user>.github.io/<repo>/`.

## Install on the phone

Open that URL once while online, then:

- **Android (Chrome):** menu **⋮ → Install app** (or "Add to Home screen").
- **iPhone (Safari):** **Share → Add to Home Screen**.

After that it runs from the home screen with no internet needed.

## Adding built-in sounds

1. Put the audio file in `sounds/`.
2. Add an entry to `sounds/sounds.json`:
   ```json
   { "file": "MySound.mp3", "name": "My sound", "emoji": "🔔", "color": "peach" }
   ```
   Colors: `rose`, `peach`, `lemon`, `mint`, `teal`, `sky`, `lavender`, `lilac`, `sand`, `stone`.
   Sounds over 2 MB (like the 12-minute rain track) are streamed instead of loaded into memory.
3. **Bump `VERSION` in `sw.js`** (e.g. `v1` → `v2`) and push.

Installed phones pick up the new version the next time the app is opened online and show an
**Update** prompt. Bump `VERSION` for any change to the app's files, otherwise phones keep the cached copy.

## Run locally

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Service workers need `localhost` or HTTPS, not `file://`.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page markup and dialogs |
| `styles.css` | Styles |
| `app.js` | Soundboard logic: playback, editor, recording, reorder, backup |
| `sw.js` | Service worker: caches everything for offline use |
| `manifest.webmanifest` | App name, icons, install settings |
| `sounds/` | Built-in sounds and `sounds.json` list |
| `icons/` | App icons — `icon.svg` is the source; the PNGs are rendered from it |

# PC Cleanup

A small Windows housekeeping app: manage what runs at startup, and reclaim disk
space from caches and clutter. Electron front end, PowerShell doing the
privileged work underneath.

## Running it

Double-click **`dist\PC Cleanup.exe`** — a single portable file, no install, no
dependencies. Copy it anywhere (desktop, USB stick, another PC) and it runs.

Windows SmartScreen will show *"Windows protected your PC"* the first time,
because the executable is not code-signed. Click **More info → Run anyway**.
Signing it would need a paid code-signing certificate.

To run from source instead, double-click **`PC Cleanup.bat`**, or:

```bash
npm start
```

Some locations are machine-wide (`C:\Windows\Temp`, the Windows Update cache,
`HKLM` startup entries, scheduled tasks). To touch those, use
**`PC Cleanup (as admin).bat`**, or press *Restart as administrator* in the
bottom-left of the app. Without it, those rows are visible but read-only and
tagged *Needs administrator*.

## What it does

**Startup** — lists everything that launches at sign-in:

| Source | Location |
| --- | --- |
| Registry (you) | `HKCU\…\CurrentVersion\Run` |
| Registry (all users) | `HKLM\…\CurrentVersion\Run` |
| Registry (all users, 32-bit) | `HKLM\…\Wow6432Node\…\Run` |
| Run once | `…\RunOnce`, both hives |
| Startup folders | your Startup folder and the all-users one |
| Scheduled tasks | anything with a logon or boot trigger |

Each row shows the publisher, the real command line and the program's own icon.
An entry whose target no longer exists is tagged **File missing**; one with no
version information is tagged **Unsigned**.

**Cleanup** — user and system temp, Windows Update cache, Delivery Optimisation,
prefetch, crash dumps and error reports, thumbnail/icon cache, Chrome, Edge,
Firefox and Brave caches, and the Recycle Bin. Every row shows its size and file
count before anything happens.

**Registry** — finds entries that point at programs which are no longer
installed: leftover Add/Remove Programs entries, App Paths, shared-DLL
reference counts, cached program names, and startup entries whose target is
gone. Every removal is backed up first.

**Large files** — two views of the same folders (Downloads, Desktop, Documents,
Videos, Pictures). Known folders are resolved through Windows, so a Desktop
redirected into OneDrive is found correctly rather than missed.

- **List** — everything above a size threshold and/or untouched for a given
  time, biggest first.
- **Map** — a squarified treemap in the style of SpaceMonger or WinDirStat.
  Every rectangle's *area* is proportional to its size, so whatever is filling
  the disk is literally the biggest shape on screen. Tiles are coloured by file
  type and cushion-shaded, hovering lifts and tilts a tile towards the cursor,
  double-clicking a folder zooms in, and the breadcrumb walks back out.

**Both views use the same filters.** Set *Larger than* to "Any size" for a
complete picture of where the space goes; leave it at 100 MB and the map shows
only the big files. The line under the breadcrumb always says which filter is in
force and how many files matched, and changing a filter or a folder marks the
map stale rather than leaving a picture that no longer matches the controls.

**Backups** — every restore point the app has written, with a one-click restore.

## How it stays safe

- **Disabling a startup item does not delete it.** Windows records the on/off
  state in a separate `StartupApproved` key as a 12-byte blob — `02…` for enabled,
  `03…` plus a timestamp for disabled. Writing that blob is exactly what Task
  Manager's Startup tab does, so a change here shows up there and is fully
  reversible. The `Run` value itself is left alone.
- **Nothing is removed without being shown first.** Cleanup always scans, lists
  sizes, and waits for you to tick rows and confirm.
- **The renderer never sends a path to delete.** It sends a target id; the paths
  are resolved in the main process from a fixed table.
- **A blocklist backs that up.** Drive roots, `C:\Windows`, `System32`,
  `Program Files`, `ProgramData`, your profile root and the `AppData` roots can
  never be emptied, whatever a wildcard expands to.
- **Files in use are skipped, not forced**, and reported in the result.
- **Large files go to the Recycle Bin**, never a hard delete, and only if they
  sit inside one of the scanned folders.
- **Deleting a startup entry writes a restore point** before touching the
  registry, so Delete is recoverable too — not just Disable. Startup-folder
  shortcuts go to the Recycle Bin instead.

### The registry scan in particular

Registry cleaners have a bad reputation because they delete things they cannot
prove are unused. This one only reports an entry when it names a **concrete
filesystem path that is definitely not there**, and:

- a path on a **drive that is not currently mounted** is ignored, so an
  unplugged USB disk or an offline network share never looks like junk;
- `DisplayIcon` is **never** used as evidence — a missing icon file is cosmetic
  and says nothing about whether the program is installed;
- a command line that cannot be parsed with confidence yields **no finding at
  all**, rather than a guess. (An earlier version split at the first space,
  which turned `C:\Program Files\…\x.ico` into `C:\Program` — a path that does
  not exist, making healthy entries look like junk.)
- entries managed by **Windows Installer** and hidden `SystemComponent` entries
  are skipped entirely;
- **file associations and COM/CLSID registrations are not scanned at all.**
  That is where registry cleaners break machines, for no measurable gain.

Restore points live in `%APPDATA%\PC Cleanup\backups\<timestamp>\` as a plain
`restore.reg` plus a `manifest.json`. They are ordinary registry files — you can
double-click one in Explorer without the app.

Whole keys are captured with `reg export`; single values are reconstructed as
`hex(N)` entries so removing one value from a large shared key does not mean
exporting the whole key beside it. Round-tripping is verified for `REG_SZ`,
`REG_EXPAND_SZ`, `REG_DWORD`, `REG_QWORD`, `REG_BINARY`, `REG_MULTI_SZ`, value
names containing quotes and backslashes, and keys with subkeys.

## Layout

```
main.js         window, IPC handlers
preload.js      contextBridge API (contextIsolation on, nodeIntegration off)
src/ps.js       persistent PowerShell host — base64 in, JSON out, no shell quoting
src/walk.js     concurrent directory walker
src/sys.js      admin check, disk usage, elevation
src/startup.js  startup entries and scheduled tasks
src/clean.js    cleanup targets, scanning, deletion, the safety guard
src/files.js    large/old file scan, known-folder resolution, Recycle Bin
src/registry.js registry scan and clean
src/backup.js   .reg restore points: write, list, restore, discard
src/treemap.js  size tree for the map, pruned per-node for the renderer
ui/             index.html, style.css, app.js, treemap.js
```

### The treemap

The full size tree stays in the main process. A folder like a synced OneDrive
Desktop holds six figures of files, and shipping all of it to the renderer would
be tens of megabytes of JSON; instead the renderer asks for one node at a time
and gets a pruned view — children worth at least 0.15% of their parent, six
levels deep, with everything smaller rolled into one "smaller items" block. That
lands at a few hundred KB.

Layout is the squarified algorithm (Bruls, Huizing & van Wijk), which keeps
rectangles close to square so their areas can actually be compared by eye.
Drawing is canvas rather than SVG: a dense map is several thousand rectangles,
and that many DOM nodes makes hovering feel sticky.

Tiles are drawn as solid blocks, not flat sheets. The footprint is filled with a
much darker version of the colour and the lit top face is inset from it by the
block's depth, so what shows along the right and bottom edges reads as the sides
of a raised object. Shading alone was not enough — it looked like coloured
paper; the visible side walls are what give the blocks mass. Depth scales with
the tile, and below about five pixels a block falls back to a flat fill, where
there is no room for a face and sides anyway.

Hovering redraws the tile under the cursor raised, thickened and sheared towards
it; canvas 2D has no perspective, but a small shear with the highlight and
shadow swinging the opposite way reads convincingly as a tilt. There is
deliberately **no outline on the hovered block** — a white rectangle traced round
the footprint sits outside the lit face and flattens the whole illusion, which is
the one thing that made the blocks look like sheets again. The raise, the
thickening and the tilt are the cue. The selection marker traces the *top face*
for the same reason.

The tooltip waits a second before appearing — so sweeping across the map does
not fill it with flashing panels — and is translucent with a blur behind it, so
it never hides the tile it is describing.

That only stays smooth because of **two canvases**: the map is rendered once
into an offscreen buffer, and a hover just blits that buffer and redraws the one
tile. A full re-layout costs ~18 ms and happens per scan, zoom or resize; a hover
redraw costs **0.10 ms**. Re-rendering every gradient on each mouse move would
have been about two hundred times more expensive.

Geometry is verified rather than eyeballed — area share matches byte share to
two decimal places, no two rectangles overlap, nothing escapes the canvas, and
the worst aspect ratio stays under 6. Tiles that work out to less than about a
pixel are dropped, since they cannot be drawn or clicked anyway.

## Performance

The first version was slow in four separate places. Measured on a machine with
a 117,669-file OneDrive Desktop:

| | before | after |
| --- | --- | --- |
| Large-file scan | 18.8 s | **3.9 s** |
| Cleanup scan | 5.6 s | **1.1 s** |
| Startup list | 2.2 s | **0.51 s** |
| Each PowerShell call | 218 ms | **28 ms** |

What actually mattered:

- **The walker was serial.** One `stat` awaited at a time is mostly idle
  waiting; `src/walk.js` walks a level at a time with a pool of operations in
  flight. A concurrency sweep put the sweet spot at 24 directories / 96 files —
  higher is *worse*, since the work is I/O-bound on the OneDrive filter driver.
- **Every PowerShell call spawned a process.** One host process is now kept
  alive and fed scripts over stdin, and it is warmed up during window creation
  so the ~1.4 s cold start is paid while the UI is still painting.
- **`Get-ScheduledTask` blocked the startup list** for 1.5 s. It now loads
  separately and fills in underneath.
- **Cleanup targets were scanned in series**, so eleven instant targets waited
  behind the temp folder. They run concurrently now.

The renderer runs under a CSP with no `unsafe-inline`, so styles are set through
the CSSOM rather than `style` attributes.

## Rebuilding the .exe

```bash
npm run dist
```

Output lands in `dist\PC Cleanup.exe` (~71 MB — it carries its own Chromium).
`npm run icon` regenerates `build/icon.ico` from the SVG in `tools/make-icon.js`.

If the build fails with *"Cannot create symbolic link: A required privilege is
not held by the client"*, electron-builder is trying to unpack its code-signing
bundle, which contains macOS symlinks. Nothing here is signed, so extract it
without the macOS folder and the build will find it already in place:

```bash
node_modules/7zip-bin/win/x64/7za.exe x "$LOCALAPPDATA/electron-builder/Cache/winCodeSign/"*.7z -o"$LOCALAPPDATA/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0" '-xr!darwin' -y
```

## Notes

- Thumbnail cache files are usually locked by Explorer; they will be reported as
  skipped until you sign out.
- Emptying the Recycle Bin is the one genuinely permanent action, and is tagged
  **Permanent** and excluded from *Select safe items*.

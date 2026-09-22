# PC Cleanup

A Windows bench tool for keeping a PC in order: reclaim disk space, manage
startup and installed programs, and diagnose or repair the machine — a spec
sheet with drive health, product-key recovery, a network toolkit, and the
built-in repair commands, all in one place. Electron front end, PowerShell
doing the privileged work underneath.

It is built to be trustworthy with a machine you care about: it reads before it
writes, shows sizes and plans before removing anything, quarantines rather than
deletes, and writes a restore point before any registry change.

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

**Programs** — everything installed, biggest first, read from the same Uninstall
keys the registry scan walks. **Uninstall** launches the program's own
uninstaller, which is always the first thing to try. **Force remove** is for
when that uninstaller will not run — see below. Recorded sizes are whatever the
installer chose to write — often absent and frequently wrong — so **Measure**
walks the install folder for the real figure. Entries whose folder has gone are
tagged *Files missing*.

**Duplicates** — files whose contents are byte-for-byte identical, grouped with
the biggest waste first. See below for how it avoids reading everything, and for
the one mistake it will not let you make.

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

**Devices** — every present device and the driver it is running (version, date,
provider), grouped by class with the ones a technician cares about first
(display, network, storage…), searchable and collapsible. Any device with a
problem — the Device Manager yellow-bangs — is surfaced at the top with the
`ConfigManagerErrorCode` translated into plain English (no driver, disabled,
cannot start, and so on). Read-only.

**System info** — a read-only spec sheet: Windows edition, build and activation
status; make, model, motherboard and BIOS; CPU; RAM with per-module capacity,
speed and part number; graphics; and per-drive **health** (Healthy / Warning /
Unhealthy) with type, bus, and — where the drive reports them — temperature,
power-on hours and SSD life remaining. *Copy report* puts the lot on the
clipboard as plain text for a job sheet. Nothing but CIM/WMI queries, so it
changes nothing and needs no admin (though a few drive counters only appear
elevated).

**Event log** — the "why has this PC been playing up" view. Read-only. A
stability summary (blue screens, unexpected shutdowns, app crashes over 45 days)
and a crash timeline naming the program or bugcheck code, then the recent
error/warning feed from the System and Application logs — **deduplicated into
counted groups** (a warning that fired 243 times is one row, not 243), filterable
by level and searchable, each row expandable to its full text, with a
plain-English hint for the IDs that come up again and again.

**Driver export** — back up every third-party driver on the machine to a folder
before a wipe and reinstall, so the hardware that needs an OEM driver (Wi-Fi,
chipset, fingerprint reader) works the moment Windows is back. The preview lists
the third-party driver packages in use — device, provider, class, version, date —
read from `Win32_PnPSignedDriver` so the labels are correct on any language of
Windows. The export is `Export-WindowsDriver`, which writes one tidy subfolder
per package into a folder you pick; that is a DISM online operation, so the button
is disabled until the app is running as administrator.

**Performance** — a live resource monitor that polls a WMI performance-counter
snapshot every two seconds while the tab is open (and stops the moment you leave
it, so it costs nothing in the background). CPU, memory, disk-active and
network-throughput gauges with a running sparkline, plus the top eight processes
by CPU and by memory, aggregated per image name and with per-process CPU
normalised by core count. The first sample is slow — the WMI perf provider warms
up for a few seconds — so the tab shows a starting placeholder until the counters
populate.

**Battery** — for laptops: how much of the battery's original design capacity is
left (wear %, with the health graded Good/Fair/Poor), the cycle count, chemistry
and manufacturer, and the live charge with a runtime estimate. Read-only. The
figures come from the firmware's own WMI classes, and where those come back blank
(some firmwares do) it falls back to `powercfg /batteryreport` for the same
values. On a desktop there is no battery and the tab says so plainly.

**Autoruns** — the persistence auditor: the deep autostart surfaces that the
Startup tab does not touch and Task Manager hides entirely, which is where
malware hides to survive a reboot. Winlogon hooks, `AppInit_DLLs`, legacy
load/run values and policy Run keys; Image File Execution Options debugger
hijacks; auto-start services; scheduled tasks; permanent WMI event subscriptions;
and installed browser add-ons. Every entry with a file is checked against its
**Authenticode signature** and flagged when it looks wrong — unsigned, a missing
file, or running from a user-writable folder — with the flagged items pulled to a
"needs a look" list at the top and the rest grouped by category. It reads before
it writes: only services (StartupType) and scheduled tasks (enable/disable) get a
reversible toggle; the registry hooks, WMI subscriptions and add-ons are shown
read-only with a Reveal button, because emptying something like `Userinit` by
hand breaks login. A bare system-command name (`sc.exe`, `SystemPropertiesPerformance.exe`)
is treated as a trusted PATH binary rather than a "missing file", and the benign
built-in NTEventLog WMI consumer is filtered out, so a clean machine reads as
clean.

**Security** — the "is this machine set up safely" check a tech runs before
handing a PC back. Read-only. It grades Microsoft Defender (real-time on,
definition age, tamper protection), the Firewall per profile, SmartScreen,
BitLocker/drive encryption, UAC, the local administrator accounts and any enabled
account with no required password, and whether a reboot is pending — each with a
green/amber/red verdict and a plain hint on what to do. It does not change any
setting; fixing one is a deliberate act the tech does themselves. Two things stop
false alarms: if a third-party antivirus or firewall is registered and active,
Defender or the Windows Firewall being off is reported as fine rather than a hole;
and where a status genuinely needs elevation (BitLocker), it says "needs admin"
instead of a false all-clear.

**Connections** — the security companion to Autoruns: who this PC is actually
talking to and what it is listening for, because malware that has installed
itself still has to phone home. Read-only. Every TCP/UDP endpoint is paired with
its owning process (name, PID, on-disk path), loopback and LAN chatter is folded
down so genuinely outbound traffic to the public internet stands out, and a
connection is flagged only when the program behind it is unsigned or missing —
a validly-signed app is trusted wherever it lives, so the many legitimate apps
that install per-user in AppData (Slack, Spotify, this one) do not cry wolf.
Signature checks run across a small runspace pool so a machine's worth of
endpoints resolves in a few seconds rather than tens.

**Repair** — the built-in fix-a-poorly-Windows tools (SFC `/scannow`, DISM
CheckHealth / ScanHealth / RestoreHealth, and a read-only `chkdsk`) run with
their output streaming into the app rather than a console that closes on exit.
Each is explained with what it does and when to reach for it. They change
protected system files, so they need administrator rights, which the tab gates
on. SFC writes UTF-16 with carriage-return progress; the reader decodes it and
collapses a counting percentage onto one line instead of a hundred.

**Network** — every active adapter at a glance (IP, gateway, DNS, subnet, MAC,
link speed, DHCP or static); a **speed test**; the everyday quick fixes (flush
DNS, release & renew, and the admin-only Winsock / TCP-IP-stack resets); and
**ping / trace route with the output streaming live** into the app instead of a
hidden console. The live tools are spawned directly and each run can be stopped;
the host box is validated so nothing but a plausible host or IP reaches the
command line.

The **speed test** measures two honestly-different things. *Internet* is real
bytes moved and timed — download and upload Mbps, with latency and jitter —
updating live as it runs, from the main process where no page CSP blocks it.
Download tries Cloudflare first and falls back to OVH then Hetzner, because
Cloudflare rate-limits its data endpoint hard per IP after a few tests; whichever
first delivers bytes carries the run, and the status line says which. *Local network* is the NIC's negotiated
link rate (1 Gbps, or 100 Mbps if a bad cable dropped it) and the measured
round-trip to the gateway. A true LAN *throughput* figure needs a cooperating
server on the far end, so it is not invented — the link rate and gateway latency
are what a technician actually checks.

**Product keys** — recover this machine's *own* Windows and Office licences
before a reinstall (the ProduKey / Keyfinder job). Read-only. It shows the
BIOS/UEFI-embedded **OEM key** where the machine has one, and the installed
**retail key** decoded from the registry's `DigitalProductId`. That decode is
shown **only when its last five characters match the licence's own** (from
`SoftwareLicensingProduct`), so a wrong or placeholder key can never be
displayed — at worst none is. A digital licence tied to a Microsoft account is
reported as having no retrievable key. Office (Click-to-Run) exposes only the
last five characters, and that is all that is shown.

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
src/duplicates.js  three-pass duplicate detection
src/programs.js installed programs: list, measure, uninstall, force-remove
src/system.js   read-only hardware/OS spec sheet with drive SMART health
src/keys.js     own-machine Windows/Office product-key recovery
src/network.js  adapter info, DNS/IP fixes, live ping & traceroute
src/speedtest.js internet throughput (Cloudflare) + LAN link/latency
src/repair.js   SFC / DISM / chkdsk launcher with streamed output
src/events.js   event-log reader: stability timeline + deduped error feed
src/devices.js  device + driver inventory, problem devices flagged
src/monitor.js  live CPU/RAM/disk/net snapshot + top processes
src/battery.js  battery wear %, cycle count, live charge (WMI + powercfg)
src/autoruns.js persistence auditor: autostart surfaces, signature-flagged
src/security.js security posture: Defender/Firewall/BitLocker/UAC/accounts, graded
src/connections.js active TCP/UDP endpoints by process, signature-flagged
src/driverexport.js third-party driver list + Export-WindowsDriver backup
ui/             index.html, style.css, app.js, treemap.js
```

### Deliberately not included

- **Services, as a disk-cleanup target.** Disabling one to save space is
  pointless — the space saved is nil — and disabling the wrong one breaks a
  machine in ways that are hard to diagnose. Services *do* appear in the Autoruns
  tab, but as a persistence-audit control: signature-flagged, admin-gated, and
  reversible (it changes StartupType, it does not delete anything).
- **Hibernation file, page file and System Restore allocation.** These are often
  the biggest single items on a disk, but a standard user cannot even read their
  sizes, so the screen would mostly say "restart as administrator" — and the one
  large item that *is* readable, `C:\Windows\Installer`, must never be deleted,
  since it is what every uninstaller and repair reads from. Showing that number
  next to a delete button would do more harm than the feature is worth.
- **Browser history, cookies and saved logins.** Only caches are cleared; the
  things that sign you in and remember where you have been are left alone.

### Force remove

For a program whose own uninstaller is gone, crashes, or wants an installer
source that no longer exists. It is the most dangerous thing this app does, so
it is built so that it cannot destroy anything:

- **Quarantine, not deletion.** The install folder is *renamed* into a
  quarantine folder on the same volume. A rename is atomic — a folder with a file
  still in use either moves whole or not at all, never half — and it has no size
  limit. The Recycle Bin is deliberately not used here: Windows recycles "if
  possible, otherwise deletes", so a program folder too big for the bin would be
  gone for good.
- **The plan comes first.** Before anything moves you see the exact folder, its
  size and file count, the shortcuts pointing into it, and the Add/Remove
  Programs entry. The removal itself recomputes that plan rather than trusting
  the one you looked at.
- **One restore point covers the lot** — folder, shortcuts and registry entry.
  Space is only freed when you *Discard* it in Backups, and the button says how
  much. Restoring refuses if something has since been reinstalled in the same
  place, rather than overwriting a working install with an old copy.
- **Order matters.** The restore point is written first, listing every planned
  move, so a crash part way through still leaves a record. The folder moves
  next, being the step most likely to fail — and failing there changes nothing.
  The registry entry goes last; if that fails, everything is moved back. If
  something cannot be moved back, the restore point is *kept* pointing at it
  rather than thrown away.

It refuses, with the reason, when:

- the program was installed by **Windows Installer**. Removing its entry by hand
  leaves Windows Installer believing it is still there, which blocks reinstalling
  it; Microsoft's Program Install and Uninstall troubleshooter is the right tool;
- the folder is **shared** with anything else registered, in either direction —
  on the machine this was built on, that is what stopped Microsoft 365, Project
  and Visio, which all live in one `Microsoft Office` folder, from being removed
  one at a time and taking the others with them;
- the folder is, or contains, a **protected** location — drive roots, Windows,
  Program Files itself, ProgramData, the user profile and its known folders, or
  this app;
- any of its programs are **still running**;
- it was installed for all users and the app is not running **as administrator**.

Shortcuts are searched in the Start Menus and their subfolders, and at the top
level of the desktops only. Recursing a OneDrive-synced Desktop took six seconds
per click to find one extra shortcut inside a project folder, which was not a
program's anyway.

### Finding duplicates

Hashing every file would be unbearable, so candidates are narrowed in three
passes, each more expensive than the last and each run on far fewer files:

1. **group by exact size** — no reads at all, and it eliminates almost everything;
2. **hash the first 64 KB** — one short read, which separates same-size files
   that merely happen to collide on length;
3. **hash the whole file** — only ever runs on what survived both.

A partial hash alone is not proof, so pass 3 is not optional: two files can
share their first 64 KB and differ in the last byte, and the test suite has
exactly that pair in it.

Folders whose duplicates are meant to exist — `node_modules`, `.git`, `venv`,
`__pycache__` and friends — are skipped. Deleting a copy out of one of those
breaks whatever owns it, and a Documents folder full of code projects is mostly
made of them.

**A group can never lose every copy.** The UI refuses to tick the last one, and
the main process re-checks before deleting anything, so a stale selection cannot
get past it either. Copies go to the Recycle Bin like everything else here.
*Keep the original* selects by depth — the copy nearest the top of the tree is
usually the one you filed deliberately, and the deeper ones are what a backup
folder or a `(1)` download left behind.

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

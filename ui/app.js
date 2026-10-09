'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  admin: false,
  startup: { entries: [], tasks: [], search: '', showWindowsTasks: false, tasksLoaded: false },
  cleanup: { targets: [], selected: new Set(), scanned: false },
  files: { results: null, selected: new Set(), roots: [], mode: 'list' },
  map: { node: null, trail: [], selected: null, built: false, summary: null },
  registry: { groups: [], selected: new Set(), scanned: false },
  backups: { items: [] },
  programs: { items: [], search: '', sort: 'size', loaded: false },
  dupes: { groups: [], selected: new Set(), scanned: false, summary: null },
  system: { info: null, loaded: false },
  keys: { data: null, loaded: false },
  network: { info: null, actions: [], loaded: false, runId: null, speedRunning: false },
  repair: { commands: [], loaded: false, runId: null, runLabel: null },
  events: { data: null, loaded: false, search: '', filter: 'all' },
  devices: { data: null, loaded: false, search: '', openClasses: new Set(['Display', 'Net', 'DiskDrive']) },
  monitor: { active: false, built: false, timer: null, cpuHistory: [], memHistory: [] },
  autoruns: { data: null, ext: null, loaded: false, search: '', flaggedOnly: false, openGroups: new Set(['logon', 'ifeo', 'wmi']) },
  security: { data: null, loaded: false },
  battery: { data: null, loaded: false },
  connections: { data: null, loaded: false, search: '', publicOnly: false, openListen: false },
  drivers: { data: null, loaded: false, search: '', exporting: false },
  accounts: { data: null, loaded: false },
  toolbox: { data: null, loaded: false, search: '', running: null },
  disks: { data: null, loaded: false },
  wifi: { data: null, loaded: false, search: '', revealed: new Set() },
  ghosts: { data: null, loaded: false, selected: new Set(), openGroups: new Set(), busy: false },
  report: { data: null, loaded: false },
  hwtest: { built: false, micStream: null, camStream: null, audioCtx: null, micRaf: null, kbBound: false },
  explorer: { gallery: null, loaded: false, busy: false, dirty: false },
  bitlocker: { data: null, loaded: false, revealed: new Set(), busy: false },
  update: { config: null, loaded: false, result: null, status: '', busy: false, progress: null },
};

/* Helpers ------------------------------------------------------------------ */

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

function formatDate(ms) {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function toast(message, kind) {
  const node = document.createElement('div');
  node.className = `toast${kind ? ` is-${kind}` : ''}`;
  node.textContent = message;
  $('toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s ease';
    setTimeout(() => node.remove(), 220);
  }, kind === 'error' ? 6000 : 3500);
}

/**
 * A modal with Cancel and a confirm button. `alertOnly` drops the confirm
 * button and turns Cancel into OK, for explaining why something cannot be done.
 */
function confirmAction({ title, body, confirmLabel = 'Confirm', danger = true, alertOnly = false }) {
  return new Promise((resolve) => {
    const backdrop = $('modal');
    const confirm = $('modal-confirm');
    const cancel = $('modal-cancel');
    $('modal-title').textContent = title;
    $('modal-body').textContent = body;
    confirm.textContent = confirmLabel;
    confirm.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    confirm.hidden = alertOnly;
    cancel.textContent = alertOnly ? 'OK' : 'Cancel';
    backdrop.hidden = false;

    const finish = (answer) => {
      backdrop.hidden = true;
      confirm.hidden = false;
      cancel.textContent = 'Cancel';
      confirm.removeEventListener('click', onYes);
      $('modal-cancel').removeEventListener('click', onNo);
      backdrop.removeEventListener('click', onBackdrop);
      resolve(answer);
    };
    const onYes = () => finish(true);
    const onNo = () => finish(false);
    const onBackdrop = (event) => {
      if (event.target === backdrop) finish(false);
    };

    confirm.addEventListener('click', onYes);
    $('modal-cancel').addEventListener('click', onNo);
    backdrop.addEventListener('click', onBackdrop);
  });
}

function empty(message) {
  const node = document.createElement('div');
  node.className = 'empty';
  node.textContent = message;
  return node;
}

/* Navigation --------------------------------------------------------------- */

function show(view) {
  for (const button of document.querySelectorAll('.nav-item')) {
    button.classList.toggle('is-active', button.dataset.view === view);
  }
  for (const section of document.querySelectorAll('.view')) {
    section.classList.toggle('is-active', section.id === `view-${view}`);
  }
  document.querySelector('.content').scrollTop = 0;

  if (view === 'startup' && !state.startup.entries.length) loadStartup();
  if (view === 'files' && !state.files.roots.length) loadRoots();
  if (view === 'programs' && !state.programs.loaded) loadPrograms();
  if (view === 'system' && !state.system.loaded) loadSystem();
  if (view === 'devices' && !state.devices.loaded) loadDevices();
  if (view === 'monitor') startMonitor();
  else stopMonitor();
  if (view === 'keys' && !state.keys.loaded) loadKeys();
  if (view === 'network' && !state.network.loaded) loadNetwork();
  if (view === 'repair' && !state.repair.loaded) loadRepair();
  if (view === 'events' && !state.events.loaded) loadEvents();
  if (view === 'autoruns' && !state.autoruns.loaded) loadAutoruns();
  if (view === 'security' && !state.security.loaded) loadSecurity();
  if (view === 'battery' && !state.battery.loaded) loadBattery();
  if (view === 'connections' && !state.connections.loaded) loadConnections();
  if (view === 'drivers' && !state.drivers.loaded) loadDrivers();
  if (view === 'accounts' && !state.accounts.loaded) loadAccounts();
  if (view === 'toolbox' && !state.toolbox.loaded) loadToolbox();
  if (view === 'disks' && !state.disks.loaded) loadDisks();
  if (view === 'wifi' && !state.wifi.loaded) loadWifi();
  if (view === 'ghosts' && !state.ghosts.loaded) loadGhosts();
  if (view === 'report' && !state.report.loaded) loadReport();
  if (view === 'explorer' && !state.explorer.loaded) loadExplorer();
  if (view === 'bitlocker' && !state.bitlocker.loaded) loadBitlocker();
  if (view === 'update' && !state.update.loaded) loadUpdate();
  if (view === 'hwtest') initHwtest();
  else stopHwtest();
  if (view === 'backups') loadBackups();
}

document.querySelector('#nav').addEventListener('click', (event) => {
  const button = event.target.closest('.nav-item');
  if (button) show(button.dataset.view);
});

for (const tile of document.querySelectorAll('.tile')) {
  tile.addEventListener('click', () => show(tile.dataset.goto));
}

/* Overview ----------------------------------------------------------------- */

async function loadOverview() {
  try {
    const info = await window.pc.overview();
    state.admin = info.admin;

    $('overview-subtitle').textContent = `${info.os} · signed in as ${info.user.split('\\').pop()}`;

    const card = $('admin-card');
    card.classList.toggle('is-admin', info.admin);
    $('admin-state').textContent = info.admin
      ? 'Running as administrator'
      : 'Running as a standard user. System-wide items are read-only.';
    $('elevate').hidden = info.admin;

    // Built with DOM calls rather than innerHTML: the page's CSP forbids inline
    // style attributes, so the meter width has to be set through the CSSOM.
    const disks = $('disks');
    disks.replaceChildren();
    for (const disk of info.disks) {
      const used = disk.size - disk.free;
      const percent = disk.size > 0 ? (used / disk.size) * 100 : 0;

      const node = document.createElement('div');
      node.className = 'disk';

      const top = document.createElement('div');
      top.className = 'disk-top';

      const name = document.createElement('div');
      name.className = 'disk-name';
      name.append(document.createTextNode(disk.drive));
      const label = document.createElement('span');
      label.textContent = disk.label || 'Local disk';
      name.append(label);

      const free = document.createElement('div');
      free.className = 'disk-free';
      free.textContent = `${formatBytes(disk.free)} free of ${formatBytes(disk.size)}`;
      top.append(name, free);

      const meter = document.createElement('div');
      meter.className = 'meter';
      const fill = document.createElement('div');
      fill.className = `meter-fill${percent > 92 ? ' is-full' : percent > 80 ? ' is-tight' : ''}`;
      fill.style.width = `${percent.toFixed(1)}%`;
      meter.append(fill);

      node.append(top, meter);
      disks.append(node);
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

$('overview-refresh').addEventListener('click', loadOverview);

$('elevate').addEventListener('click', async () => {
  try {
    await window.pc.elevate();
  } catch (error) {
    toast(`Could not restart as administrator: ${error.message}`, 'error');
  }
});

/* Startup ------------------------------------------------------------------ */

function startupRow(entry) {
  const row = document.createElement('div');
  row.className = `row${entry.enabled ? '' : ' is-off'}`;

  const icon = document.createElement('img');
  icon.className = 'row-icon';
  icon.alt = '';
  if (entry.icon) icon.src = entry.icon;

  const main = document.createElement('div');
  main.className = 'row-main';
  const name = document.createElement('div');
  name.className = 'row-name';
  name.textContent = entry.product || entry.name;
  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.textContent = [entry.publisher || 'Unknown publisher', entry.location, entry.command]
    .filter(Boolean)
    .join('  ·  ');
  meta.title = entry.command;
  main.append(name, meta);

  const tags = document.createElement('div');
  tags.className = 'row-tags';
  if (entry.missing) {
    const tag = document.createElement('span');
    tag.className = 'tag tag-danger';
    tag.textContent = 'File missing';
    tag.title = 'The program this points at no longer exists — this entry does nothing.';
    tags.append(tag);
  }
  if (!entry.publisher && !entry.missing) {
    const tag = document.createElement('span');
    tag.className = 'tag tag-warn';
    tag.textContent = 'Unsigned';
    tag.title = 'No publisher information — worth checking what this is.';
    tags.append(tag);
  }
  if (entry.scope === 'machine') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'All users';
    tags.append(tag);
  }

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const reveal = document.createElement('button');
  reveal.className = 'btn btn-ghost btn-small';
  reveal.textContent = 'Show file';
  reveal.addEventListener('click', () => {
    window.pc.startup.reveal(entry.id).catch((error) => toast(error.message, 'error'));
  });

  const remove = document.createElement('button');
  remove.className = 'btn btn-ghost btn-small';
  remove.textContent = 'Delete';
  remove.title = 'Delete this entry entirely, rather than just switching it off';
  remove.disabled = entry.scope === 'machine' && !state.admin;
  remove.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: `Delete “${entry.product || entry.name}”?`,
      body:
        entry.kind === 'folder'
          ? 'The shortcut is moved to the Recycle Bin, so you can put it back. Switching it off instead does the same job and is easier to undo.'
          : 'The registry entry is saved to a restore point first, so you can bring it back from the Backups tab. Switching it off instead does the same job without removing anything.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      const result = await window.pc.startup.remove(entry.id);
      const where =
        result && result.recoverable === 'recycle-bin'
          ? ' Shortcut is in the Recycle Bin.'
          : result && result.recoverable === 'backup'
            ? ' A restore point was saved in Backups.'
            : '';
      toast(`Deleted ${entry.product || entry.name}.${where}`, 'good');
      loadStartup();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  const label = document.createElement('label');
  label.className = 'switch';
  label.title = entry.approvable ? 'Run at startup' : 'Run-once entries cannot be disabled';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = entry.enabled;
  input.disabled = !entry.approvable || (entry.scope === 'machine' && !state.admin);
  if (entry.scope === 'machine' && !state.admin) {
    label.title = 'Restart as administrator to change items that apply to all users.';
  }
  const track = document.createElement('span');
  track.className = 'switch-track';
  label.append(input, track);

  input.addEventListener('change', async () => {
    const wanted = input.checked;
    input.disabled = true;
    try {
      await window.pc.startup.setEnabled(entry.id, wanted);
      entry.enabled = wanted;
      row.classList.toggle('is-off', !wanted);
      toast(`${entry.product || entry.name} ${wanted ? 'enabled' : 'disabled'} at startup.`, 'good');
      updateStartupCounts();
    } catch (error) {
      input.checked = !wanted;
      toast(error.message, 'error');
    } finally {
      input.disabled = false;
    }
  });

  actions.append(reveal, remove, label);
  row.append(icon, main, tags, actions);
  return row;
}

function taskRow(task) {
  const row = document.createElement('div');
  row.className = `row${task.enabled ? '' : ' is-off'}`;

  const main = document.createElement('div');
  main.className = 'row-main';
  const name = document.createElement('div');
  name.className = 'row-name';
  name.textContent = task.name;
  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.textContent = [task.author, task.command, task.taskPath].filter(Boolean).join('  ·  ');
  meta.title = task.description || task.command;
  main.append(name, meta);

  const tags = document.createElement('div');
  tags.className = 'row-tags';
  if (task.builtIn) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'Windows';
    tags.append(tag);
  }

  const label = document.createElement('label');
  label.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = task.enabled;
  input.disabled = !state.admin;
  label.title = state.admin ? 'Run at sign-in' : 'Restart as administrator to change scheduled tasks.';
  const track = document.createElement('span');
  track.className = 'switch-track';
  label.append(input, track);

  input.addEventListener('change', async () => {
    const wanted = input.checked;
    input.disabled = true;
    try {
      await window.pc.startup.setTaskEnabled(task.taskPath, task.name, wanted);
      task.enabled = wanted;
      row.classList.toggle('is-off', !wanted);
      toast(`Task “${task.name}” ${wanted ? 'enabled' : 'disabled'}.`, 'good');
    } catch (error) {
      input.checked = !wanted;
      toast(error.message, 'error');
    } finally {
      input.disabled = false;
    }
  });

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.append(label);

  row.append(main, tags, actions);
  return row;
}

function updateStartupCounts() {
  const enabled = state.startup.entries.filter((entry) => entry.enabled).length;
  $('nav-startup-count').textContent = String(state.startup.entries.length || '');
  $('tile-startup').textContent = String(enabled);
  const disabled = state.startup.entries.length - enabled;
  $('tile-startup-note').textContent = disabled
    ? `${disabled} already disabled`
    : 'Tap to review them';
}

function renderStartup() {
  const term = state.startup.search.trim().toLowerCase();
  const list = $('startup-list');
  list.replaceChildren();

  const matches = state.startup.entries.filter((entry) => {
    if (!term) return true;
    return [entry.name, entry.product, entry.publisher, entry.command].join(' ').toLowerCase().includes(term);
  });

  if (!matches.length) {
    list.append(empty(term ? 'Nothing matches that search.' : 'No startup programs found.'));
  } else {
    for (const entry of matches) list.append(startupRow(entry));
  }

  const tasks = $('tasks-list');
  tasks.replaceChildren();
  if (!state.startup.tasksLoaded) {
    tasks.append(empty('Reading scheduled tasks…'));
  } else {
    const visible = state.startup.tasks
      .filter((task) => state.startup.showWindowsTasks || !task.builtIn)
      .filter((task) => !term || [task.name, task.author, task.command].join(' ').toLowerCase().includes(term));

    if (!visible.length) {
      tasks.append(empty('No sign-in tasks to show.'));
    } else {
      for (const task of visible) tasks.append(taskRow(task));
    }
  }

  const enabled = state.startup.entries.filter((entry) => entry.enabled).length;
  $('startup-subtitle').textContent =
    `${enabled} of ${state.startup.entries.length} enabled` +
    (state.startup.tasksLoaded
      ? ` · ${state.startup.tasks.filter((task) => !task.builtIn).length} third-party sign-in tasks`
      : '');
  updateStartupCounts();
}

async function loadStartup() {
  $('startup-list').replaceChildren(empty('Reading startup entries…'));
  $('tasks-list').replaceChildren(empty('Reading scheduled tasks…'));
  state.startup.tasksLoaded = false;

  try {
    const data = await window.pc.startup.list();
    state.startup.entries = data.entries;
    renderStartup();
  } catch (error) {
    $('startup-list').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }

  // Enumerating scheduled tasks takes over a second, so it fills in afterwards
  // rather than holding up the list above it.
  try {
    state.startup.tasks = await window.pc.startup.tasks();
    state.startup.tasksLoaded = true;
    renderStartup();
  } catch {
    state.startup.tasksLoaded = true;
    $('tasks-list').replaceChildren(empty('Could not read scheduled tasks.'));
  }
}

$('startup-refresh').addEventListener('click', loadStartup);
$('startup-search').addEventListener('input', (event) => {
  state.startup.search = event.target.value;
  renderStartup();
});
$('tasks-show-windows').addEventListener('change', (event) => {
  state.startup.showWindowsTasks = event.target.checked;
  renderStartup();
});

/* Cleanup ------------------------------------------------------------------ */

function updateCleanupSelection() {
  const chosen = state.cleanup.targets.filter((target) => state.cleanup.selected.has(target.id));
  const bytes = chosen.reduce((sum, target) => sum + target.bytes, 0);
  const bar = $('cleanup-selection');

  bar.hidden = chosen.length === 0;
  $('cleanup-selection-text').textContent = `${chosen.length} selected · ${formatBytes(bytes)} to remove`;
  $('cleanup-run').disabled = chosen.length === 0;
}

function renderCleanup() {
  const container = $('cleanup-groups');
  container.replaceChildren();

  const groups = new Map();
  for (const target of state.cleanup.targets) {
    if (!groups.has(target.group)) groups.set(target.group, []);
    groups.get(target.group).push(target);
  }

  for (const [group, targets] of groups) {
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = group;
    container.append(title);

    const list = document.createElement('div');
    list.className = 'list';

    for (const target of targets) {
      const row = document.createElement('label');
      row.className = `clean-row${target.bytes === 0 ? ' is-empty' : ''}`;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = state.cleanup.selected.has(target.id);
      input.disabled = target.bytes === 0 || (target.needsAdmin && !state.admin);
      input.addEventListener('change', () => {
        if (input.checked) state.cleanup.selected.add(target.id);
        else state.cleanup.selected.delete(target.id);
        updateCleanupSelection();
      });

      const body = document.createElement('div');
      body.className = 'clean-body';

      const name = document.createElement('div');
      name.className = 'clean-name';
      name.append(document.createTextNode(target.label));
      if (target.needsAdmin && !state.admin) {
        const tag = document.createElement('span');
        tag.className = 'tag tag-warn';
        tag.textContent = 'Needs administrator';
        name.append(tag);
      }
      if (target.warn) {
        const tag = document.createElement('span');
        tag.className = 'tag tag-danger';
        tag.textContent = 'Permanent';
        name.append(tag);
      }

      const desc = document.createElement('div');
      desc.className = 'clean-desc';
      desc.textContent = target.description;

      const safety = document.createElement('div');
      safety.className = 'clean-safety';
      safety.textContent = target.safety;

      body.append(name, desc, safety);

      const size = document.createElement('div');
      size.className = 'clean-size';
      size.textContent = target.bytes ? formatBytes(target.bytes) : '—';
      if (target.files) {
        const files = document.createElement('small');
        files.textContent = `${target.files.toLocaleString('en-GB')} files`;
        size.append(files);
      }

      row.append(input, body, size);
      list.append(row);
    }

    container.append(list);
  }

  const total = state.cleanup.targets.reduce((sum, target) => sum + target.bytes, 0);
  $('cleanup-subtitle').textContent = `${formatBytes(total)} can be reclaimed across ${
    state.cleanup.targets.filter((target) => target.bytes > 0).length
  } locations.`;
  $('nav-cleanup-count').textContent = total ? formatBytes(total) : '';
  $('tile-cleanup').textContent = formatBytes(total);
  $('tile-cleanup-note').textContent = 'Reviewed and ready to clean';
  updateCleanupSelection();
}

window.pc.clean.onProgress(({ index, total, label }) => {
  const percent = total ? (index / total) * 100 : 0;
  $('cleanup-progress-fill').style.width = `${percent}%`;
  $('cleanup-progress-label').textContent = label === 'Done' ? 'Finishing…' : `Checking ${label}…`;
});

async function scanCleanup() {
  $('cleanup-scan').disabled = true;
  $('cleanup-run').disabled = true;
  $('cleanup-progress').hidden = false;
  $('cleanup-groups').replaceChildren();
  try {
    state.cleanup.targets = await window.pc.clean.scan();
    state.cleanup.scanned = true;
    state.cleanup.selected.clear();
    renderCleanup();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    $('cleanup-progress').hidden = true;
    $('cleanup-scan').disabled = false;
  }
}

$('cleanup-scan').addEventListener('click', scanCleanup);

$('cleanup-select-safe').addEventListener('click', () => {
  state.cleanup.selected.clear();
  for (const target of state.cleanup.targets) {
    const blocked = target.needsAdmin && !state.admin;
    if (target.bytes > 0 && !target.warn && !blocked) state.cleanup.selected.add(target.id);
  }
  renderCleanup();
});

$('cleanup-select-none').addEventListener('click', () => {
  state.cleanup.selected.clear();
  renderCleanup();
});

$('cleanup-run').addEventListener('click', async () => {
  const chosen = state.cleanup.targets.filter((target) => state.cleanup.selected.has(target.id));
  if (!chosen.length) return;
  const bytes = chosen.reduce((sum, target) => sum + target.bytes, 0);
  const hasPermanent = chosen.some((target) => target.warn);

  const ok = await confirmAction({
    title: `Clean ${formatBytes(bytes)}?`,
    body: `${chosen.map((target) => target.label).join(', ')}. Files in use will be skipped.${
      hasPermanent ? ' The Recycle Bin is included — that part cannot be undone.' : ''
    }`,
    confirmLabel: 'Clean now',
    danger: hasPermanent,
  });
  if (!ok) return;

  $('cleanup-run').disabled = true;
  $('cleanup-scan').disabled = true;
  $('cleanup-progress').hidden = false;
  try {
    const report = await window.pc.clean.run([...state.cleanup.selected]);
    toast(
      `Freed ${formatBytes(report.bytes)} from ${report.files.toLocaleString('en-GB')} files${
        report.skipped ? ` · ${report.skipped} in use and skipped` : ''
      }.`,
      'good'
    );
    await scanCleanup();
    loadOverview();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    $('cleanup-progress').hidden = true;
    $('cleanup-scan').disabled = false;
  }
});

/* Large files -------------------------------------------------------------- */

async function loadRoots() {
  try {
    state.files.roots = await window.pc.files.roots();
  } catch {
    state.files.roots = [];
  }
  // The same folder list drives the Large files tab and the Duplicates tab,
  // but each keeps its own checkboxes so one does not surprise the other.
  const fill = (container, onChange) => {
    container.replaceChildren();
    for (const root of state.files.roots) {
      const label = document.createElement('label');
      label.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = root.id;
      input.checked = root.default;
      if (onChange) input.addEventListener('change', onChange);
      const text = document.createElement('span');
      text.textContent = root.label;
      label.append(input, text);
      container.append(label);
    }
  };

  fill($('files-roots'), () => {
    // A map built from different folders is stale; ask for a rebuild rather
    // than leaving a picture that no longer matches the checkboxes.
    if (state.map.built) invalidateMap('Folders changed — rebuild the map to match.');
  });
  fill($('dupes-roots'), () => {
    if (state.dupes.scanned) invalidateDupes('Folders changed — scan again to match.');
  });
}

function updateFilesSelection() {
  const chosen = [...state.files.selected];
  const bytes = (state.files.results?.files || [])
    .filter((file) => state.files.selected.has(file.path))
    .reduce((sum, file) => sum + file.bytes, 0);

  // The list's checkbox selection is meaningless while the map is showing.
  $('files-selection').hidden = chosen.length === 0 || state.files.mode === 'map';
  $('files-selection-text').textContent = `${chosen.length} selected · ${formatBytes(bytes)}`;
  $('files-trash').disabled = chosen.length === 0;
}

function renderFiles() {
  const list = $('files-list');
  list.replaceChildren();
  const results = state.files.results;

  if (!results) {
    list.append(empty('Choose your filters, then press Scan.'));
    return;
  }
  if (!results.files.length) {
    list.append(empty('Nothing matched — no large or forgotten files in those folders.'));
    $('tile-files').textContent = '0 B';
    return;
  }

  for (const file of results.files) {
    const row = document.createElement('div');
    row.className = 'row';

    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state.files.selected.has(file.path);
    input.addEventListener('change', () => {
      if (input.checked) state.files.selected.add(file.path);
      else state.files.selected.delete(file.path);
      updateFilesSelection();
    });
    label.append(input);

    const main = document.createElement('div');
    main.className = 'row-main';
    const name = document.createElement('div');
    name.className = 'row-name';
    name.textContent = file.name;
    const meta = document.createElement('div');
    meta.className = 'row-meta';
    meta.textContent = `${file.folder}  ·  last used ${formatDate(file.lastUsed)}`;
    meta.title = file.path;
    main.append(name, meta);

    const size = document.createElement('div');
    size.className = 'row-size';
    size.textContent = formatBytes(file.bytes);

    const reveal = document.createElement('button');
    reveal.className = 'btn btn-ghost btn-small';
    reveal.textContent = 'Show';
    reveal.addEventListener('click', () => {
      window.pc.files.reveal(file.path).catch((error) => toast(error.message, 'error'));
    });

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(size, reveal);

    row.append(label, main, actions);
    list.append(row);
  }

  $('tile-files').textContent = formatBytes(results.totalBytes);
  $('tile-files-note').textContent = `${results.total.toLocaleString('en-GB')} files matched${
    results.truncated ? ' (showing the biggest)' : ''
  }`;
  updateFilesSelection();
}

$('files-scan').addEventListener('click', async () => {
  const rootIds = [...$('files-roots').querySelectorAll('input:checked')].map((input) => input.value);
  if (!rootIds.length) {
    toast('Pick at least one folder to scan.', 'error');
    return;
  }

  $('files-scan').disabled = true;
  const status = empty('Scanning…');
  $('files-list').replaceChildren(status);
  const stopProgress = window.pc.files.onProgress(({ seen, matched }) => {
    status.textContent = `Scanning… ${seen.toLocaleString('en-GB')} files checked, ${matched} match${
      matched === 1 ? '' : 'es'
    } so far`;
  });
  try {
    state.files.results = await window.pc.files.scan({ rootIds, ...currentFilters() });
    state.files.selected.clear();
    renderFiles();
  } catch (error) {
    $('files-list').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  } finally {
    stopProgress();
    $('files-scan').disabled = false;
  }
});

$('files-select-none').addEventListener('click', () => {
  state.files.selected.clear();
  renderFiles();
});

$('files-trash').addEventListener('click', async () => {
  const paths = [...state.files.selected];
  if (!paths.length) return;

  const ok = await confirmAction({
    title: `Move ${paths.length} file${paths.length === 1 ? '' : 's'} to the Recycle Bin?`,
    body: 'They stay in the Recycle Bin until you empty it, so you can put them back if you change your mind.',
    confirmLabel: 'Move to Recycle Bin',
    danger: false,
  });
  if (!ok) return;

  $('files-trash').disabled = true;
  try {
    const result = await window.pc.files.trash(paths);
    toast(
      `Moved ${result.moved.length} file${result.moved.length === 1 ? '' : 's'} to the Recycle Bin${
        result.failed.length ? ` · ${result.failed.length} could not be moved` : ''
      }.`,
      result.failed.length ? 'error' : 'good'
    );
    if (state.files.results) {
      const removed = new Set(result.moved.map((p) => p.toLowerCase()));
      state.files.results.files = state.files.results.files.filter(
        (file) => !removed.has(file.path.toLowerCase())
      );
      state.files.results.totalBytes = state.files.results.files.reduce((sum, f) => sum + f.bytes, 0);
      state.files.results.total = state.files.results.files.length;
    }
    state.files.selected.clear();
    renderFiles();
    loadOverview();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    $('files-trash').disabled = false;
  }
});

/* Treemap ------------------------------------------------------------------ */

let treemap = null;

function chosenRootIds() {
  return [...$('files-roots').querySelectorAll('input:checked')].map((input) => input.value);
}

// Only the view root and its immediate children arrive with a full path — the
// rest are rebuilt here by joining names on the way down, which keeps the
// payload from repeating the same long prefix thousands of times.
function hydratePaths(node) {
  for (const child of node.children || []) {
    if (!child.path && !child.aggregate && node.path) {
      child.path = `${node.path}\\${child.name}`;
    }
    hydratePaths(child);
  }
  return node;
}

function renderLegend() {
  const legend = $('map-legend');
  if (legend.childElementCount) return;
  for (const type of [...window.Treemap.TYPES, window.Treemap.OTHER]) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = type.color;
    const label = document.createElement('span');
    label.textContent = type.label;
    item.append(swatch, label);
    legend.append(item);
  }
}

function renderCrumbs() {
  const crumbs = $('map-crumbs');
  crumbs.replaceChildren();

  state.map.trail.forEach((crumb, index) => {
    if (index) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      crumbs.append(sep);
    }
    const last = index === state.map.trail.length - 1;
    const button = document.createElement('button');
    button.className = `crumb${last ? ' is-current' : ''}`;
    button.textContent = `${crumb.name} · ${formatBytes(crumb.bytes)}`;
    if (!last) button.addEventListener('click', () => zoomTo(crumb.path));
    crumbs.append(button);
  });

  $('map-up').disabled = state.map.trail.length < 2;
}

function setMapSelection(node) {
  state.map.selected = node;
  const label = $('map-selected');

  if (!node) {
    label.textContent = 'Click a tile to select it · double-click a folder to zoom in';
    $('map-reveal').disabled = true;
    $('map-trash').disabled = true;
    return;
  }

  label.replaceChildren();
  const name = document.createElement('strong');
  name.textContent = node.name;
  label.append(name, document.createTextNode(` — ${formatBytes(node.bytes)}`));
  if (node.dir) label.append(document.createTextNode(` in ${node.files.toLocaleString('en-GB')} files`));

  $('map-reveal').disabled = false;
  // Only individual files can be sent to the Recycle Bin from here; removing a
  // whole folder in one click is too easy to do by accident.
  $('map-trash').disabled = node.dir || node.aggregate;
}

async function zoomTo(target) {
  try {
    const result = await window.pc.map.node(target);
    hydratePaths(result.node);
    state.map.node = result.node;
    state.map.trail = result.trail;
    treemap.setRoot(result.node);
    setMapSelection(null);
    renderCrumbs();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function ensureTreemap() {
  if (treemap) return treemap;

  // The tooltip waits a second before appearing, so sweeping across the map
  // does not fill it with flashing panels, and only shows once you have settled
  // on something.
  const tipState = { node: null, timer: null, x: 0, y: 0 };

  function placeTip() {
    const tip = $('map-tip');
    const frame = $('map-canvas').getBoundingClientRect();
    const rect = tip.getBoundingClientRect();
    let x = tipState.x - frame.left + 16;
    let y = tipState.y - frame.top + 20;
    if (x + rect.width > frame.width) x = frame.width - rect.width - 6;
    if (y + rect.height > frame.height) y = tipState.y - frame.top - rect.height - 12;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
  }

  function showTip(node) {
    const tip = $('map-tip');
    tip.replaceChildren();
    const name = document.createElement('strong');
    name.textContent = node.name;
    const detail = document.createElement('span');
    const share =
      state.map.node && state.map.node.bytes
        ? ` · ${((node.bytes / state.map.node.bytes) * 100).toFixed(1)}% of this folder`
        : '';
    detail.textContent = node.dir
      ? `Folder · ${formatBytes(node.bytes)} · ${node.files.toLocaleString('en-GB')} files${share}`
      : `${formatBytes(node.bytes)}${share}`;
    tip.append(name, detail);
    tip.hidden = false;
    placeTip();
  }

  function hideTip() {
    clearTimeout(tipState.timer);
    tipState.timer = null;
    tipState.node = null;
    $('map-tip').hidden = true;
  }

  treemap = new window.Treemap.Treemap($('map-canvas'), {
    onHover: (node, event) => {
      if (!node || !event) {
        hideTip();
        return;
      }

      tipState.x = event.clientX;
      tipState.y = event.clientY;

      if (node === tipState.node) {
        // Same tile — keep following the cursor if it is already showing.
        if (!$('map-tip').hidden) placeTip();
        return;
      }

      // Moved onto a different tile: hide immediately and start the wait again.
      clearTimeout(tipState.timer);
      $('map-tip').hidden = true;
      tipState.node = node;
      tipState.timer = setTimeout(() => showTip(node), 1000);
    },
    onSelect: (node) => setMapSelection(node),
    onZoom: (node) => zoomTo(node.path),
  });

  // The canvas has no size while the view is hidden, so re-lay out when it
  // becomes visible or the window changes shape.
  const observer = new ResizeObserver(() => treemap.layout());
  observer.observe($('map-canvas').parentElement);

  return treemap;
}

// The two filter controls, shared by the list and the map so both mean the
// same thing.
function currentFilters() {
  return {
    minBytes: Number($('files-min').value) * 1024 * 1024,
    olderThanDays: Number($('files-age').value),
  };
}

function filterSummary() {
  const minMb = Number($('files-min').value);
  const days = Number($('files-age').value);
  const parts = [];
  parts.push(minMb > 0 ? `over ${minMb >= 1024 ? `${minMb / 1024} GB` : `${minMb} MB`}` : 'any size');
  if (days > 0) parts.push(`untouched ${days >= 365 ? '1 year' : `${days} days`}`);
  return parts.join(' · ');
}

function renderMapSummary() {
  const summary = state.map.summary;
  const node = $('map-summary');
  if (!summary) {
    node.textContent = '';
    return;
  }
  node.textContent =
    `Showing files ${filterSummary()} — ` +
    `${summary.matchedFiles.toLocaleString('en-GB')} of ${summary.scannedFiles.toLocaleString('en-GB')} files`;
}

function invalidateMap(message) {
  state.map.built = false;
  state.map.node = null;
  state.map.trail = [];
  setMapSelection(null);
  $('map-crumbs').replaceChildren();
  $('map-up').disabled = true;

  const overlay = $('map-overlay');
  overlay.replaceChildren();
  const text = document.createElement('p');
  text.textContent = message;
  const button = document.createElement('button');
  button.className = 'btn btn-primary';
  button.textContent = 'Build the map';
  button.addEventListener('click', buildMap);
  overlay.append(text, button);
  overlay.hidden = false;
}

async function buildMap() {
  const rootIds = chosenRootIds();
  if (!rootIds.length) {
    toast('Pick at least one folder to map.', 'error');
    return;
  }

  const overlay = $('map-overlay');
  overlay.hidden = false;
  overlay.replaceChildren();
  const status = document.createElement('p');
  status.textContent = 'Measuring…';
  overlay.append(status);

  const stopProgress = window.pc.map.onProgress(({ seen, matched }) => {
    status.textContent = `Measuring… ${seen.toLocaleString('en-GB')} files checked, ${matched.toLocaleString(
      'en-GB'
    )} match the filters`;
  });

  try {
    const filters = currentFilters();
    const result = await window.pc.map.scan({ rootIds, ...filters });
    hydratePaths(result.root);
    state.map.node = result.root;
    state.map.built = true;
    state.map.summary = result;
    const trailResult = await window.pc.map.node(result.root.path);
    state.map.trail = trailResult.trail;

    ensureTreemap();
    renderLegend();
    overlay.hidden = true;
    treemap.setRoot(result.root);
    renderCrumbs();
    renderMapSummary();
    setMapSelection(null);

    if (!result.totalBytes) {
      invalidateMap('No files matched those filters. Try a smaller minimum size.');
      return;
    }

    toast(
      `Mapped ${formatBytes(result.totalBytes)} across ${result.totalFiles.toLocaleString('en-GB')} files.`,
      'good'
    );
  } catch (error) {
    overlay.replaceChildren();
    const message = document.createElement('p');
    message.textContent = error.message;
    const retry = document.createElement('button');
    retry.className = 'btn btn-primary';
    retry.textContent = 'Try again';
    retry.addEventListener('click', buildMap);
    overlay.append(message, retry);
    overlay.hidden = false;
  } finally {
    stopProgress();
  }
}

function setFilesMode(mode) {
  state.files.mode = mode;
  for (const button of $('files-mode').querySelectorAll('.segment')) {
    button.classList.toggle('is-active', button.dataset.mode === mode);
  }

  const isMap = mode === 'map';
  $('files-map').hidden = !isMap;
  $('files-list').hidden = isMap;
  $('files-scan').hidden = isMap;
  $('files-trash').hidden = isMap;
  $('files-selection').hidden = isMap || state.files.selected.size === 0;

  if (isMap) {
    ensureTreemap();
    renderLegend();
    // Lay out now that the canvas actually has a size on screen.
    requestAnimationFrame(() => treemap.layout());
  }
}

$('files-mode').addEventListener('click', (event) => {
  const button = event.target.closest('.segment');
  if (button) setFilesMode(button.dataset.mode);
});

$('map-scan').addEventListener('click', buildMap);
$('map-rebuild').addEventListener('click', buildMap);

// The size and age filters drive the map as well as the list, so changing one
// makes an existing map stale.
for (const id of ['files-min', 'files-age']) {
  $(id).addEventListener('change', () => {
    if (state.map.built) invalidateMap('Filters changed — rebuild the map to match.');
  });
}

$('map-up').addEventListener('click', () => {
  if (state.map.trail.length < 2) return;
  zoomTo(state.map.trail[state.map.trail.length - 2].path);
});

$('map-reveal').addEventListener('click', () => {
  if (!state.map.selected) return;
  window.pc.files.reveal(state.map.selected.path).catch((error) => toast(error.message, 'error'));
});

$('map-trash').addEventListener('click', async () => {
  const node = state.map.selected;
  if (!node || node.dir || node.aggregate) return;

  const ok = await confirmAction({
    title: `Move “${node.name}” to the Recycle Bin?`,
    body: `${formatBytes(node.bytes)}. It stays in the Recycle Bin until you empty it, so you can put it back.`,
    confirmLabel: 'Move to Recycle Bin',
    danger: false,
  });
  if (!ok) return;

  try {
    const result = await window.pc.files.trash([node.path]);
    if (result.moved.length) {
      toast(`Moved ${node.name} to the Recycle Bin. Rebuild the map to see the change.`, 'good');
      setMapSelection(null);
    } else {
      toast((result.failed[0] && result.failed[0].error) || 'Could not move that file.', 'error');
    }
  } catch (error) {
    toast(error.message, 'error');
  }
});

/* System info -------------------------------------------------------------- */

function formatUptime(ms) {
  if (!ms || ms < 0) return null;
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatDay(iso) {
  if (!iso) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function specCard({ title, hero, sub, rows, wide }) {
  const card = document.createElement('div');
  card.className = `spec-card${wide ? ' wide' : ''}`;
  if (title) {
    const h = document.createElement('h3');
    h.textContent = title;
    card.append(h);
  }
  if (hero) {
    const el = document.createElement('div');
    el.className = 'spec-hero';
    el.textContent = hero;
    card.append(el);
  }
  if (sub) {
    const el = document.createElement('div');
    el.className = 'spec-sub';
    el.textContent = sub;
    card.append(el);
  }
  for (const [k, v] of rows || []) {
    if (v == null || v === '') continue;
    const row = document.createElement('div');
    row.className = 'spec-row';
    const kEl = document.createElement('span');
    kEl.className = 'k';
    kEl.textContent = k;
    const vEl = document.createElement('span');
    vEl.className = 'v';
    vEl.textContent = v;
    row.append(kEl, vEl);
    card.append(row);
  }
  return card;
}

function healthClass(health) {
  const h = String(health || '').toLowerCase();
  if (h === 'healthy') return 'ok';
  if (h === 'warning') return 'warn';
  return 'bad';
}

function driveCard(disk) {
  const card = document.createElement('div');
  card.className = 'drive';

  const top = document.createElement('div');
  top.className = 'drive-top';
  const name = document.createElement('div');
  name.className = 'drive-name';
  name.textContent = disk.name;
  const pill = document.createElement('span');
  pill.className = `health-pill ${healthClass(disk.health)}`;
  pill.textContent = disk.health || 'Unknown';
  top.append(name, pill);
  card.append(top);

  // For an SSD that reports wear, show life remaining as a meter.
  if (disk.wear != null) {
    const meter = document.createElement('div');
    meter.className = 'drive-meter';
    const fill = document.createElement('div');
    fill.className = 'drive-meter-fill';
    const remaining = Math.max(0, 100 - disk.wear);
    fill.style.width = `${remaining}%`;
    if (remaining < 20) fill.style.background = 'var(--danger)';
    else if (remaining < 50) fill.style.background = 'var(--warn)';
    meter.append(fill);
    card.append(meter);
  }

  const stats = document.createElement('div');
  stats.className = 'drive-stats';
  const parts = [
    ['Capacity', formatBytes(disk.size)],
    ['Type', [disk.media, disk.bus].filter(Boolean).join(' · ') || null],
    ['Spin', disk.spindleSpeed ? `${disk.spindleSpeed.toLocaleString('en-GB')} rpm` : disk.media === 'SSD' ? 'Solid state' : null],
    ['Temp', disk.temperature != null ? `${disk.temperature}°C` : null],
    ['Powered on', disk.powerOnHours != null ? `${disk.powerOnHours.toLocaleString('en-GB')} h (${(disk.powerOnHours / 8760).toFixed(1)} yr)` : null],
    ['Life left', disk.wear != null ? `${Math.max(0, 100 - disk.wear)}%` : null],
    ['Errors', disk.readErrors != null ? `${disk.readErrors} read / ${disk.writeErrors} write` : null],
    ['Serial', disk.serial || null],
  ];
  for (const [k, v] of parts) {
    if (v == null) continue;
    const span = document.createElement('span');
    span.append(`${k} `);
    const b = document.createElement('b');
    b.textContent = v;
    span.append(b);
    stats.append(span);
  }
  card.append(stats);
  return card;
}

function renderSystem() {
  const body = $('system-body');
  const info = state.system.info;
  if (!info) {
    body.replaceChildren(empty('Reading this machine…'));
    return;
  }

  body.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'spec-grid';

  grid.append(
    specCard({
      title: 'Windows',
      hero: info.os.caption,
      sub: `Build ${info.os.build} · ${info.os.architecture}`,
      rows: [
        ['Activation', info.activation ? info.activation.status : null],
        ['Installed', formatDay(info.os.installedOn)],
        ['Up for', formatUptime(info.uptimeMs)],
        ['Computer name', info.os.computerName || info.hostname],
      ],
    })
  );

  grid.append(
    specCard({
      title: 'Machine',
      hero: [info.machine.manufacturer, info.machine.model].filter(Boolean).join(' ') || 'PC',
      sub: info.machine.systemType,
      rows: [
        ['Motherboard', info.machine.board],
        ['BIOS', info.machine.biosVersion ? `${info.machine.biosVersion}${info.machine.biosDate ? ` (${formatDay(info.machine.biosDate)})` : ''}` : null],
        ['Battery', info.battery ? `${info.battery.percent}%` : null],
      ],
    })
  );

  grid.append(
    specCard({
      title: 'Processor',
      hero: info.cpu.name,
      rows: [
        ['Cores / threads', `${info.cpu.cores} / ${info.cpu.threads}`],
        ['Base clock', info.cpu.maxClockMhz ? `${(info.cpu.maxClockMhz / 1000).toFixed(2)} GHz` : null],
        ['Sockets', info.cpu.sockets > 1 ? String(info.cpu.sockets) : null],
      ],
    })
  );

  const memRows = [['Slots', `${info.memory.slotsUsed} of ${info.memory.slotsTotal || '?'} filled`]];
  for (const m of info.memory.modules) {
    memRows.push([m.slot, `${formatBytes(m.capacity)} · ${m.speed} MHz${m.manufacturer ? ` · ${m.manufacturer}` : ''}`]);
  }
  grid.append(specCard({ title: 'Memory', hero: `${formatBytes(info.memory.total)} RAM`, rows: memRows }));

  for (const gpu of info.gpus.filter((g) => g.vram || /nvidia|amd|radeon|intel|geforce|arc/i.test(g.name))) {
    grid.append(
      specCard({
        title: 'Graphics',
        hero: gpu.name,
        rows: [
          ['Memory', gpu.vram ? formatBytes(gpu.vram) : null],
          ['Resolution', gpu.resolution],
          ['Driver', gpu.driverVersion ? `${gpu.driverVersion}${gpu.driverDate ? ` (${formatDay(gpu.driverDate)})` : ''}` : null],
        ],
      })
    );
  }

  body.append(grid);

  const drivesLabel = document.createElement('div');
  drivesLabel.className = 'group-title';
  drivesLabel.textContent = `Drive health · ${info.disks.length}`;
  body.append(drivesLabel);
  for (const disk of info.disks) body.append(driveCard(disk));

  const anyReliability = info.disks.some((d) => d.temperature != null || d.powerOnHours != null || d.wear != null);
  if (!anyReliability && !state.admin) {
    const note = document.createElement('p');
    note.className = 'subtitle';
    note.style.marginTop = '10px';
    note.textContent =
      'Temperature, power-on hours and SSD wear are reported by some drives only, and often need administrator rights. Restart as administrator to see more.';
    body.append(note);
  }

  $('system-subtitle').textContent = `${info.machine.manufacturer || ''} ${info.machine.model || ''}`.trim() || 'This machine';
}

function buildSystemReport() {
  const info = state.system.info;
  if (!info) return '';
  const lines = ['BOB — system report', new Date().toLocaleString('en-GB'), ''];
  lines.push(`OS         ${info.os.caption} (build ${info.os.build}, ${info.os.architecture})`);
  if (info.activation) lines.push(`Activation ${info.activation.status}`);
  lines.push(`Machine    ${[info.machine.manufacturer, info.machine.model].filter(Boolean).join(' ')}`);
  lines.push(`Board      ${info.machine.board} · BIOS ${info.machine.biosVersion}`);
  lines.push(`CPU        ${info.cpu.name} (${info.cpu.cores}c/${info.cpu.threads}t)`);
  lines.push(`RAM        ${formatBytes(info.memory.total)} (${info.memory.slotsUsed}/${info.memory.slotsTotal} slots)`);
  for (const m of info.memory.modules) lines.push(`             ${m.slot}: ${formatBytes(m.capacity)} ${m.speed}MHz ${m.manufacturer} ${m.partNumber}`.trimEnd());
  for (const g of info.gpus.filter((x) => x.vram)) lines.push(`GPU        ${g.name}${g.vram ? ` (${formatBytes(g.vram)})` : ''} driver ${g.driverVersion}`);
  lines.push('Drives:');
  for (const d of info.disks) {
    let line = `             ${d.name} — ${formatBytes(d.size)} ${d.media || ''}/${d.bus || ''} — ${d.health}`;
    if (d.temperature != null) line += ` ${d.temperature}°C`;
    if (d.powerOnHours != null) line += ` ${d.powerOnHours}h`;
    if (d.wear != null) line += ` ${100 - d.wear}% life`;
    lines.push(line.replace(/\s+/g, ' ').replace('             ', '             '));
  }
  return lines.join('\n');
}

async function loadSystem() {
  state.system.loaded = false;
  $('system-body').replaceChildren(empty('Reading this machine…'));
  $('system-copy').disabled = true;
  try {
    state.system.info = await window.pc.system();
    state.system.loaded = true;
    renderSystem();
    $('system-copy').disabled = false;
  } catch (error) {
    state.system.loaded = true;
    $('system-body').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('system-refresh').addEventListener('click', loadSystem);
$('system-copy').addEventListener('click', async () => {
  try {
    await window.pc.copyText(buildSystemReport());
    toast('System report copied to the clipboard.', 'good');
  } catch (error) {
    toast(error.message, 'error');
  }
});

/* Performance monitor ------------------------------------------------------ */

function fmtRate(bytesPerSec) {
  const b = bytesPerSec || 0;
  if (b < 1024) return `${Math.round(b)} B/s`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB/s`;
  return `${(b / 1024 / 1024).toFixed(1)} MB/s`;
}

function fillClass(pct) {
  return pct >= 90 ? 'full' : pct >= 70 ? 'tight' : '';
}

// A small SVG sparkline from a history array of 0-100 values.
function sparkPoints(history, width, height) {
  if (history.length < 2) return '';
  const max = history.length - 1;
  return history
    .map((v, i) => {
      const x = (i / max) * width;
      const y = height - (Math.max(0, Math.min(100, v)) / 100) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

function buildGauges() {
  const wrap = $('monitor-gauges');
  wrap.replaceChildren();
  const specs = [
    { id: 'cpu', label: 'CPU', spark: true },
    { id: 'mem', label: 'Memory', spark: true },
    { id: 'disk', label: 'Disk active', spark: false },
    { id: 'net', label: 'Network', spark: false },
  ];
  for (const spec of specs) {
    const g = document.createElement('div');
    g.className = 'gauge';
    const top = document.createElement('div');
    top.className = 'g-top';
    const label = document.createElement('span');
    label.className = 'g-label';
    label.textContent = spec.label;
    const val = document.createElement('span');
    val.className = 'g-val';
    val.id = `g-${spec.id}-val`;
    val.textContent = '—';
    top.append(label, val);

    const sub = document.createElement('div');
    sub.className = 'g-sub';
    sub.id = `g-${spec.id}-sub`;

    g.append(top, sub);

    if (spec.spark) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 100 26');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.classList.add('g-spark');
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      // A CSS var only resolves as a style property, not as an SVG attribute.
      line.style.stroke = 'var(--accent)';
      line.id = `g-${spec.id}-spark`;
      svg.append(line);
      g.append(svg);
    } else {
      const bar = document.createElement('div');
      bar.className = 'g-bar';
      const fill = document.createElement('div');
      fill.className = 'g-fill';
      fill.id = `g-${spec.id}-fill`;
      fill.style.width = '0%';
      bar.append(fill);
      g.append(bar);
    }
    wrap.append(g);
  }
}

function procRows(container, list, kind) {
  container.replaceChildren();
  if (!list.length) {
    container.append(empty('—'));
    return;
  }
  for (const p of list) {
    const row = document.createElement('div');
    row.className = 'mon-row';
    const name = document.createElement('div');
    name.className = 'm-name';
    name.textContent = p.name;
    if (p.count > 1) {
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      cnt.textContent = `  ×${p.count}`;
      name.append(cnt);
    }
    const val = document.createElement('div');
    val.className = 'm-val';
    val.textContent = kind === 'cpu' ? `${p.cpu.toFixed(0)}%` : formatBytes(p.mem);
    row.append(name, val);
    container.append(row);
  }
}

function applySample(s) {
  state.monitor.built || (buildGauges(), (state.monitor.built = true));

  $('g-cpu-val').textContent = `${s.cpu}%`;
  $('g-cpu-sub').textContent = `${s.cores} cores`;
  $('g-mem-val').textContent = `${s.mem.pct}%`;
  $('g-mem-sub').textContent = `${formatBytes(s.mem.used)} of ${formatBytes(s.mem.total)}`;
  $('g-disk-val').textContent = `${s.disk.pct}%`;
  $('g-disk-sub').textContent = fmtRate(s.disk.bytesPerSec);
  $('g-net-val').textContent = fmtRate(s.net.bytesPerSec);
  $('g-net-sub').textContent = 'throughput';

  const diskFill = $('g-disk-fill');
  diskFill.style.width = `${s.disk.pct}%`;
  diskFill.className = `g-fill ${fillClass(s.disk.pct)}`;

  // Histories + sparklines for CPU and memory.
  state.monitor.cpuHistory.push(s.cpu);
  state.monitor.memHistory.push(s.mem.pct);
  if (state.monitor.cpuHistory.length > 60) state.monitor.cpuHistory.shift();
  if (state.monitor.memHistory.length > 60) state.monitor.memHistory.shift();
  const cpuSpark = $('g-cpu-spark');
  if (cpuSpark) cpuSpark.setAttribute('points', sparkPoints(state.monitor.cpuHistory, 100, 26));
  const memSpark = $('g-mem-spark');
  if (memSpark) {
    memSpark.setAttribute('points', sparkPoints(state.monitor.memHistory, 100, 26));
    memSpark.style.stroke = s.mem.pct >= 90 ? 'var(--danger)' : s.mem.pct >= 70 ? 'var(--warn)' : 'var(--accent)';
  }

  procRows($('monitor-cpu'), s.topCpu, 'cpu');
  procRows($('monitor-mem'), s.topMem, 'mem');

  $('monitor-subtitle').textContent = `${s.processCount} processes · updating every 2s`;
  $('monitor-live').hidden = false;
}

async function pollMonitor() {
  if (!state.monitor.active) return;
  try {
    const s = await window.pc.monitor();
    if (state.monitor.active) applySample(s);
  } catch (error) {
    if (state.monitor.active) $('monitor-subtitle').textContent = `Paused: ${error.message}`;
  }
  if (state.monitor.active) state.monitor.timer = setTimeout(pollMonitor, 2000);
}

function startMonitor() {
  if (state.monitor.active) return;
  state.monitor.active = true;
  if (!state.monitor.built) {
    $('monitor-gauges').replaceChildren(empty('Starting the performance counters…'));
  }
  pollMonitor();
}

function stopMonitor() {
  state.monitor.active = false;
  clearTimeout(state.monitor.timer);
  $('monitor-live').hidden = true;
}

/* Devices ------------------------------------------------------------------ */

function deviceLine(d) {
  const bits = [];
  if (d.driverVersion) bits.push(`driver ${d.driverVersion}`);
  if (d.driverDate) bits.push(formatDay(d.driverDate));
  if (d.driverProvider && !/microsoft/i.test(d.driverProvider)) bits.push(d.driverProvider);
  else if (d.manufacturer && !bits.length) bits.push(d.manufacturer);
  return bits.join(' · ') || (d.manufacturer || 'No driver information');
}

function renderDevices() {
  const body = $('devices-body');
  const data = state.devices.data;
  if (!data) {
    body.replaceChildren(empty('Reading devices…'));
    return;
  }

  const term = state.devices.search.trim().toLowerCase();
  const matches = (d) => !term || `${d.name} ${d.manufacturer || ''} ${d.driverProvider || ''} ${d.class}`.toLowerCase().includes(term);

  body.replaceChildren();

  // Problems first, always visible.
  const problems = data.problems.filter(matches);
  if (problems.length) {
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = `Needs attention · ${problems.length}`;
    body.append(title);
    for (const p of problems) {
      const card = document.createElement('div');
      card.className = 'dev-problem';
      const dn = document.createElement('div');
      dn.className = 'dn';
      dn.textContent = `${p.name}  ·  ${p.class}`;
      const pr = document.createElement('div');
      pr.className = 'pr';
      pr.textContent = p.problem;
      card.append(dn, pr);
      body.append(card);
    }
  }

  const groupsTitle = document.createElement('div');
  groupsTitle.className = 'group-title';
  groupsTitle.textContent = 'All devices';
  body.append(groupsTitle);

  let shown = 0;
  for (const group of data.groups) {
    const items = group.items.filter(matches);
    if (!items.length) continue;
    shown += items.length;

    const box = document.createElement('div');
    box.className = 'dev-group';
    // A search auto-opens matching groups; otherwise remember the toggle state.
    const open = term ? true : state.devices.openClasses.has(group.name);
    if (open) box.classList.add('open');

    const head = document.createElement('div');
    head.className = 'dev-group-head';
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '▶';
    const cls = document.createElement('span');
    cls.className = 'cls';
    cls.textContent = group.name;
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = `${items.length}`;
    head.append(chev, cls, cnt);

    const bodyWrap = document.createElement('div');
    bodyWrap.hidden = !open;
    for (const d of items) {
      const item = document.createElement('div');
      item.className = 'dev-item';
      const dn = document.createElement('div');
      dn.className = 'dn';
      dn.textContent = d.name;
      const dd = document.createElement('div');
      dd.className = 'dd';
      dd.textContent = deviceLine(d);
      item.append(dn, dd);
      bodyWrap.append(item);
    }

    head.addEventListener('click', () => {
      const nowOpen = !box.classList.contains('open');
      box.classList.toggle('open', nowOpen);
      bodyWrap.hidden = !nowOpen;
      if (nowOpen) state.devices.openClasses.add(group.name);
      else state.devices.openClasses.delete(group.name);
    });

    box.append(head, bodyWrap);
    body.append(box);
  }

  if (!problems.length && !shown) {
    body.replaceChildren(empty(term ? 'No devices match.' : 'No devices found.'));
  }

  $('devices-subtitle').textContent =
    `${data.total} devices · ${data.withDrivers} with a driver` + (data.problems.length ? ` · ${data.problems.length} need attention` : ' · all healthy');
  $('nav-devices-count').textContent = data.problems.length ? String(data.problems.length) : '';
}

async function loadDevices() {
  state.devices.loaded = false;
  renderDevices();
  try {
    state.devices.data = await window.pc.devices();
    state.devices.loaded = true;
    renderDevices();
  } catch (error) {
    state.devices.loaded = true;
    $('devices-body').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('devices-refresh').addEventListener('click', loadDevices);
$('devices-search').addEventListener('input', (event) => {
  state.devices.search = event.target.value;
  if (state.devices.data) renderDevices();
});

/* Autoruns ----------------------------------------------------------------- */

// A service (always) and a scheduled task under \Microsoft need admin to
// change; user-owned tasks do not. The backend also guards, but disabling the
// switch up front is clearer than a failed click.
function autorunNeedsAdmin(entry) {
  if (entry.actionKind === 'service') return true;
  if (entry.actionKind === 'task') return entry.builtIn;
  return false;
}

function autorunsRow(entry) {
  const row = document.createElement('div');
  row.className = `row${entry.enabled ? '' : ' is-off'}${entry.flagged ? ' is-flagged' : ''}`;

  const main = document.createElement('div');
  main.className = 'row-main';
  const name = document.createElement('div');
  name.className = 'row-name';
  name.textContent = entry.name;
  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.textContent = [entry.publisher || (entry.executable ? 'No publisher' : ''), entry.location, entry.command]
    .filter(Boolean)
    .join('  ·  ');
  meta.title = entry.command || '';
  main.append(name, meta);
  if (entry.flagged && entry.flagReason) {
    const why = document.createElement('div');
    why.className = 'ar-why';
    why.textContent = entry.flagReason;
    main.append(why);
  }

  const tags = document.createElement('div');
  tags.className = 'row-tags';
  if (entry.flagged) {
    const tag = document.createElement('span');
    tag.className = 'tag tag-warn';
    tag.textContent = 'Flagged';
    tags.append(tag);
  } else if (entry.signed && entry.publisher) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'Signed';
    tag.title = `Signed by ${entry.publisher}`;
    tags.append(tag);
  }
  if (!entry.actionable) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'Read-only';
    tag.title = 'Editing this by hand can break Windows — inspect it, then act deliberately.';
    tags.append(tag);
  }

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  if (entry.executable) {
    const reveal = document.createElement('button');
    reveal.className = 'btn btn-ghost btn-small';
    reveal.textContent = 'Show file';
    reveal.addEventListener('click', () => {
      window.pc.autoruns.reveal(entry.id).catch((error) => toast(error.message, 'error'));
    });
    actions.append(reveal);
  }

  if (entry.actionable) {
    const needsAdmin = autorunNeedsAdmin(entry) && !state.admin;
    const label = document.createElement('label');
    label.className = 'switch';
    label.title = needsAdmin
      ? 'Restart as administrator to change this.'
      : entry.actionKind === 'service'
        ? 'Start automatically'
        : 'Task enabled';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = entry.enabled;
    input.disabled = needsAdmin;
    const track = document.createElement('span');
    track.className = 'switch-track';
    label.append(input, track);

    input.addEventListener('change', async () => {
      const wanted = input.checked;
      input.disabled = true;
      try {
        await window.pc.autoruns.setEnabled(entry.id, wanted);
        entry.enabled = wanted;
        row.classList.toggle('is-off', !wanted);
        toast(`${entry.name} ${wanted ? 'enabled' : 'disabled'}.`, 'good');
      } catch (error) {
        input.checked = !wanted;
        toast(error.message, 'error');
      } finally {
        input.disabled = false;
      }
    });
    actions.append(label);
  }

  row.append(main, tags, actions);
  return row;
}

function extRow(ext) {
  const row = document.createElement('div');
  row.className = 'row';
  const main = document.createElement('div');
  main.className = 'row-main';
  const name = document.createElement('div');
  name.className = 'row-name';
  name.textContent = ext.name;
  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.textContent = [`${ext.browser} · ${ext.profile}`, ext.extId].filter(Boolean).join('  ·  ');
  meta.title = ext.path || '';
  main.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  if (ext.path) {
    const reveal = document.createElement('button');
    reveal.className = 'btn btn-ghost btn-small';
    reveal.textContent = 'Show folder';
    reveal.addEventListener('click', () => {
      window.pc.files.reveal(ext.path).catch((error) => toast(error.message, 'error'));
    });
    actions.append(reveal);
  }
  row.append(main, actions);
  return row;
}

function autorunsGroup(id, label, hint, entries, defaultOpen) {
  const box = document.createElement('div');
  box.className = 'dev-group';
  const term = state.autoruns.search.trim();
  const open = term ? true : state.autoruns.openGroups.has(id) || defaultOpen;
  if (open) box.classList.add('open');

  const head = document.createElement('div');
  head.className = 'dev-group-head';
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '▶';
  const cls = document.createElement('span');
  cls.className = 'cls';
  cls.textContent = label;
  const hintEl = document.createElement('span');
  hintEl.className = 'ar-group-hint';
  hintEl.textContent = hint;
  const cnt = document.createElement('span');
  cnt.className = 'cnt';
  cnt.textContent = `${entries.length}`;
  head.append(chev, cls, hintEl, cnt);

  const wrap = document.createElement('div');
  wrap.hidden = !open;
  for (const entry of entries) wrap.append(entry.__ext ? extRow(entry) : autorunsRow(entry));

  head.addEventListener('click', () => {
    const nowOpen = !box.classList.contains('open');
    box.classList.toggle('open', nowOpen);
    wrap.hidden = !nowOpen;
    if (nowOpen) state.autoruns.openGroups.add(id);
    else state.autoruns.openGroups.delete(id);
  });

  box.append(head, wrap);
  return box;
}

function renderAutoruns() {
  const body = $('autoruns-body');
  const data = state.autoruns.data;
  if (!data) {
    body.replaceChildren(empty('Auditing autostart locations…'));
    return;
  }

  const term = state.autoruns.search.trim().toLowerCase();
  const matches = (e) =>
    (!term || `${e.name} ${e.publisher || ''} ${e.location || ''} ${e.command || ''}`.toLowerCase().includes(term)) &&
    (!state.autoruns.flaggedOnly || e.flagged);

  // Summary banner.
  const summary = $('autoruns-summary');
  const card = document.createElement('div');
  card.className = `ar-summary ${data.summary.flagged ? 'is-warn' : 'is-good'}`;
  const big = document.createElement('div');
  big.className = 'ar-summary-lead';
  big.textContent = data.summary.flagged
    ? `${data.summary.flagged} item${data.summary.flagged === 1 ? '' : 's'} worth a look`
    : 'Nothing suspicious';
  const sub = document.createElement('div');
  sub.className = 'ar-summary-sub';
  sub.textContent = data.summary.flagged
    ? 'Unsigned, missing, or running from an unusual place. Review each before switching anything off.'
    : `Every autostart entry is signed and accounted for — ${data.summary.services} services, ${data.summary.tasks} tasks checked.`;
  card.append(big, sub);
  summary.replaceChildren(card);

  body.replaceChildren();

  // Flagged first, always visible.
  const flagged = [];
  for (const g of data.groups) for (const e of g.entries) if (e.flagged && matches(e)) flagged.push(e);
  if (flagged.length) {
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = `Needs a look · ${flagged.length}`;
    body.append(title);
    const list = document.createElement('div');
    list.className = 'ar-flaglist';
    for (const e of flagged) list.append(autorunsRow(e));
    body.append(list);
  }

  // Category groups.
  let shown = 0;
  for (const g of data.groups) {
    const items = g.entries.filter(matches);
    if (!items.length) continue;
    shown += items.length;
    const defaultOpen = g.id === 'logon' || g.id === 'ifeo' || g.id === 'wmi';
    body.append(autorunsGroup(g.id, g.label, g.hint, items, defaultOpen));
  }

  // Browser add-ons (filled in after the main audit).
  const ext = state.autoruns.ext;
  if (ext && ext.length && !state.autoruns.flaggedOnly) {
    const extItems = ext
      .filter((x) => !term || `${x.name} ${x.browser} ${x.extId}`.toLowerCase().includes(term))
      .map((x) => ({ ...x, __ext: true }));
    if (extItems.length) {
      shown += extItems.length;
      body.append(autorunsGroup('ext', 'Browser add-ons', 'Installed browser extensions', extItems, false));
    }
  }

  if (!flagged.length && !shown) {
    const msg = term
      ? 'Nothing matches.'
      : state.autoruns.flaggedOnly
        ? 'Nothing flagged — all clear.'
        : 'No autostart entries found.';
    body.replaceChildren(empty(msg));
  }

  $('autoruns-subtitle').textContent = `${data.summary.total} autostart entries · ${data.summary.flagged} flagged`;
  $('nav-autoruns-count').textContent = data.summary.flagged ? String(data.summary.flagged) : '';
}

async function loadAutoruns() {
  state.autoruns.loaded = false;
  state.autoruns.ext = null;
  renderAutoruns();
  try {
    state.autoruns.data = await window.pc.autoruns.read();
    state.autoruns.loaded = true;
    renderAutoruns();
    // Browser add-ons are slower; fill them in once the audit is painted.
    window.pc.autoruns
      .extensions()
      .then((res) => {
        state.autoruns.ext = res.extensions;
        renderAutoruns();
      })
      .catch(() => {});
  } catch (error) {
    state.autoruns.loaded = true;
    $('autoruns-body').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('autoruns-refresh').addEventListener('click', loadAutoruns);
$('autoruns-search').addEventListener('input', (event) => {
  state.autoruns.search = event.target.value;
  if (state.autoruns.data) renderAutoruns();
});
$('autoruns-flagged-only').addEventListener('change', (event) => {
  state.autoruns.flaggedOnly = event.target.checked;
  if (state.autoruns.data) renderAutoruns();
});

/* Security posture --------------------------------------------------------- */

function securityCheckRow(c) {
  const row = document.createElement('div');
  row.className = 'sec-check';

  const dot = document.createElement('span');
  dot.className = `sec-dot is-${c.status}`;
  dot.title = c.status;

  const main = document.createElement('div');
  main.className = 'sec-main';
  const label = document.createElement('div');
  label.className = 'sec-label';
  label.textContent = c.label;
  main.append(label);
  if (c.detail) {
    const det = document.createElement('div');
    det.className = 'sec-detail';
    det.textContent = c.detail;
    main.append(det);
  }
  if (c.hint && (c.status === 'warn' || c.status === 'bad' || c.status === 'unknown')) {
    const hint = document.createElement('div');
    hint.className = 'sec-hint';
    hint.textContent = c.hint;
    main.append(hint);
  }

  const value = document.createElement('div');
  value.className = `sec-value is-${c.status}`;
  value.textContent = c.value;

  row.append(dot, main, value);
  return row;
}

function renderSecurity() {
  const body = $('security-body');
  const data = state.security.data;
  if (!data) {
    body.replaceChildren(empty('Checking security settings…'));
    return;
  }

  const s = data.summary;
  const card = document.createElement('div');
  const tone = s.bad ? 'is-bad' : s.warn ? 'is-warn' : 'is-good';
  card.className = `sec-summary ${tone}`;
  const lead = document.createElement('div');
  lead.className = 'sec-summary-lead';
  lead.textContent = s.bad ? 'Needs attention' : s.warn ? 'A few things to check' : 'Looks healthy';
  const sub = document.createElement('div');
  sub.className = 'sec-summary-sub';
  const parts = [];
  if (s.bad) parts.push(`${s.bad} problem${s.bad === 1 ? '' : 's'}`);
  if (s.warn) parts.push(`${s.warn} to check`);
  if (s.good) parts.push(`${s.good} healthy`);
  sub.textContent = parts.join(' · ') || 'All settings read.';
  card.append(lead, sub);
  $('security-summary').replaceChildren(card);

  body.replaceChildren();
  for (const section of data.sections) {
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = section.label;
    body.append(title);
    const list = document.createElement('div');
    list.className = 'sec-list';
    for (const c of section.checks) list.append(securityCheckRow(c));
    body.append(list);
  }

  const issues = s.bad + s.warn;
  $('security-subtitle').textContent = issues
    ? `${issues} thing${issues === 1 ? '' : 's'} worth a look · ${s.good} healthy`
    : 'Everything checks out.';
  $('nav-security-count').textContent = issues ? String(issues) : '';
}

async function loadSecurity() {
  state.security.loaded = false;
  renderSecurity();
  try {
    state.security.data = await window.pc.security();
    state.security.loaded = true;
    renderSecurity();
  } catch (error) {
    state.security.loaded = true;
    $('security-body').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('security-refresh').addEventListener('click', loadSecurity);

/* Battery health ----------------------------------------------------------- */

function formatRuntime(min) {
  if (min == null) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function statRow(label, value) {
  const row = document.createElement('div');
  row.className = 'sec-check';
  const main = document.createElement('div');
  main.className = 'sec-main';
  const l = document.createElement('div');
  l.className = 'sec-label';
  l.textContent = label;
  main.append(l);
  const v = document.createElement('div');
  v.className = 'sec-value';
  v.textContent = value;
  row.append(main, v);
  return row;
}

function renderBattery() {
  const body = $('battery-body');
  const b = state.battery.data;
  if (!b) {
    body.replaceChildren(empty('Reading the battery…'));
    return;
  }
  if (!b.present) {
    body.replaceChildren(empty('No battery detected — this looks like a desktop.'));
    $('battery-subtitle').textContent = 'No battery on this machine.';
    return;
  }

  body.replaceChildren();

  // Hero: charge + state + runtime, with a charge meter.
  const hero = document.createElement('div');
  hero.className = 'bat-hero';
  const left = document.createElement('div');
  left.className = 'bat-hero-left';
  const pct = document.createElement('div');
  pct.className = 'bat-pct';
  pct.textContent = `${b.chargePct}%`;
  const st = document.createElement('div');
  st.className = 'bat-state';
  const runtime = formatRuntime(b.runtimeMin);
  st.textContent = b.state + (runtime && !b.charging ? ` · ~${runtime} left` : '');
  left.append(pct, st);

  const meter = document.createElement('div');
  meter.className = 'bat-meter';
  const fill = document.createElement('div');
  fill.className = `bat-meter-fill${b.chargePct <= 15 && !b.acOnline ? ' is-low' : ''}`;
  fill.style.width = `${Math.max(3, b.chargePct)}%`;
  meter.append(fill);
  hero.append(left, meter);
  body.append(hero);

  // Health / wear card.
  const wearKnown = b.wearPct != null;
  const card = document.createElement('div');
  card.className = `sec-summary is-${wearKnown ? b.health : 'info'}`;
  const lead = document.createElement('div');
  lead.className = 'sec-summary-lead';
  lead.textContent = wearKnown
    ? `Battery health: ${b.health === 'good' ? 'Good' : b.health === 'warn' ? 'Fair' : 'Poor'}`
    : 'Battery wear: not reported';
  const sub = document.createElement('div');
  sub.className = 'sec-summary-sub';
  sub.textContent = wearKnown
    ? `Holds ${100 - b.wearPct}% of its original capacity — ${b.wearPct}% worn.`
    : 'This battery does not report its design capacity.';
  card.append(lead, sub);
  if (wearKnown) {
    const bar = document.createElement('div');
    bar.className = 'bat-wear';
    const wfill = document.createElement('div');
    wfill.className = `bat-wear-fill is-${b.health}`;
    wfill.style.width = `${Math.max(2, b.wearPct)}%`;
    bar.append(wfill);
    card.append(bar);
  }
  body.append(card);

  // Detail stats.
  const title = document.createElement('div');
  title.className = 'group-title';
  title.textContent = 'Details';
  body.append(title);
  const list = document.createElement('div');
  list.className = 'sec-list';
  const wh = (mwh) => `${(mwh / 1000).toFixed(1)} Wh`;
  if (b.designCapacity) list.append(statRow('Design capacity', wh(b.designCapacity)));
  if (b.fullCapacity) list.append(statRow('Full charge now', wh(b.fullCapacity)));
  list.append(statRow('Cycle count', b.cycleCount ? String(b.cycleCount) : 'Not reported'));
  if (b.chemistry) list.append(statRow('Chemistry', b.chemistry));
  if (b.voltageMv) list.append(statRow('Voltage', `${(b.voltageMv / 1000).toFixed(2)} V`));
  if (b.manufacturer) list.append(statRow('Manufacturer', b.manufacturer));
  if (b.name) list.append(statRow('Name', b.name));
  body.append(list);

  $('battery-subtitle').textContent = wearKnown
    ? `${b.chargePct}% now · ${b.wearPct}% worn${b.cycleCount ? ` · ${b.cycleCount} cycles` : ''}`
    : `${b.chargePct}% now`;
}

async function loadBattery() {
  state.battery.loaded = false;
  renderBattery();
  try {
    state.battery.data = await window.pc.battery();
    state.battery.loaded = true;
    renderBattery();
  } catch (error) {
    state.battery.loaded = true;
    $('battery-body').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('battery-refresh').addEventListener('click', loadBattery);

/* Connections -------------------------------------------------------------- */

const SCOPE_LABEL = { public: 'Public', private: 'LAN', local: 'Local' };
const BOUND_LABEL = { all: 'Reachable', lan: 'LAN', loopback: 'Local' };

function connectionRow(entry, kind) {
  const row = document.createElement('div');
  row.className = `row${entry.flagged ? ' is-flagged' : ''}`;

  const main = document.createElement('div');
  main.className = 'row-main';
  const name = document.createElement('div');
  name.className = 'row-name';
  name.textContent = entry.process;
  const meta = document.createElement('div');
  meta.className = 'row-meta';
  const where =
    kind === 'out'
      ? `→ ${entry.remoteAddr}:${entry.remotePort}${entry.count > 1 ? `  ×${entry.count}` : ''}`
      : `${entry.proto} :${entry.localPort}`;
  meta.textContent = [entry.publisher || 'No publisher', `PID ${entry.pid}`, where].filter(Boolean).join('  ·  ');
  meta.title = entry.exe || '';
  main.append(name, meta);
  if (entry.flagged && entry.flagReason) {
    const why = document.createElement('div');
    why.className = 'ar-why';
    why.textContent = entry.flagReason;
    main.append(why);
  }

  const tags = document.createElement('div');
  tags.className = 'row-tags';
  if (entry.flagged) {
    const t = document.createElement('span');
    t.className = 'tag tag-warn';
    t.textContent = 'Flagged';
    tags.append(t);
  }
  const scopeTag = document.createElement('span');
  if (kind === 'out') {
    scopeTag.className = `tag${entry.scope === 'public' ? ' tag-scope-public' : ''}`;
    scopeTag.textContent = SCOPE_LABEL[entry.scope] || entry.scope;
  } else {
    scopeTag.className = `tag${entry.bound === 'all' ? ' tag-warn' : ''}`;
    scopeTag.textContent = BOUND_LABEL[entry.bound] || entry.bound;
    scopeTag.title = entry.bound === 'all' ? 'Reachable from any network' : '';
  }
  tags.append(scopeTag);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  if (entry.exe) {
    const reveal = document.createElement('button');
    reveal.className = 'btn btn-ghost btn-small';
    reveal.textContent = 'Show file';
    reveal.addEventListener('click', () => {
      window.pc.files.reveal(entry.exe).catch((error) => toast(error.message, 'error'));
    });
    actions.append(reveal);
  }

  row.append(main, tags, actions);
  return row;
}

function renderConnections() {
  const body = $('connections-body');
  const data = state.connections.data;
  if (!data) {
    body.replaceChildren(empty('Reading network connections…'));
    return;
  }

  const term = state.connections.search.trim().toLowerCase();
  const pub = state.connections.publicOnly;
  const matchOut = (c) =>
    (!term || `${c.process} ${c.publisher || ''} ${c.remoteAddr} ${c.remotePort}`.toLowerCase().includes(term)) &&
    (!pub || c.scope === 'public');
  const matchListen = (c) =>
    (!term || `${c.process} ${c.publisher || ''} ${c.proto} ${c.localPort}`.toLowerCase().includes(term)) &&
    (!pub || c.bound === 'all');

  // Summary banner.
  const s = data.summary;
  const card = document.createElement('div');
  card.className = `ar-summary ${s.flagged ? 'is-warn' : 'is-good'}`;
  const lead = document.createElement('div');
  lead.className = 'ar-summary-lead';
  lead.textContent = s.flagged ? `${s.flagged} connection${s.flagged === 1 ? '' : 's'} worth a look` : 'Nothing unusual';
  const sub = document.createElement('div');
  sub.className = 'ar-summary-sub';
  sub.textContent = s.flagged
    ? 'An unsigned program is holding a connection open — check what it is.'
    : `${s.outbound} outbound · ${s.listening} listening · ${s.publicOut} to the public internet, all from signed programs.`;
  card.append(lead, sub);
  $('connections-summary').replaceChildren(card);

  body.replaceChildren();

  const outbound = data.outbound.filter(matchOut);
  const listening = data.listening.filter(matchListen);

  const outTitle = document.createElement('div');
  outTitle.className = 'group-title';
  outTitle.textContent = `Outbound · ${outbound.length}`;
  body.append(outTitle);
  if (outbound.length) {
    const list = document.createElement('div');
    list.className = 'sec-list';
    for (const c of outbound) list.append(connectionRow(c, 'out'));
    body.append(list);
  } else {
    body.append(empty(term || pub ? 'No matching outbound connections.' : 'Nothing is connected out right now.'));
  }

  // Listening — collapsible, closed by default (it is long and mostly system).
  const box = document.createElement('div');
  box.className = 'dev-group';
  const open = term || pub ? true : state.connections.openListen;
  if (open) box.classList.add('open');
  const head = document.createElement('div');
  head.className = 'dev-group-head';
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '▶';
  const cls = document.createElement('span');
  cls.className = 'cls';
  cls.textContent = 'Listening';
  const hint = document.createElement('span');
  hint.className = 'ar-group-hint';
  hint.textContent = 'Ports this PC accepts connections on';
  const cnt = document.createElement('span');
  cnt.className = 'cnt';
  cnt.textContent = `${listening.length}`;
  head.append(chev, cls, hint, cnt);
  const wrap = document.createElement('div');
  wrap.hidden = !open;
  for (const c of listening) wrap.append(connectionRow(c, 'listen'));
  head.addEventListener('click', () => {
    const nowOpen = !box.classList.contains('open');
    box.classList.toggle('open', nowOpen);
    wrap.hidden = !nowOpen;
    state.connections.openListen = nowOpen;
  });
  box.append(head, wrap);
  body.append(box);

  $('connections-subtitle').textContent = `${s.outbound} outbound · ${s.listening} listening${s.flagged ? ` · ${s.flagged} flagged` : ''}`;
  $('nav-connections-count').textContent = s.flagged ? String(s.flagged) : '';
}

async function loadConnections() {
  state.connections.loaded = false;
  renderConnections();
  try {
    state.connections.data = await window.pc.connections();
    state.connections.loaded = true;
    renderConnections();
  } catch (error) {
    state.connections.loaded = true;
    $('connections-body').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('connections-refresh').addEventListener('click', loadConnections);
$('connections-search').addEventListener('input', (event) => {
  state.connections.search = event.target.value;
  if (state.connections.data) renderConnections();
});
$('connections-public-only').addEventListener('change', (event) => {
  state.connections.publicOnly = event.target.checked;
  if (state.connections.data) renderConnections();
});

/* Driver export ------------------------------------------------------------ */

function driverRow(pkg) {
  const row = document.createElement('div');
  row.className = 'row';
  const main = document.createElement('div');
  main.className = 'row-main';
  const name = document.createElement('div');
  name.className = 'row-name';
  name.textContent = pkg.deviceName || pkg.provider;
  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.textContent = [pkg.provider, pkg.version ? `v${pkg.version}` : '', pkg.date, pkg.inf]
    .filter(Boolean)
    .join('  ·  ');
  main.append(name, meta);

  const tags = document.createElement('div');
  tags.className = 'row-tags';
  if (pkg.className) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = pkg.className;
    tags.append(t);
  }
  if (pkg.deviceCount > 1) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = `${pkg.deviceCount} devices`;
    tags.append(t);
  }

  row.append(main, tags);
  return row;
}

function updateDriverExportButton() {
  const btn = $('drivers-export');
  const busy = state.drivers.exporting;
  const canExport = state.admin && state.drivers.data && state.drivers.data.total > 0;
  btn.disabled = busy || !canExport;
  btn.textContent = busy ? 'Exporting…' : 'Export all…';
  btn.title = !state.admin
    ? 'Restart as administrator to export drivers.'
    : 'Save every third-party driver to a folder you choose.';
}

function renderDrivers() {
  const body = $('drivers-body');
  const data = state.drivers.data;
  updateDriverExportButton();
  if (!data) {
    body.replaceChildren(empty('Reading installed drivers…'));
    return;
  }
  if (!data.total) {
    body.replaceChildren(empty('No third-party drivers found — nothing to back up.'));
    $('drivers-subtitle').textContent = 'No third-party drivers on this machine.';
    return;
  }

  const term = state.drivers.search.trim().toLowerCase();
  const matches = (p) =>
    !term || `${p.deviceName} ${p.provider} ${p.className} ${p.inf}`.toLowerCase().includes(term);
  const shown = data.packages.filter(matches);

  body.replaceChildren();
  const title = document.createElement('div');
  title.className = 'group-title';
  title.textContent = `Third-party drivers · ${data.total}`;
  body.append(title);
  if (!shown.length) {
    body.append(empty('Nothing matches.'));
  } else {
    const list = document.createElement('div');
    list.className = 'sec-list';
    for (const p of shown) list.append(driverRow(p));
    body.append(list);
  }

  $('drivers-subtitle').textContent = `${data.total} third-party driver package${data.total === 1 ? '' : 's'} — export saves each to its own folder.`;
}

async function loadDrivers() {
  state.drivers.loaded = false;
  renderDrivers();
  try {
    state.drivers.data = await window.pc.drivers.list();
    state.drivers.loaded = true;
    renderDrivers();
  } catch (error) {
    state.drivers.loaded = true;
    $('drivers-body').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

async function exportDrivers() {
  if (state.drivers.exporting) return;
  state.drivers.exporting = true;
  updateDriverExportButton();
  try {
    const result = await window.pc.drivers.export();
    if (result && result.canceled) return;
    toast(`Exported ${result.exported} driver${result.exported === 1 ? '' : 's'} (${formatBytes(result.bytes)}).`, 'good');
    const ok = await confirmAction({
      title: 'Drivers exported',
      body: `Saved ${result.exported} driver package${result.exported === 1 ? '' : 's'} (${formatBytes(result.bytes)}) to:\n\n${result.destination}`,
      confirmLabel: 'Open folder',
      danger: false,
    });
    if (ok) window.pc.drivers.reveal(result.destination).catch(() => {});
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.drivers.exporting = false;
    updateDriverExportButton();
  }
}

$('drivers-refresh').addEventListener('click', loadDrivers);
$('drivers-export').addEventListener('click', exportDrivers);
$('drivers-search').addEventListener('input', (event) => {
  state.drivers.search = event.target.value;
  if (state.drivers.data) renderDrivers();
});

/* Local accounts ----------------------------------------------------------- */

// A form modal for creating a user or setting a password. Resolves with the
// entered values, or null if cancelled.
function accountForm({ mode, user }) {
  return new Promise((resolve) => {
    const backdrop = $('account-modal');
    const confirm = $('account-modal-confirm');
    const cancel = $('account-modal-cancel');
    const nameField = $('acct-field-name');
    const fullField = $('acct-field-fullname');
    const adminField = $('acct-field-admin');
    const name = $('acct-name');
    const full = $('acct-fullname');
    const password = $('acct-password');
    const blank = $('acct-blank');
    const admin = $('acct-admin');
    const pwLabel = $('acct-pw-label');
    const hint = $('acct-hint');

    const creating = mode === 'create';
    $('account-modal-title').textContent = creating ? 'New user' : `Set password for ${user.name}`;
    confirm.textContent = creating ? 'Create' : 'Set password';
    nameField.hidden = !creating;
    fullField.hidden = !creating;
    adminField.hidden = !creating;
    pwLabel.textContent = creating ? 'Password' : 'New password';
    name.value = '';
    full.value = '';
    password.value = '';
    blank.checked = false;
    admin.checked = false;
    password.disabled = false;
    hint.textContent = creating ? '' : 'The old password cannot be recovered — this sets a new one.';
    backdrop.hidden = false;
    setTimeout(() => (creating ? name : password).focus(), 30);

    const onBlank = () => {
      password.disabled = blank.checked;
      if (blank.checked) password.value = '';
    };
    const finish = (value) => {
      backdrop.hidden = true;
      confirm.removeEventListener('click', onYes);
      cancel.removeEventListener('click', onNo);
      blank.removeEventListener('change', onBlank);
      backdrop.removeEventListener('click', onBackdrop);
      resolve(value);
    };
    const onYes = () => {
      const payload = {
        name: name.value.trim(),
        fullName: full.value.trim(),
        password: blank.checked ? '' : password.value,
        blank: blank.checked,
        admin: admin.checked,
      };
      if (creating && !payload.name) {
        hint.textContent = 'Enter a user name.';
        return;
      }
      if (!blank.checked && !password.value && !creating) {
        hint.textContent = 'Enter a password, or tick “No password”.';
        return;
      }
      finish(payload);
    };
    const onNo = () => finish(null);
    const onBackdrop = (event) => {
      if (event.target === backdrop) finish(null);
    };
    confirm.addEventListener('click', onYes);
    cancel.addEventListener('click', onNo);
    blank.addEventListener('change', onBlank);
    backdrop.addEventListener('click', onBackdrop);
  });
}

function accountRow(user) {
  const admin = state.admin;
  const row = document.createElement('div');
  row.className = `row${user.enabled ? '' : ' is-off'}`;

  const main = document.createElement('div');
  main.className = 'row-main';
  const name = document.createElement('div');
  name.className = 'row-name';
  name.textContent = user.name;
  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.textContent = [
    user.fullName,
    user.passwordLastSet ? `password set ${user.passwordLastSet}` : 'password never set',
    user.lastLogon ? `last logon ${user.lastLogon}` : '',
    !user.passwordRequired ? 'no password required' : '',
  ]
    .filter(Boolean)
    .join('  ·  ');
  main.append(name, meta);

  const tags = document.createElement('div');
  tags.className = 'row-tags';
  const addTag = (text, cls) => {
    const t = document.createElement('span');
    t.className = `tag${cls ? ` ${cls}` : ''}`;
    t.textContent = text;
    tags.append(t);
  };
  if (user.isCurrent) addTag('You');
  if (user.isAdmin) addTag('Admin', 'tag-scope-public');
  if (!user.enabled) addTag('Disabled', 'tag-warn');
  if (user.isBuiltin) addTag('Built-in');

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const mkBtn = (label, handler, { danger = false, disabled = false, title = '' } = {}) => {
    const b = document.createElement('button');
    b.className = `btn ${danger ? 'btn-ghost btn-small btn-danger-text' : 'btn-ghost btn-small'}`;
    b.textContent = label;
    b.disabled = !admin || disabled;
    b.title = !admin ? 'Restart as administrator to change accounts.' : title;
    b.addEventListener('click', handler);
    return b;
  };

  actions.append(
    mkBtn('Reset password', async () => {
      const form = await accountForm({ mode: 'password', user });
      if (!form) return;
      try {
        await window.pc.accounts.setPassword(user.name, form.password);
        toast(`Password ${form.blank ? 'cleared' : 'set'} for ${user.name}.`, 'good');
        loadAccounts();
      } catch (error) {
        toast(error.message, 'error');
      }
    })
  );

  actions.append(
    mkBtn(user.isAdmin ? 'Remove admin' : 'Make admin', async () => {
      try {
        await window.pc.accounts.setAdmin(user.name, !user.isAdmin);
        toast(`${user.name} ${user.isAdmin ? 'removed from' : 'added to'} Administrators.`, 'good');
        loadAccounts();
      } catch (error) {
        toast(error.message, 'error');
      }
    }, { disabled: user.isCurrent && user.isAdmin, title: user.isCurrent && user.isAdmin ? 'You cannot remove your own admin rights.' : '' })
  );

  actions.append(
    mkBtn(user.enabled ? 'Disable' : 'Enable', async () => {
      try {
        await window.pc.accounts.setEnabled(user.name, !user.enabled);
        toast(`${user.name} ${user.enabled ? 'disabled' : 'enabled'}.`, 'good');
        loadAccounts();
      } catch (error) {
        toast(error.message, 'error');
      }
    }, { disabled: user.isCurrent, title: user.isCurrent ? 'You cannot disable the account you are signed in with.' : '' })
  );

  actions.append(
    mkBtn('Delete', async () => {
      const ok = await confirmAction({
        title: `Delete “${user.name}”?`,
        body: `The account is removed from this PC. Its profile folder under C:\\Users is left in place. This cannot be undone from here.`,
        confirmLabel: 'Delete',
      });
      if (!ok) return;
      try {
        await window.pc.accounts.remove(user.name);
        toast(`Deleted ${user.name}.`, 'good');
        loadAccounts();
      } catch (error) {
        toast(error.message, 'error');
      }
    }, { danger: true, disabled: user.isCurrent || user.isBuiltin, title: user.isBuiltin ? 'Built-in accounts cannot be deleted.' : user.isCurrent ? 'You cannot delete the account you are signed in with.' : '' })
  );

  row.append(main, tags, actions);
  return row;
}

function renderAccounts() {
  const body = $('accounts-body');
  const data = state.accounts.data;
  const banner = $('accounts-banner');
  banner.replaceChildren();
  if (!state.admin) {
    const b = document.createElement('div');
    b.className = 'ar-summary is-warn';
    const lead = document.createElement('div');
    lead.className = 'ar-summary-lead';
    lead.textContent = 'Read-only — not running as administrator';
    const sub = document.createElement('div');
    sub.className = 'ar-summary-sub';
    sub.textContent = 'You can see the accounts, but creating, resetting or changing one needs admin. Restart as admin from the banner on the left.';
    b.append(lead, sub);
    banner.append(b);
  }
  $('accounts-new').disabled = !state.admin;
  $('accounts-new').title = state.admin ? '' : 'Restart as administrator to create accounts.';

  if (!data) {
    body.replaceChildren(empty('Reading accounts…'));
    return;
  }
  body.replaceChildren();
  const list = document.createElement('div');
  list.className = 'sec-list';
  for (const u of data.users) list.append(accountRow(u));
  body.append(list);

  $('accounts-subtitle').textContent = `${data.summary.total} account${data.summary.total === 1 ? '' : 's'} · ${data.summary.admins} admin · signed in as ${data.summary.current}`;
}

async function loadAccounts() {
  state.accounts.loaded = false;
  renderAccounts();
  try {
    state.accounts.data = await window.pc.accounts.list();
    state.accounts.loaded = true;
    renderAccounts();
  } catch (error) {
    state.accounts.loaded = true;
    $('accounts-body').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('accounts-refresh').addEventListener('click', loadAccounts);
$('accounts-new').addEventListener('click', async () => {
  const form = await accountForm({ mode: 'create' });
  if (!form) return;
  try {
    await window.pc.accounts.create({ name: form.name, password: form.password, fullName: form.fullName, admin: form.admin });
    toast(`Created ${form.name}${form.admin ? ' (administrator)' : ''}.`, 'good');
    loadAccounts();
  } catch (error) {
    toast(error.message, 'error');
  }
});

/* Toolbox ------------------------------------------------------------------ */

async function runTool(tool, tile) {
  if (state.toolbox.running) return;
  if (tool.confirm) {
    const ok = await confirmAction({
      title: `${tool.label}?`,
      body: tool.confirmBody || `Run ${tool.label}?`,
      confirmLabel: tool.label,
      danger: Boolean(tool.danger),
    });
    if (!ok) return;
  }
  state.toolbox.running = tool.id;
  tile.classList.add('is-busy');
  try {
    const result = await window.pc.toolbox.run(tool.id);
    toast(result.message, 'good');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.toolbox.running = null;
    tile.classList.remove('is-busy');
  }
}

function toolTile(tool) {
  const tile = document.createElement('button');
  tile.className = `tool-tile${tool.kind === 'action' ? ' is-action' : ''}`;
  const label = document.createElement('div');
  label.className = 'tool-label';
  label.textContent = tool.label;
  const desc = document.createElement('div');
  desc.className = 'tool-desc';
  desc.textContent = tool.desc;
  tile.append(label, desc);
  tile.addEventListener('click', () => runTool(tool, tile));
  return tile;
}

function renderToolbox() {
  const body = $('toolbox-body');
  const data = state.toolbox.data;
  if (!data) {
    body.replaceChildren(empty('Loading…'));
    return;
  }
  const term = state.toolbox.search.trim().toLowerCase();
  const tools = data.tools.filter((t) => !term || `${t.label} ${t.desc}`.toLowerCase().includes(term));

  body.replaceChildren();
  const groups = [...new Set(tools.map((t) => t.group))];
  if (!groups.length) {
    body.replaceChildren(empty('Nothing matches.'));
    return;
  }
  for (const group of groups) {
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = group;
    body.append(title);
    const grid = document.createElement('div');
    grid.className = 'tool-grid';
    for (const t of tools.filter((x) => x.group === group)) grid.append(toolTile(t));
    body.append(grid);
  }
}

async function loadToolbox() {
  try {
    state.toolbox.data = await window.pc.toolbox.list();
    state.toolbox.loaded = true;
    renderToolbox();
  } catch (error) {
    $('toolbox-body').replaceChildren(empty(error.message));
  }
}

$('toolbox-search').addEventListener('input', (event) => {
  state.toolbox.search = event.target.value;
  if (state.toolbox.data) renderToolbox();
});

/* Disks & partitions ------------------------------------------------------- */

// A generic single-field text prompt. Resolves with the string, or null on cancel.
function promptText({ title, label, value = '', placeholder = '', confirmLabel = 'OK', maxLength }) {
  return new Promise((resolve) => {
    const backdrop = $('prompt-modal');
    const input = $('prompt-input');
    const confirm = $('prompt-confirm');
    const cancel = $('prompt-cancel');
    $('prompt-title').textContent = title;
    $('prompt-label').textContent = label;
    $('prompt-hint').textContent = '';
    confirm.textContent = confirmLabel;
    input.value = value;
    input.placeholder = placeholder;
    if (maxLength) input.maxLength = maxLength;
    else input.removeAttribute('maxlength');
    backdrop.hidden = false;
    setTimeout(() => input.focus(), 30);
    const finish = (v) => {
      backdrop.hidden = true;
      confirm.removeEventListener('click', onYes);
      cancel.removeEventListener('click', onNo);
      input.removeEventListener('keydown', onKey);
      backdrop.removeEventListener('click', onBackdrop);
      resolve(v);
    };
    const onYes = () => finish(input.value);
    const onNo = () => finish(null);
    const onKey = (e) => { if (e.key === 'Enter') onYes(); if (e.key === 'Escape') onNo(); };
    const onBackdrop = (e) => { if (e.target === backdrop) finish(null); };
    confirm.addEventListener('click', onYes);
    cancel.addEventListener('click', onNo);
    input.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', onBackdrop);
  });
}

const SEG_COLORS = ['#3b6db8', '#2f8a6b', '#9a6a2f', '#7a4fa0', '#4a7d9c', '#8a5a5a'];

function diskCard(disk) {
  const card = document.createElement('div');
  card.className = 'disk-card';

  const head = document.createElement('div');
  head.className = 'disk-head';
  const title = document.createElement('div');
  title.className = 'disk-title';
  title.textContent = `Disk ${disk.number} · ${disk.friendlyName || 'Unknown'}`;
  const tagWrap = document.createElement('span');
  tagWrap.className = 'disk-tags';
  const addTag = (text, cls) => {
    const t = document.createElement('span');
    t.className = `tag${cls ? ` ${cls}` : ''}`;
    t.textContent = text;
    tagWrap.append(t);
  };
  if (disk.busType) addTag(disk.busType);
  if (disk.isSystem) addTag('System', 'tag-scope-public');
  if (disk.isOffline) addTag('Offline', 'tag-warn');
  if (disk.health && disk.health !== 'Healthy') addTag(disk.health, 'tag-warn');
  title.append(tagWrap);
  const sub = document.createElement('div');
  sub.className = 'disk-sub';
  sub.textContent = `${formatBytes(disk.size)} · ${disk.partitionStyle}${disk.health ? ` · ${disk.health}` : ''}${disk.unallocated > 1e7 ? ` · ${formatBytes(disk.unallocated)} unallocated` : ''}`;
  head.append(title, sub);
  card.append(head);

  // Proportional partition bar.
  const bar = document.createElement('div');
  bar.className = 'disk-bar';
  disk.partitions.forEach((p, i) => {
    const seg = document.createElement('div');
    seg.className = `disk-seg${p.protected ? ' is-protected' : ''}`;
    seg.style.flexGrow = String(Math.max(Number(p.size) || 1, 1));
    seg.style.background = p.protected ? '#3a4149' : SEG_COLORS[i % SEG_COLORS.length];
    seg.title = `${p.driveLetter ? p.driveLetter + ': ' : ''}${p.label || p.type} — ${formatBytes(p.size)}`;
    const segLabel = document.createElement('span');
    segLabel.className = 'disk-seg-label';
    segLabel.textContent = p.driveLetter ? `${p.driveLetter}:` : p.type.slice(0, 4);
    seg.append(segLabel);
    bar.append(seg);
  });
  if (disk.unallocated > 1e7) {
    const free = document.createElement('div');
    free.className = 'disk-seg is-free';
    free.style.flexGrow = String(disk.unallocated);
    free.title = `Unallocated — ${formatBytes(disk.unallocated)}`;
    bar.append(free);
  }
  card.append(bar);

  // Partition rows.
  const list = document.createElement('div');
  list.className = 'disk-parts';
  for (const p of disk.partitions) list.append(partitionRow(disk, p));
  card.append(list);

  return card;
}

function partitionRow(disk, p) {
  const admin = state.admin;
  const row = document.createElement('div');
  row.className = 'row';

  const main = document.createElement('div');
  main.className = 'row-main';
  const name = document.createElement('div');
  name.className = 'row-name';
  name.textContent = `${p.driveLetter ? `${p.driveLetter}:  ` : ''}${p.label || p.type}`;
  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.textContent = [
    formatBytes(p.size),
    p.fileSystem || null,
    p.used != null ? `${formatBytes(p.used)} used · ${formatBytes(p.free)} free` : null,
    `type ${p.type}`,
  ]
    .filter(Boolean)
    .join('  ·  ');
  main.append(name, meta);
  if (p.used != null && p.size) {
    const bar = document.createElement('div');
    bar.className = 'part-usebar';
    const fill = document.createElement('div');
    fill.className = 'part-usebar-fill';
    const pct = Math.round((p.used / p.size) * 100);
    fill.style.width = `${pct}%`;
    if (pct >= 90) fill.classList.add('is-full');
    bar.append(fill);
    main.append(bar);
  }

  const tags = document.createElement('div');
  tags.className = 'row-tags';
  if (p.protected) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = 'Protected';
    t.title = 'System, boot, EFI or recovery — not editable here.';
    tags.append(t);
  }

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const mkBtn = (label, handler, disabled, title) => {
    const b = document.createElement('button');
    b.className = 'btn btn-ghost btn-small';
    b.textContent = label;
    b.disabled = !admin || disabled;
    b.title = !admin ? 'Restart as administrator to change partitions.' : title || '';
    b.addEventListener('click', handler);
    return b;
  };

  actions.append(
    mkBtn('Change letter', async () => {
      const letter = await promptText({
        title: `Drive letter for ${p.label || p.type}`,
        label: 'New drive letter (A–Z)',
        value: p.driveLetter || '',
        maxLength: 1,
        confirmLabel: 'Change',
      });
      if (letter == null) return;
      try {
        await window.pc.disks.setLetter(disk.number, p.partitionNumber, letter);
        toast(`Drive letter changed to ${letter.toUpperCase()}:.`, 'good');
        loadDisks();
      } catch (error) {
        toast(error.message, 'error');
      }
    }, p.protected, p.protected ? 'Protected partition.' : '')
  );

  actions.append(
    mkBtn('Rename', async () => {
      const label = await promptText({
        title: `Rename ${p.driveLetter}:`,
        label: 'Volume label',
        value: p.label || '',
        maxLength: 32,
        confirmLabel: 'Rename',
      });
      if (label == null) return;
      try {
        await window.pc.disks.setLabel(disk.number, p.partitionNumber, label);
        toast(`Renamed to “${label}”.`, 'good');
        loadDisks();
      } catch (error) {
        toast(error.message, 'error');
      }
    }, !p.driveLetter, !p.driveLetter ? 'No drive letter to label.' : '')
  );

  row.append(main, tags, actions);
  return row;
}

function renderDisks() {
  const body = $('disks-body');
  const data = state.disks.data;
  const banner = $('disks-banner');
  banner.replaceChildren();
  if (!state.admin) {
    const b = document.createElement('div');
    b.className = 'ar-summary is-warn';
    const lead = document.createElement('div');
    lead.className = 'ar-summary-lead';
    lead.textContent = 'Read-only — not running as administrator';
    const sub = document.createElement('div');
    sub.className = 'ar-summary-sub';
    sub.textContent = 'You can see the layout, but changing a drive letter or label needs admin.';
    b.append(lead, sub);
    banner.append(b);
  }
  if (!data) {
    body.replaceChildren(empty('Reading disks…'));
    return;
  }
  body.replaceChildren();
  for (const disk of data.disks) body.append(diskCard(disk));
  $('disks-subtitle').textContent = `${data.summary.disks} disk${data.summary.disks === 1 ? '' : 's'} · Windows on ${data.summary.systemDrive}`;
}

async function loadDisks() {
  state.disks.loaded = false;
  renderDisks();
  try {
    state.disks.data = await window.pc.disks.read();
    state.disks.loaded = true;
    renderDisks();
  } catch (error) {
    state.disks.loaded = true;
    $('disks-body').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('disks-refresh').addEventListener('click', loadDisks);

/* Wi-Fi keys --------------------------------------------------------------- */

function wifiRow(p) {
  const row = document.createElement('div');
  row.className = 'row';
  const main = document.createElement('div');
  main.className = 'row-main';
  const name = document.createElement('div');
  name.className = 'row-name';
  name.textContent = p.name;
  const meta = document.createElement('div');
  meta.className = 'row-meta wifi-key';
  const revealed = state.wifi.revealed.has(p.name);
  if (p.open) {
    meta.textContent = 'Open network · no password';
  } else if (!p.hasKey) {
    meta.textContent = `${p.auth || 'Secured'} · password hidden (needs admin)`;
  } else {
    meta.textContent = `${p.auth || 'Secured'} · ${revealed ? p.key : '•'.repeat(Math.min(12, p.key.length || 8))}`;
  }
  main.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  if (p.hasKey) {
    const show = document.createElement('button');
    show.className = 'btn btn-ghost btn-small';
    show.textContent = revealed ? 'Hide' : 'Show';
    show.addEventListener('click', () => {
      if (state.wifi.revealed.has(p.name)) state.wifi.revealed.delete(p.name);
      else state.wifi.revealed.add(p.name);
      renderWifi();
    });
    const copy = document.createElement('button');
    copy.className = 'btn btn-ghost btn-small';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await window.pc.copyText(p.key);
        toast(`Copied the password for ${p.name}.`, 'good');
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    actions.append(show, copy);
  }
  row.append(main, actions);
  return row;
}

function renderWifi() {
  const body = $('wifi-body');
  const banner = $('wifi-banner');
  banner.replaceChildren();
  const data = state.wifi.data;
  if (!data) {
    body.replaceChildren(empty('Reading saved networks…'));
    return;
  }
  if (!data.supported) {
    body.replaceChildren(empty('No Wi-Fi adapter on this machine, or the WLAN service is off.'));
    $('wifi-subtitle').textContent = 'No wireless on this machine.';
    return;
  }
  if (data.adminNeeded) {
    const b = document.createElement('div');
    b.className = 'ar-summary is-warn';
    const lead = document.createElement('div');
    lead.className = 'ar-summary-lead';
    lead.textContent = 'Passwords hidden — not running as administrator';
    const sub = document.createElement('div');
    sub.className = 'ar-summary-sub';
    sub.textContent = 'The networks are listed, but Windows only reveals the saved keys to an administrator. Restart as admin to see them.';
    b.append(lead, sub);
    banner.append(b);
  }

  const term = state.wifi.search.trim().toLowerCase();
  const profiles = data.profiles.filter((p) => !term || p.name.toLowerCase().includes(term));
  body.replaceChildren();
  if (!profiles.length) {
    body.replaceChildren(empty(term ? 'No networks match.' : 'No saved Wi-Fi networks.'));
  } else {
    const list = document.createElement('div');
    list.className = 'sec-list';
    for (const p of profiles) list.append(wifiRow(p));
    body.append(list);
  }
  $('wifi-subtitle').textContent = `${data.profiles.length} saved network${data.profiles.length === 1 ? '' : 's'} on this PC`;
}

async function loadWifi() {
  state.wifi.loaded = false;
  state.wifi.revealed = new Set();
  renderWifi();
  try {
    state.wifi.data = await window.pc.wifi();
    state.wifi.loaded = true;
    renderWifi();
  } catch (error) {
    state.wifi.loaded = true;
    $('wifi-body').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('wifi-refresh').addEventListener('click', loadWifi);
$('wifi-search').addEventListener('input', (event) => {
  state.wifi.search = event.target.value;
  if (state.wifi.data) renderWifi();
});

/* Ghost devices ------------------------------------------------------------ */

function updateGhostRemoveButton() {
  const btn = $('ghosts-remove');
  const n = state.ghosts.selected.size;
  btn.disabled = !state.admin || n === 0 || state.ghosts.busy;
  btn.textContent = state.ghosts.busy ? 'Removing…' : n ? `Remove selected (${n})` : 'Remove selected';
  btn.title = !state.admin ? 'Restart as administrator to remove devices.' : '';
}

function ghostRow(dev) {
  const row = document.createElement('label');
  row.className = 'row ghost-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'ghost-cb';
  cb.checked = state.ghosts.selected.has(dev.instanceId);
  cb.disabled = !state.admin;
  cb.addEventListener('change', () => {
    if (cb.checked) state.ghosts.selected.add(dev.instanceId);
    else state.ghosts.selected.delete(dev.instanceId);
    updateGhostRemoveButton();
    syncGhostAllCheckbox();
  });
  const main = document.createElement('div');
  main.className = 'row-main';
  const name = document.createElement('div');
  name.className = 'row-name';
  name.textContent = dev.name;
  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.textContent = dev.instanceId;
  main.append(name, meta);
  row.append(cb, main);
  return row;
}

function syncGhostAllCheckbox() {
  const data = state.ghosts.data;
  if (!data) return;
  const all = data.total > 0 && state.ghosts.selected.size === data.total;
  $('ghosts-all').checked = all;
}

function renderGhosts() {
  const body = $('ghosts-body');
  const banner = $('ghosts-banner');
  banner.replaceChildren();
  if (!state.admin) {
    const b = document.createElement('div');
    b.className = 'ar-summary is-warn';
    const lead = document.createElement('div');
    lead.className = 'ar-summary-lead';
    lead.textContent = 'Read-only — not running as administrator';
    const sub = document.createElement('div');
    sub.className = 'ar-summary-sub';
    sub.textContent = 'You can see the ghost devices, but removing them needs admin.';
    b.append(lead, sub);
    banner.append(b);
  }
  updateGhostRemoveButton();

  const data = state.ghosts.data;
  if (!data) {
    body.replaceChildren(empty('Looking for non-present devices…'));
    return;
  }
  if (!data.total) {
    body.replaceChildren(empty('No ghost devices — nothing left behind.'));
    $('ghosts-subtitle').textContent = 'Nothing to clean up.';
    return;
  }

  body.replaceChildren();
  for (const group of data.groups) {
    const box = document.createElement('div');
    box.className = 'dev-group';
    const open = state.ghosts.openGroups.has(group.label);
    if (open) box.classList.add('open');
    const head = document.createElement('div');
    head.className = 'dev-group-head';
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '▶';
    const cls = document.createElement('span');
    cls.className = 'cls';
    cls.textContent = group.label;
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = `${group.items.length}`;
    head.append(chev, cls, cnt);
    const wrap = document.createElement('div');
    wrap.hidden = !open;
    for (const dev of group.items) wrap.append(ghostRow(dev));
    head.addEventListener('click', () => {
      const nowOpen = !box.classList.contains('open');
      box.classList.toggle('open', nowOpen);
      wrap.hidden = !nowOpen;
      if (nowOpen) state.ghosts.openGroups.add(group.label);
      else state.ghosts.openGroups.delete(group.label);
    });
    box.append(head, wrap);
    body.append(box);
  }

  $('ghosts-subtitle').textContent = `${data.total} non-present device${data.total === 1 ? '' : 's'} across ${data.groups.length} categor${data.groups.length === 1 ? 'y' : 'ies'}`;
  $('nav-ghosts-count').textContent = data.total ? String(data.total) : '';
  syncGhostAllCheckbox();
}

async function loadGhosts() {
  state.ghosts.loaded = false;
  state.ghosts.selected = new Set();
  renderGhosts();
  try {
    state.ghosts.data = await window.pc.ghosts.list();
    state.ghosts.loaded = true;
    renderGhosts();
  } catch (error) {
    state.ghosts.loaded = true;
    $('ghosts-body').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('ghosts-refresh').addEventListener('click', loadGhosts);
$('ghosts-all').addEventListener('change', (event) => {
  const data = state.ghosts.data;
  if (!data) return;
  state.ghosts.selected = new Set();
  if (event.target.checked) for (const g of data.groups) for (const d of g.items) state.ghosts.selected.add(d.instanceId);
  renderGhosts();
});
/* Health report ------------------------------------------------------------ */

function reportKv(pairs) {
  const list = document.createElement('div');
  list.className = 'sec-list';
  for (const [k, v] of pairs) {
    if (v == null || v === '') continue;
    const rowEl = document.createElement('div');
    rowEl.className = 'sec-check';
    const main = document.createElement('div');
    main.className = 'sec-main';
    const label = document.createElement('div');
    label.className = 'sec-label';
    label.textContent = k;
    main.append(label);
    const val = document.createElement('div');
    val.className = 'sec-value';
    val.textContent = v;
    rowEl.append(main, val);
    list.append(rowEl);
  }
  return list;
}

function reportGib(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '—';
  const gb = n / 1e9;
  return gb >= 1000 ? `${(gb / 1000).toFixed(2)} TB` : `${Math.round(gb)} GB`;
}

function renderReport() {
  const body = $('report-body');
  const data = state.report.data;
  const ready = Boolean(data);
  $('report-save').disabled = !ready;
  $('report-open').disabled = !ready;
  if (!ready) {
    body.replaceChildren(empty('Gathering the machine’s details…'));
    return;
  }

  body.replaceChildren();
  const sys = data.sys || {};
  const os = sys.os || {};
  const machine = sys.machine || {};
  const cpu = sys.cpu || {};
  const mem = sys.memory || {};
  const act = sys.activation || {};
  const sec = data.security || {};

  // Overall badge
  const summary = sec.summary || {};
  const tone = summary.bad ? 'is-bad' : summary.warn ? 'is-warn' : 'is-good';
  const card = document.createElement('div');
  card.className = `sec-summary ${tone}`;
  const lead = document.createElement('div');
  lead.className = 'sec-summary-lead';
  lead.textContent = summary.bad ? 'Needs attention' : summary.warn ? 'A few things to check' : 'Healthy';
  const sub = document.createElement('div');
  sub.className = 'sec-summary-sub';
  sub.textContent = `${os.caption || 'Windows'} · ${machine.model || machine.manufacturer || 'PC'} · report snapshot`;
  card.append(lead, sub);
  body.append(card);

  const addTitle = (t) => {
    const el = document.createElement('div');
    el.className = 'group-title';
    el.textContent = t;
    body.append(el);
  };

  addTitle('System');
  body.append(
    reportKv([
      ['Windows', `${os.caption || ''}${os.build ? ` (build ${os.build})` : ''}`],
      ['Activation', act.status ? `${act.status}${act.partialKey ? ` · …${act.partialKey}` : ''}` : ''],
      ['Make / model', [machine.manufacturer, machine.model].filter(Boolean).join(' · ')],
      ['Processor', cpu.name],
      ['Memory', reportGib(mem.total) + (mem.slotsUsed ? ` · ${mem.slotsUsed}/${mem.slotsTotal} slots` : '')],
    ])
  );

  const disks = sys.disks || [];
  if (disks.length) {
    addTitle('Storage health');
    body.append(reportKv(disks.map((d) => [`${d.name} (${d.media || '?'})`, `${reportGib(d.size)} · ${d.health || 'Unknown'}`])));
  }

  const ev = (data.events && data.events.summary) || null;
  if (ev) {
    addTitle('Stability');
    body.append(
      reportKv([
        ['Blue screens (45 days)', String(ev.bsod ?? 0)],
        ['Crashes / app crashes', `${ev.crash ?? 0} / ${ev.appcrash ?? 0}`],
        [`Errors (last ${ev.days || 14} days)`, String(ev.errors ?? 0)],
      ])
    );
  }

  if (sec.sections) {
    addTitle('Security');
    for (const section of sec.sections) {
      const list = document.createElement('div');
      list.className = 'sec-list';
      for (const c of section.checks) list.append(securityCheckRow(c));
      body.append(list);
    }
  }

  const bat = data.battery;
  if (bat && bat.present) {
    addTitle('Battery');
    body.append(reportKv([['Health', bat.wearPct != null ? `${100 - bat.wearPct}% of original (${bat.wearPct}% worn)` : 'not reported'], ['Cycles', String(bat.cycleCount || '—')]]));
  }

  $('report-subtitle').textContent = `Snapshot of ${os.computerName || sys.hostname || 'this PC'} · ready to save or print`;
}

async function loadReport() {
  state.report.loaded = false;
  renderReport();
  try {
    state.report.data = await window.pc.report.gather();
    state.report.loaded = true;
    renderReport();
  } catch (error) {
    state.report.loaded = true;
    $('report-body').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('report-save').addEventListener('click', async () => {
  try {
    const r = await window.pc.report.save();
    if (r && r.canceled) return;
    toast(`Report saved to ${r.path}`, 'good');
  } catch (error) {
    toast(error.message, 'error');
  }
});
$('report-open').addEventListener('click', async () => {
  try {
    await window.pc.report.open();
    toast('Report opened in your browser.', 'good');
  } catch (error) {
    toast(error.message, 'error');
  }
});

/* Explorer tweaks ---------------------------------------------------------- */

function renderExplorer() {
  const body = $('explorer-body');
  const g = state.explorer.gallery;
  if (!g) {
    body.replaceChildren(empty('Reading Explorer settings…'));
    return;
  }

  body.replaceChildren();
  const card = document.createElement('div');
  card.className = 'tweak-card';

  const head = document.createElement('div');
  head.className = 'tweak-head';
  const title = document.createElement('div');
  title.className = 'tweak-title';
  title.textContent = 'File Explorer Gallery';
  const stateTag = document.createElement('span');
  if (!g.supported) {
    stateTag.className = 'tag';
    stateTag.textContent = 'Windows 11 only';
  } else {
    stateTag.className = `tag ${g.hidden ? 'tag-warn' : ''}`;
    stateTag.textContent = g.hidden ? 'Hidden' : 'Showing';
  }
  head.append(title, stateTag);

  const desc = document.createElement('div');
  desc.className = 'tweak-desc';
  desc.textContent = g.supported
    ? 'Windows 11 pins a "Gallery" photo view to the File Explorer sidebar. Hide it to declutter the navigation pane — it is a per-user change you can restore any time, no admin needed.'
    : `The File Explorer Gallery is a Windows 11 feature. This PC is on build ${g.build}, so there is nothing to remove here.`;

  const actions = document.createElement('div');
  actions.className = 'tweak-actions';
  const toggleBtn = document.createElement('button');
  toggleBtn.className = `btn ${g.hidden ? 'btn-ghost' : 'btn-primary'}`;
  toggleBtn.textContent = state.explorer.busy ? 'Working…' : g.hidden ? 'Restore Gallery' : 'Hide Gallery';
  toggleBtn.disabled = !g.supported || state.explorer.busy;
  toggleBtn.addEventListener('click', async () => {
    state.explorer.busy = true;
    renderExplorer();
    try {
      await window.pc.tweaks.setGalleryHidden(!g.hidden);
      state.explorer.gallery = await window.pc.tweaks.galleryStatus();
      state.explorer.dirty = true;
      toast(`Gallery ${g.hidden ? 'restored' : 'hidden'}.`, 'good');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      state.explorer.busy = false;
      renderExplorer();
    }
  });
  actions.append(toggleBtn);

  card.append(head, desc, actions);

  // Once changed, the pane only updates when Explorer reloads.
  if (state.explorer.dirty) {
    const applyRow = document.createElement('div');
    applyRow.className = 'tweak-apply';
    const note = document.createElement('span');
    note.textContent = 'Restart File Explorer to see the change.';
    const restart = document.createElement('button');
    restart.className = 'btn btn-ghost btn-small';
    restart.textContent = 'Restart Explorer';
    restart.addEventListener('click', async () => {
      try {
        await window.pc.tweaks.restartExplorer();
        state.explorer.dirty = false;
        toast('File Explorer restarted.', 'good');
        renderExplorer();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    applyRow.append(note, restart);
    card.append(applyRow);
  }

  body.append(card);
}

async function loadExplorer() {
  state.explorer.loaded = false;
  state.explorer.dirty = false;
  renderExplorer();
  try {
    state.explorer.gallery = await window.pc.tweaks.galleryStatus();
    state.explorer.loaded = true;
    renderExplorer();
  } catch (error) {
    state.explorer.loaded = true;
    $('explorer-body').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('explorer-refresh').addEventListener('click', loadExplorer);

/* BitLocker ---------------------------------------------------------------- */

async function bitlockerAction(vol, action, confirmOpts) {
  if (state.bitlocker.busy) return;
  if (confirmOpts) {
    const ok = await confirmAction(confirmOpts);
    if (!ok) return;
  }
  state.bitlocker.busy = true;
  renderBitlocker();
  try {
    await window.pc.bitlocker[action](vol.mount);
    toast(`${vol.mount} — ${action} done.`, 'good');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.bitlocker.busy = false;
    state.bitlocker.data = await window.pc.bitlocker.status().catch(() => state.bitlocker.data);
    renderBitlocker();
  }
}

function bitlockerVolumeCard(vol) {
  const card = document.createElement('div');
  card.className = 'bl-card';

  const head = document.createElement('div');
  head.className = 'bl-head';
  const title = document.createElement('div');
  title.className = 'bl-title';
  title.textContent = `${vol.mount}${vol.isOs ? '  ·  System drive' : ''}`;
  const tags = document.createElement('div');
  tags.className = 'row-tags';
  const addTag = (text, cls) => {
    const t = document.createElement('span');
    t.className = `tag${cls ? ` ${cls}` : ''}`;
    t.textContent = text;
    tags.append(t);
  };
  const encrypted = /fullyencrypted/i.test(vol.volumeStatus) || /encryptioninprogress|encryptionpaused/i.test(vol.volumeStatus);
  const decrypted = /fullydecrypted/i.test(vol.volumeStatus);
  if (decrypted) addTag('Not encrypted');
  else if (vol.protectionOn) addTag('Protected', 'tag-scope-public');
  else if (encrypted) addTag('Suspended', 'tag-warn');
  if (vol.locked) addTag('Locked', 'tag-warn');
  head.append(title, tags);
  card.append(head);

  const meta = document.createElement('div');
  meta.className = 'bl-meta';
  meta.textContent = [vol.volumeStatus, vol.method, vol.protectorTypes.join(', ')].filter(Boolean).join('  ·  ');
  card.append(meta);

  // Progress bar while (de)encrypting.
  if (/inprogress/i.test(vol.volumeStatus) && vol.percent) {
    const bar = document.createElement('div');
    bar.className = 'bl-bar';
    const fill = document.createElement('div');
    fill.className = 'bl-bar-fill';
    fill.style.width = `${vol.percent}%`;
    bar.append(fill);
    card.append(bar);
    const pct = document.createElement('div');
    pct.className = 'bl-meta';
    pct.textContent = `${vol.percent}% ${/decryption/i.test(vol.volumeStatus) ? 'decrypted' : 'encrypted'}`;
    card.append(pct);
  }

  // Recovery keys — masked, per key.
  for (const k of vol.recoveryKeys) {
    const keyRow = document.createElement('div');
    keyRow.className = 'bl-key';
    const label = document.createElement('div');
    label.className = 'bl-key-label';
    const revealed = state.bitlocker.revealed.has(k.id);
    label.textContent = `Recovery key  ·  ${revealed ? k.key : '•'.repeat(12) + '  (ID ' + (k.id || '').slice(0, 8) + '…)'}`;
    const btns = document.createElement('div');
    btns.className = 'row-actions';
    const show = document.createElement('button');
    show.className = 'btn btn-ghost btn-small';
    show.textContent = revealed ? 'Hide' : 'Show';
    show.addEventListener('click', () => {
      if (state.bitlocker.revealed.has(k.id)) state.bitlocker.revealed.delete(k.id);
      else state.bitlocker.revealed.add(k.id);
      renderBitlocker();
    });
    const copy = document.createElement('button');
    copy.className = 'btn btn-ghost btn-small';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try { await window.pc.copyText(k.key); toast(`Copied the recovery key for ${vol.mount}.`, 'good'); } catch (e) { toast(e.message, 'error'); }
    });
    btns.append(show, copy);
    keyRow.append(label, btns);
    card.append(keyRow);
  }

  // Actions.
  const actions = document.createElement('div');
  actions.className = 'bl-actions';
  const mkBtn = (label, cls, handler) => {
    const b = document.createElement('button');
    b.className = `btn ${cls} btn-small`;
    b.textContent = label;
    b.disabled = state.bitlocker.busy;
    b.addEventListener('click', handler);
    return b;
  };
  if (vol.protectionOn) {
    actions.append(mkBtn('Suspend protection', 'btn-ghost', () =>
      bitlockerAction(vol, 'suspend', {
        title: `Suspend BitLocker on ${vol.mount}?`,
        body: 'Protection pauses until you resume it — the drive stays encrypted but will not ask for a key on reboot. Use this before a BIOS/firmware update, then resume when done.',
        confirmLabel: 'Suspend',
        danger: false,
      })
    ));
  } else if (encrypted) {
    actions.append(mkBtn('Resume protection', 'btn-primary', () => bitlockerAction(vol, 'resume', null)));
  }
  if (encrypted || vol.protectionOn) {
    actions.append(mkBtn('Turn off (decrypt)', 'btn-ghost btn-danger-text', () =>
      bitlockerAction(vol, 'decrypt', {
        title: `Turn off BitLocker on ${vol.mount}?`,
        body: 'This decrypts the whole drive — your files are kept, but the drive will no longer be encrypted. It runs in the background and can take a while on a large disk.',
        confirmLabel: 'Turn off',
        danger: true,
      })
    ));
  }
  if (actions.children.length) card.append(actions);

  return card;
}

function renderBitlocker() {
  const body = $('bitlocker-body');
  const banner = $('bitlocker-banner');
  banner.replaceChildren();
  const data = state.bitlocker.data;

  if (!data) {
    body.replaceChildren(empty('Reading BitLocker status…'));
    $('bitlocker-savekeys').hidden = true;
    return;
  }
  if (!data.supported) {
    body.replaceChildren(empty('BitLocker is not available on this edition of Windows (it needs Pro or better).'));
    $('bitlocker-subtitle').textContent = 'Not available on this edition.';
    $('bitlocker-savekeys').hidden = true;
    return;
  }
  if (data.adminNeeded) {
    const b = document.createElement('div');
    b.className = 'ar-summary is-warn';
    const lead = document.createElement('div');
    lead.className = 'ar-summary-lead';
    lead.textContent = 'Needs administrator rights';
    const sub = document.createElement('div');
    sub.className = 'ar-summary-sub';
    sub.textContent = 'Windows only reveals BitLocker status and recovery keys to an administrator. Restart as admin from the banner on the left.';
    b.append(lead, sub);
    banner.append(b);
    body.replaceChildren();
    $('bitlocker-subtitle').textContent = 'Restart as admin to read BitLocker.';
    $('bitlocker-savekeys').hidden = true;
    return;
  }

  const anyKeys = data.volumes.some((v) => v.recoveryKeys && v.recoveryKeys.length);
  $('bitlocker-savekeys').hidden = !anyKeys;

  body.replaceChildren();
  if (!data.volumes.length) {
    body.replaceChildren(empty('No BitLocker-capable volumes found.'));
  } else {
    for (const v of data.volumes) body.append(bitlockerVolumeCard(v));
  }
  const encd = data.volumes.filter((v) => v.protectionOn).length;
  $('bitlocker-subtitle').textContent = `${data.volumes.length} volume${data.volumes.length === 1 ? '' : 's'} · ${encd} protected`;
}

async function loadBitlocker() {
  state.bitlocker.loaded = false;
  state.bitlocker.revealed = new Set();
  renderBitlocker();
  try {
    state.bitlocker.data = await window.pc.bitlocker.status();
    state.bitlocker.loaded = true;
    renderBitlocker();
  } catch (error) {
    state.bitlocker.loaded = true;
    $('bitlocker-body').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('bitlocker-refresh').addEventListener('click', loadBitlocker);

/* Update ------------------------------------------------------------------- */

function renderUpdate() {
  const body = $('update-body');
  const cfg = state.update.config;
  if (!cfg) {
    body.replaceChildren(empty('Loading…'));
    return;
  }
  body.replaceChildren();

  // Current version + source config.
  const card = document.createElement('div');
  card.className = 'tweak-card';
  const ver = document.createElement('div');
  ver.className = 'bl-meta';
  ver.textContent = `This copy: BOB ${cfg.current}${cfg.portable ? '' : '  ·  running from source (self-update needs the portable BOB.exe)'}`;
  card.append(ver);

  const field = document.createElement('label');
  field.className = 'acct-field';
  field.style.marginTop = '12px';
  const flabel = document.createElement('span');
  flabel.textContent = 'Update source — a web link (https://…) or a shared/synced folder where the new BOB is published';
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'update-source';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'https://example.com/bob   or   \\\\server\\share\\BOB';
  input.value = cfg.source || '';
  field.append(flabel, input);
  card.append(field);

  const saveRow = document.createElement('div');
  saveRow.className = 'tweak-actions';
  saveRow.style.marginTop = '12px';
  const save = document.createElement('button');
  save.className = 'btn btn-ghost btn-small';
  save.textContent = 'Save source';
  save.addEventListener('click', async () => {
    try {
      state.update.config = await window.pc.update.setSource($('update-source').value);
      state.update.result = null;
      state.update.status = 'Source saved.';
      renderUpdate();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  saveRow.append(save);
  card.append(saveRow);
  body.append(card);

  // Progress bar during download.
  if (state.update.busy && state.update.progress) {
    const p = state.update.progress;
    const prog = document.createElement('div');
    prog.className = 'tweak-card';
    const lbl = document.createElement('div');
    lbl.className = 'bl-meta';
    const pct = p.total ? Math.round((p.got / p.total) * 100) : 0;
    lbl.textContent = p.phase === 'restart' ? 'Installing — BOB will restart…' : `Downloading… ${p.total ? `${pct}% (${formatBytes(p.got)} of ${formatBytes(p.total)})` : formatBytes(p.got || 0)}`;
    const bar = document.createElement('div');
    bar.className = 'bl-bar';
    const fill = document.createElement('div');
    fill.className = 'bl-bar-fill';
    fill.style.width = `${pct}%`;
    bar.append(fill);
    prog.append(lbl, bar);
    body.append(prog);
  }

  // Result of a check.
  const r = state.update.result;
  if (r) {
    const rc = document.createElement('div');
    rc.className = `ar-summary ${r.newer ? 'is-warn' : 'is-good'}`;
    const lead = document.createElement('div');
    lead.className = 'ar-summary-lead';
    lead.textContent = r.newer
      ? `Update available — BOB ${r.latest}`
      : r.noRelease
        ? 'No update published yet'
        : `Up to date (BOB ${r.current})`;
    const sub = document.createElement('div');
    sub.className = 'ar-summary-sub';
    sub.textContent = r.newer
      ? [r.date && `Released ${r.date}`, r.notes].filter(Boolean).join(' · ') || 'A newer version is published at your source.'
      : r.noRelease
        ? `Nothing has been published to the update source yet — you're on BOB ${r.current}.`
        : 'This is the latest version published at your source.';
    rc.append(lead, sub);
    if (r.newer) {
      const act = document.createElement('div');
      act.className = 'tweak-actions';
      act.style.marginTop = '12px';
      const install = document.createElement('button');
      install.className = 'btn btn-primary';
      install.textContent = state.update.busy ? 'Installing…' : `Download & install ${r.latest}`;
      install.disabled = state.update.busy || !cfg.portable;
      install.title = cfg.portable ? '' : 'Self-update needs the portable BOB.exe.';
      install.addEventListener('click', doUpdateApply);
      act.append(install);
      rc.append(act);
    }
    body.append(rc);
  } else if (state.update.status) {
    const s = document.createElement('div');
    s.className = 'bl-meta';
    s.style.marginTop = '12px';
    s.textContent = state.update.status;
    body.append(s);
  }

  $('nav-update-count').textContent = r && r.newer ? '1' : '';
  $('update-check').disabled = state.update.busy;
}

async function doUpdateCheck() {
  state.update.busy = true;
  state.update.status = 'Checking…';
  state.update.result = null;
  renderUpdate();
  try {
    state.update.result = await window.pc.update.check();
    state.update.status = '';
  } catch (error) {
    state.update.status = error.message;
  } finally {
    state.update.busy = false;
    renderUpdate();
  }
}

async function doUpdateApply() {
  const ok = await confirmAction({
    title: `Install BOB ${state.update.result.latest}?`,
    body: 'BOB will download the new version, check it, then close and reopen as the new version. Save any work in BOB first.',
    confirmLabel: 'Install',
    danger: false,
  });
  if (!ok) return;
  state.update.busy = true;
  state.update.progress = { phase: 'download', got: 0, total: 0 };
  renderUpdate();
  try {
    await window.pc.update.apply();
    // The app quits itself on success; if we are still here, show a note.
    state.update.status = 'Installing — BOB is restarting…';
  } catch (error) {
    state.update.busy = false;
    state.update.progress = null;
    toast(error.message, 'error');
    renderUpdate();
  }
}

async function loadUpdate() {
  try {
    state.update.config = await window.pc.update.config();
    state.update.loaded = true;
    renderUpdate();
  } catch (error) {
    $('update-body').replaceChildren(empty(error.message));
  }
}

window.pc.update.onProgress((p) => {
  state.update.progress = p;
  if (state.update.loaded) renderUpdate();
});

$('update-check').addEventListener('click', doUpdateCheck);
$('bitlocker-savekeys').addEventListener('click', async () => {
  try {
    const r = await window.pc.bitlocker.saveKeys();
    if (r && r.canceled) return;
    toast(`Saved recovery keys for ${r.count} volume${r.count === 1 ? '' : 's'} to ${r.path}`, 'good');
  } catch (error) {
    toast(error.message, 'error');
  }
});

/* Hardware test bench ------------------------------------------------------ */

const KB_LAYOUT = [
  [['Escape', 'Esc'], ['F1', 'F1'], ['F2', 'F2'], ['F3', 'F3'], ['F4', 'F4'], ['F5', 'F5'], ['F6', 'F6'], ['F7', 'F7'], ['F8', 'F8'], ['F9', 'F9'], ['F10', 'F10'], ['F11', 'F11'], ['F12', 'F12']],
  [['Backquote', '`'], ['Digit1', '1'], ['Digit2', '2'], ['Digit3', '3'], ['Digit4', '4'], ['Digit5', '5'], ['Digit6', '6'], ['Digit7', '7'], ['Digit8', '8'], ['Digit9', '9'], ['Digit0', '0'], ['Minus', '-'], ['Equal', '='], ['Backspace', '⌫', 2]],
  [['Tab', 'Tab', 1.5], ['KeyQ', 'Q'], ['KeyW', 'W'], ['KeyE', 'E'], ['KeyR', 'R'], ['KeyT', 'T'], ['KeyY', 'Y'], ['KeyU', 'U'], ['KeyI', 'I'], ['KeyO', 'O'], ['KeyP', 'P'], ['BracketLeft', '['], ['BracketRight', ']'], ['Backslash', '\\', 1.5]],
  [['CapsLock', 'Caps', 1.8], ['KeyA', 'A'], ['KeyS', 'S'], ['KeyD', 'D'], ['KeyF', 'F'], ['KeyG', 'G'], ['KeyH', 'H'], ['KeyJ', 'J'], ['KeyK', 'K'], ['KeyL', 'L'], ['Semicolon', ';'], ['Quote', "'"], ['Enter', 'Enter', 2.2]],
  [['ShiftLeft', 'Shift', 2.3], ['KeyZ', 'Z'], ['KeyX', 'X'], ['KeyC', 'C'], ['KeyV', 'V'], ['KeyB', 'B'], ['KeyN', 'N'], ['KeyM', 'M'], ['Comma', ','], ['Period', '.'], ['Slash', '/'], ['ShiftRight', 'Shift', 2.7]],
  [['ControlLeft', 'Ctrl', 1.4], ['MetaLeft', 'Win', 1.2], ['AltLeft', 'Alt', 1.2], ['Space', 'Space', 6], ['AltRight', 'Alt', 1.2], ['ControlRight', 'Ctrl', 1.4], ['ArrowLeft', '←'], ['ArrowUp', '↑'], ['ArrowDown', '↓'], ['ArrowRight', '→']],
];

const hwKbTested = new Set();

function buildKeyboard() {
  const kb = $('hw-kb');
  kb.replaceChildren();
  for (const rowDef of KB_LAYOUT) {
    const row = document.createElement('div');
    row.className = 'hw-kb-row';
    for (const [code, label, width] of rowDef) {
      const key = document.createElement('div');
      key.className = 'hw-key';
      key.dataset.code = code;
      key.textContent = label;
      if (width) key.style.flexGrow = String(width);
      row.append(key);
    }
    kb.append(row);
  }
  updateKbCount();
}

function updateKbCount() {
  $('hw-kb-count').textContent = hwKbTested.size ? `· ${hwKbTested.size} keys OK` : '';
}

function hwKeyDown(e) {
  const el = document.querySelector(`.hw-key[data-code="${CSS.escape(e.code)}"]`);
  if (el) {
    el.classList.add('down', 'tested');
    hwKbTested.add(e.code);
    updateKbCount();
  }
  // Swallow keys that would otherwise act (Tab/Space/arrows/F-keys) while testing.
  if (document.getElementById('view-hwtest').classList.contains('is-active')) e.preventDefault();
}

function hwKeyUp(e) {
  const el = document.querySelector(`.hw-key[data-code="${CSS.escape(e.code)}"]`);
  if (el) el.classList.remove('down');
}

// --- Screen test ---
const HW_COLORS = ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#7f7f7f', '#ffff00', '#00ffff', '#ff00ff'];
let hwColorIdx = 0;

function hwScreenNext() {
  hwColorIdx = (hwColorIdx + 1) % HW_COLORS.length;
  $('hw-screen-overlay').style.background = HW_COLORS[hwColorIdx];
}

function hwScreenExit() {
  const ov = $('hw-screen-overlay');
  ov.hidden = true;
  ov.removeEventListener('click', hwScreenNext);
  document.removeEventListener('keydown', hwScreenKey, true);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function hwScreenKey(e) {
  if (e.key === 'Escape') { hwScreenExit(); e.preventDefault(); }
  else if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'Enter') { hwScreenNext(); e.preventDefault(); }
}

function hwScreenStart() {
  hwColorIdx = 0;
  const ov = $('hw-screen-overlay');
  ov.hidden = false;
  ov.style.background = HW_COLORS[0];
  ov.addEventListener('click', hwScreenNext);
  document.addEventListener('keydown', hwScreenKey, true);
  ov.requestFullscreen().catch(() => {}); // covering overlay works even if this is refused
}

// --- Speakers ---
function hwTone(channel) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();
    osc.type = 'sine';
    osc.frequency.value = 660;
    gain.gain.value = 0.12;
    panner.pan.value = channel === 'left' ? -1 : channel === 'right' ? 1 : 0;
    osc.connect(gain).connect(panner).connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close().catch(() => {}); }, 700);
  } catch (e) {
    toast('Could not play a tone on this machine.', 'error');
  }
}

// --- Microphone ---
async function hwMicToggle() {
  const btn = $('hw-mic-toggle');
  if (state.hwtest.micStream) {
    hwMicStop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.hwtest.micStream = stream;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    state.hwtest.audioCtx = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    $('hw-mic-meter').hidden = false;
    btn.textContent = 'Stop microphone';
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      $('hw-mic-fill').style.width = `${Math.min(100, Math.round(rms * 320))}%`;
      state.hwtest.micRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {
    toast('Could not open the microphone (no mic, or permission denied).', 'error');
  }
}

function hwMicStop() {
  if (state.hwtest.micRaf) cancelAnimationFrame(state.hwtest.micRaf);
  state.hwtest.micRaf = null;
  if (state.hwtest.audioCtx) { state.hwtest.audioCtx.close().catch(() => {}); state.hwtest.audioCtx = null; }
  if (state.hwtest.micStream) { state.hwtest.micStream.getTracks().forEach((t) => t.stop()); state.hwtest.micStream = null; }
  const meter = $('hw-mic-meter');
  if (meter) meter.hidden = true;
  const btn = $('hw-mic-toggle');
  if (btn) btn.textContent = 'Start microphone';
}

// --- Webcam ---
async function hwCamToggle() {
  const btn = $('hw-cam-toggle');
  const video = $('hw-cam');
  if (state.hwtest.camStream) {
    hwCamStop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    state.hwtest.camStream = stream;
    video.srcObject = stream;
    video.hidden = false;
    btn.textContent = 'Stop webcam';
  } catch (e) {
    toast('Could not open the webcam (no camera, or permission denied).', 'error');
  }
}

function hwCamStop() {
  const video = $('hw-cam');
  if (state.hwtest.camStream) { state.hwtest.camStream.getTracks().forEach((t) => t.stop()); state.hwtest.camStream = null; }
  if (video) { video.srcObject = null; video.hidden = true; }
  const btn = $('hw-cam-toggle');
  if (btn) btn.textContent = 'Start webcam';
}

function initHwtest() {
  if (!state.hwtest.built) {
    buildKeyboard();
    $('hw-screen-start').addEventListener('click', hwScreenStart);
    $('hw-kb-reset').addEventListener('click', () => {
      hwKbTested.clear();
      for (const k of document.querySelectorAll('.hw-key')) k.classList.remove('tested', 'down');
      updateKbCount();
    });
    $('hw-mic-toggle').addEventListener('click', hwMicToggle);
    $('hw-cam-toggle').addEventListener('click', hwCamToggle);
    for (const b of document.querySelectorAll('#view-hwtest [data-tone]')) {
      b.addEventListener('click', () => hwTone(b.dataset.tone));
    }
    state.hwtest.built = true;
  }
  if (!state.hwtest.kbBound) {
    document.addEventListener('keydown', hwKeyDown, true);
    document.addEventListener('keyup', hwKeyUp, true);
    state.hwtest.kbBound = true;
  }
}

// Releases the camera, mic and key listeners the moment the tab is left.
function stopHwtest() {
  if (state.hwtest.kbBound) {
    document.removeEventListener('keydown', hwKeyDown, true);
    document.removeEventListener('keyup', hwKeyUp, true);
    state.hwtest.kbBound = false;
  }
  hwMicStop();
  hwCamStop();
}

$('ghosts-remove').addEventListener('click', async () => {
  const ids = [...state.ghosts.selected];
  if (!ids.length) return;
  const ok = await confirmAction({
    title: `Remove ${ids.length} ghost device${ids.length === 1 ? '' : 's'}?`,
    body: 'These devices are not connected. Removing their leftover entries is safe — if a device is plugged back in, Windows re-detects it. Present hardware is never touched.',
    confirmLabel: 'Remove',
    danger: false,
  });
  if (!ok) return;
  state.ghosts.busy = true;
  updateGhostRemoveButton();
  try {
    const result = await window.pc.ghosts.remove(ids);
    const failMsg = result.failed && result.failed.length ? ` ${result.failed.length} skipped.` : '';
    toast(`Removed ${result.removed} device${result.removed === 1 ? '' : 's'}.${failMsg}`, 'good');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.ghosts.busy = false;
    loadGhosts();
  }
});

/* Event log ---------------------------------------------------------------- */

function eventWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function renderEvents() {
  const data = state.events.data;
  const summaryEl = $('events-summary');
  const timelineEl = $('events-timeline');
  const listEl = $('events-list');

  if (!data) {
    summaryEl.replaceChildren();
    timelineEl.replaceChildren();
    listEl.replaceChildren(empty('Reading the event logs…'));
    return;
  }

  // Summary stat tiles.
  const s = data.summary;
  summaryEl.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'ev-summary';
  const tiles = [
    { n: s.bsod, l: 'Blue screens', bad: s.bsod > 0 },
    { n: s.crash, l: 'Unexpected shutdowns', bad: s.crash > 0 },
    { n: s.appcrash, l: 'App crashes / hangs', bad: false },
  ];
  for (const t of tiles) {
    const tile = document.createElement('div');
    tile.className = `ev-stat${t.bad ? ' bad' : ''}`;
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = String(t.n);
    const l = document.createElement('div');
    l.className = 'l';
    l.textContent = `${t.l} · 45 days`;
    tile.append(n, l);
    grid.append(tile);
  }
  summaryEl.append(grid);

  // Crash timeline.
  timelineEl.replaceChildren();
  if (data.stability.length) {
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = 'Stability timeline';
    timelineEl.append(title);
    const box = document.createElement('div');
    box.className = 'ev-timeline';
    for (const crash of data.stability.slice(0, 25)) {
      const row = document.createElement('div');
      row.className = 'ev-crash';
      const dot = document.createElement('span');
      dot.className = `ev-dot ${crash.kind}`;
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = eventWhen(crash.time);
      const what = document.createElement('span');
      what.className = 'what';
      const b = document.createElement('b');
      b.textContent = crash.label;
      what.append(b);
      if (crash.detail) what.append(` — ${crash.detail}`);
      row.append(dot, when, what);
      box.append(row);
    }
    timelineEl.append(box);
  }

  // Filtered, deduped feed.
  const term = state.events.search.trim().toLowerCase();
  const filter = state.events.filter;
  const rows = data.groups.filter((g) => {
    if (filter === 'errors' && g.levelNum > 2) return false;
    if (filter === 'warnings' && g.levelNum !== 3) return false;
    if (filter === 'hinted' && !g.hint) return false;
    if (term && !`${g.provider} ${g.id} ${g.message}`.toLowerCase().includes(term)) return false;
    return true;
  });

  listEl.replaceChildren();
  if (!rows.length) {
    listEl.append(empty(term || filter !== 'all' ? 'Nothing matches.' : 'No errors or warnings — a healthy 14 days.'));
  } else {
    for (const g of rows) listEl.append(eventRow(g));
  }

  $('events-subtitle').textContent =
    `${s.errors} error${s.errors === 1 ? '' : 's'} · ${s.warnings} warning${s.warnings === 1 ? '' : 's'} in 14 days` +
    (s.bsod || s.crash ? ` · ${s.bsod + s.crash} crash${s.bsod + s.crash === 1 ? '' : 'es'}` : '');
}

function eventRow(g) {
  const row = document.createElement('div');
  row.className = 'ev-row';

  const top = document.createElement('div');
  top.className = 'ev-row-top';
  const level = document.createElement('span');
  level.className = `ev-level ${g.levelNum <= 2 ? 'err' : 'warn'}`;
  level.textContent = g.level;
  const src = document.createElement('span');
  src.className = 'ev-src';
  src.textContent = `${g.provider} · ${g.id}`;
  const count = document.createElement('span');
  count.className = 'ev-count';
  count.textContent = `${g.count > 1 ? `×${g.count} · ` : ''}${eventWhen(g.latest)}`;
  top.append(level, src, count);

  const msg = document.createElement('div');
  msg.className = 'ev-msg';
  msg.textContent = g.message;

  row.append(top, msg);

  if (g.hint) {
    const hint = document.createElement('div');
    hint.className = 'ev-hint';
    hint.textContent = `→ ${g.hint}`;
    row.append(hint);
  }

  // Expand to the full message on click.
  let full = null;
  row.addEventListener('click', () => {
    row.classList.toggle('open');
    if (row.classList.contains('open')) {
      if (!full) {
        full = document.createElement('div');
        full.className = 'ev-full';
        full.textContent = g.full || g.message;
        row.append(full);
      }
      full.hidden = false;
    } else if (full) {
      full.hidden = true;
    }
  });

  return row;
}

async function loadEvents() {
  state.events.loaded = false;
  renderEvents();
  try {
    state.events.data = await window.pc.events();
    state.events.loaded = true;
    renderEvents();
  } catch (error) {
    state.events.loaded = true;
    $('events-list').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('events-refresh').addEventListener('click', loadEvents);
$('events-search').addEventListener('input', (event) => {
  state.events.search = event.target.value;
  if (state.events.data) renderEvents();
});
$('events-filter').addEventListener('change', (event) => {
  state.events.filter = event.target.value;
  if (state.events.data) renderEvents();
});

/* Repair ------------------------------------------------------------------- */

let repairLines = [];
let repairLastWasProgress = false;

function repairPrint(line, isProgress) {
  const el = $('repair-console');
  el.hidden = false;
  // Collapse consecutive progress lines onto one, so a percentage counts up in
  // place instead of scrolling a hundred near-identical lines past.
  if (isProgress && repairLastWasProgress && repairLines.length) {
    repairLines[repairLines.length - 1] = line;
  } else {
    repairLines.push(line);
    if (repairLines.length > 800) repairLines = repairLines.slice(-800);
  }
  repairLastWasProgress = isProgress;
  el.textContent = repairLines.join('\n');
  el.scrollTop = el.scrollHeight;
}

function repairStopUi() {
  $('repair-stop').hidden = true;
  for (const btn of $('repair-commands').querySelectorAll('.btn')) {
    btn.disabled = btn.dataset.needsAdmin === 'true' && !state.admin;
  }
}

function renderRepair() {
  const wrap = $('repair-commands');
  wrap.replaceChildren();

  const card = document.createElement('div');
  card.className = 'list';
  for (const cmd of state.repair.commands) {
    const row = document.createElement('div');
    row.className = 'repair-cmd';

    const body = document.createElement('div');
    body.className = 'cmd-body';
    const name = document.createElement('div');
    name.className = 'cmd-name';
    name.textContent = cmd.label;
    const blurb = document.createElement('div');
    blurb.className = 'cmd-blurb';
    blurb.textContent = cmd.blurb;
    body.append(name, blurb);

    const btn = document.createElement('button');
    btn.className = 'btn btn-small';
    btn.textContent = 'Run';
    btn.dataset.needsAdmin = String(cmd.needsAdmin);
    btn.disabled = cmd.needsAdmin && !state.admin;
    if (btn.disabled) btn.title = 'Restart as administrator to run this.';
    btn.addEventListener('click', () => startRepair(cmd));

    row.append(body, btn);
    card.append(row);
  }
  wrap.append(card);

  $('repair-admin-note').hidden = state.admin;
}

async function startRepair(cmd) {
  if (state.repair.runId != null) {
    toast('A repair is already running — stop it first.', 'error');
    return;
  }
  repairLines = [];
  repairLastWasProgress = false;
  repairPrint(`> ${cmd.label}`, false);
  for (const btn of $('repair-commands').querySelectorAll('.btn')) btn.disabled = true;
  $('repair-stop').hidden = false;

  try {
    state.repair.runId = await window.pc.repair.start(cmd.id);
    state.repair.runLabel = cmd.label;
  } catch (error) {
    repairPrint(error.message, false);
    repairStopUi();
  }
}

window.pc.repair.onLine((event) => {
  if (state.repair.runId == null || event.id !== state.repair.runId) return;
  if (event.done) {
    const label = state.repair.runLabel || 'Repair';
    repairPrint(
      event.code === 0 ? `> ${label} finished.` : `> ${label} exited (code ${event.code}).`,
      false
    );
    state.repair.runId = null;
    repairStopUi();
    return;
  }
  if (event.line) repairPrint(event.line, Boolean(event.progress));
});

$('repair-stop').addEventListener('click', async () => {
  if (state.repair.runId != null) await window.pc.repair.stop(state.repair.runId).catch(() => {});
  state.repair.runId = null;
  repairStopUi();
  repairPrint('> stopped', false);
});
$('repair-elevate').addEventListener('click', async () => {
  try {
    await window.pc.elevate();
  } catch (error) {
    toast(error.message, 'error');
  }
});

async function loadRepair() {
  try {
    state.repair.commands = await window.pc.repair.list();
    state.repair.loaded = true;
    renderRepair();
  } catch (error) {
    state.repair.loaded = true;
    $('repair-commands').replaceChildren(empty(error.message));
  }
}

/* Network ------------------------------------------------------------------ */

function adapterCard(a) {
  const card = document.createElement('div');
  card.className = 'spec-card wide';
  const h = document.createElement('h3');
  h.textContent = a.connection || a.name;
  card.append(h);
  const hero = document.createElement('div');
  hero.className = 'spec-hero';
  hero.textContent = a.ipv4[0] || a.ipv6[0] || 'No address';
  card.append(hero);
  const sub = document.createElement('div');
  sub.className = 'spec-sub';
  sub.textContent = a.name;
  card.append(sub);

  const rows = [
    ['Gateway', a.gateway],
    ['DNS', a.dns.join(', ') || null],
    ['Subnet mask', a.subnet],
    ['Assigned by', a.dhcp ? `DHCP${a.dhcpServer ? ` (${a.dhcpServer})` : ''}` : 'Static'],
    ['Link speed', a.speedMbps ? (a.speedMbps >= 1000 ? `${(a.speedMbps / 1000).toFixed(1)} Gbps` : `${a.speedMbps} Mbps`) : null],
    ['MAC', a.mac],
    ['Other IPv4', a.ipv4.slice(1).join(', ') || null],
  ];
  for (const [k, v] of rows) {
    if (!v) continue;
    const row = document.createElement('div');
    row.className = 'spec-row';
    const kEl = document.createElement('span');
    kEl.className = 'k';
    kEl.textContent = k;
    const vEl = document.createElement('span');
    vEl.className = 'v';
    vEl.textContent = v;
    row.append(kEl, vEl);
    card.append(row);
  }
  return card;
}

function renderNetwork() {
  const wrap = $('network-adapters');
  wrap.replaceChildren();
  const info = state.network.info;
  if (!info) {
    wrap.append(empty('Reading adapters…'));
    return;
  }
  if (!info.adapters.length) {
    wrap.append(empty('No active network adapters.'));
  }
  for (const a of info.adapters) wrap.append(adapterCard(a));

  const actions = $('network-actions');
  actions.replaceChildren();
  for (const action of state.network.actions) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-small';
    btn.textContent = action.label;
    const blocked = action.needsAdmin && !state.admin;
    btn.disabled = blocked;
    if (blocked) btn.title = 'Restart as administrator to use this.';
    btn.addEventListener('click', async () => {
      const ok = await confirmAction({
        title: `${action.label}?`,
        body:
          action.id === 'flushDns'
            ? 'Clears the DNS resolver cache. Safe and instant.'
            : action.id === 'renew'
              ? 'Releases this PC’s IP address and asks the router for a fresh one. Your connection will blink.'
              : 'This resets part of the Windows network stack and needs a restart to finish. Use it when the connection is broken in a way nothing else fixes.',
        confirmLabel: action.label,
        danger: action.needsAdmin,
      });
      if (!ok) return;
      btn.disabled = true;
      const was = btn.textContent;
      btn.textContent = 'Working…';
      try {
        const result = await window.pc.net.runAction(action.id);
        toast(result.message, 'good');
        if (action.id === 'renew') loadNetwork();
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        btn.disabled = action.needsAdmin && !state.admin;
        btn.textContent = was;
      }
    });
    actions.append(btn);
  }

  $('network-subtitle').textContent = `${info.hostName} · ${info.adapters.length} active adapter${info.adapters.length === 1 ? '' : 's'}`;
}

let netConsoleLines = [];
function netPrint(line) {
  const el = $('net-console');
  el.hidden = false;
  netConsoleLines.push(line);
  // Keep the console bounded so a long ping doesn't grow without limit.
  if (netConsoleLines.length > 500) netConsoleLines = netConsoleLines.slice(-500);
  el.textContent = netConsoleLines.join('\n');
  el.scrollTop = el.scrollHeight;
}

function netStopUi() {
  $('net-stop').hidden = true;
  $('net-ping').disabled = false;
  $('net-trace').disabled = false;
}

async function startNet(kind) {
  const host = $('net-host').value.trim();
  if (!host) {
    toast('Enter a host name or IP first.', 'error');
    return;
  }
  // A previous run must be stopped before another starts.
  if (state.network.runId != null) await window.pc.net.stop(state.network.runId).catch(() => {});

  netConsoleLines = [];
  netPrint(`> ${kind === 'trace' ? 'tracert' : 'ping'} ${host}`);
  $('net-ping').disabled = true;
  $('net-trace').disabled = true;
  $('net-stop').hidden = false;

  try {
    state.network.runId = await window.pc.net.start(kind, host);
  } catch (error) {
    netPrint(error.message);
    netStopUi();
  }
}

// --- speed test ---
function fmtSpeed(mbps) {
  if (mbps == null) return '—';
  if (mbps >= 100) return Math.round(mbps).toString();
  return mbps.toFixed(1);
}

window.pc.net.onSpeed((event) => {
  if (!state.network.speedRunning) return;
  const status = $('speed-status');
  switch (event.phase) {
    case 'latency':
      status.textContent = 'Measuring latency…';
      break;
    case 'latency-done':
      $('speed-ping').textContent = event.latencyMs != null ? Math.round(event.latencyMs) : '—';
      $('speed-ping').classList.remove('live');
      break;
    case 'download':
      status.textContent = 'Testing download…';
      $('speed-down').textContent = fmtSpeed(event.mbps);
      $('speed-down').classList.add('live');
      break;
    case 'download-done':
      $('speed-down').textContent = fmtSpeed(event.downMbps);
      $('speed-down').classList.remove('live');
      break;
    case 'upload':
      status.textContent = 'Testing upload…';
      $('speed-up').textContent = fmtSpeed(event.mbps);
      $('speed-up').classList.add('live');
      break;
    case 'upload-done':
      $('speed-up').textContent = fmtSpeed(event.upMbps);
      $('speed-up').classList.remove('live');
      break;
    case 'lan':
      status.textContent = 'Checking local network…';
      break;
    default:
      break;
  }
});

async function runSpeedTest() {
  if (state.network.speedRunning) return;
  state.network.speedRunning = true;
  const btn = $('speed-run');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  for (const id of ['speed-down', 'speed-up', 'speed-ping']) {
    $(id).textContent = '—';
    $(id).classList.remove('live');
  }
  $('speed-lan').hidden = true;

  try {
    const result = await window.pc.net.speedtest();
    $('speed-down').textContent = fmtSpeed(result.downMbps);
    $('speed-up').textContent = fmtSpeed(result.upMbps);
    $('speed-ping').textContent = result.latencyMs != null ? Math.round(result.latencyMs) : '—';
    $('speed-down').classList.remove('live');
    $('speed-up').classList.remove('live');
    if (result.downMbps == null && result.upMbps == null) {
      $('speed-status').textContent = 'The public test servers are busy right now. Try again in a minute.';
    } else {
      const bits = [`jitter ${result.jitterMs != null ? result.jitterMs.toFixed(1) : '?'} ms`];
      if (result.source) bits.push(`via ${result.source}`);
      if (result.downMbps == null) bits.unshift('download unavailable');
      $('speed-status').textContent = `Done · ${bits.join(' · ')}`;
    }

    const lan = result.lan || {};
    const lanEl = $('speed-lan');
    if (lan.gateway) {
      lanEl.replaceChildren();
      const link = lan.linkSpeedMbps
        ? lan.linkSpeedMbps >= 1000
          ? `${(lan.linkSpeedMbps / 1000).toFixed(1)} Gbps`
          : `${lan.linkSpeedMbps} Mbps`
        : '?';
      const parts = [
        ['Local link', link],
        ['Gateway', lan.gateway],
        ['Round trip', lan.latencyMs != null ? `${lan.latencyMs.toFixed(1)} ms` : '?'],
        ['Jitter', lan.jitterMs != null ? `${lan.jitterMs.toFixed(1)} ms` : '?'],
        ['Loss', `${lan.lossPct ?? 0}%`],
      ];
      lanEl.append('Local network — ');
      parts.forEach(([k, v], i) => {
        if (i) lanEl.append('   ·   ');
        lanEl.append(`${k} `);
        const b = document.createElement('b');
        b.textContent = v;
        lanEl.append(b);
      });
      lanEl.hidden = false;
    }
  } catch (error) {
    $('speed-status').textContent = `Could not complete the test: ${error.message}`;
    toast(error.message, 'error');
  } finally {
    state.network.speedRunning = false;
    btn.disabled = false;
    btn.textContent = 'Run speed test';
  }
}

$('speed-run').addEventListener('click', runSpeedTest);

$('network-refresh').addEventListener('click', loadNetwork);
$('net-ping').addEventListener('click', () => startNet('ping'));
$('net-trace').addEventListener('click', () => startNet('trace'));
$('net-host').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') startNet('ping');
});
$('net-stop').addEventListener('click', async () => {
  if (state.network.runId != null) await window.pc.net.stop(state.network.runId).catch(() => {});
  state.network.runId = null;
  netStopUi();
  netPrint('> stopped');
});
$('net-clear').addEventListener('click', () => {
  netConsoleLines = [];
  const el = $('net-console');
  el.textContent = '';
  el.hidden = true;
});

// Live lines from any running ping/trace.
window.pc.net.onLine((event) => {
  if (state.network.runId == null || event.id !== state.network.runId) return;
  if (event.done) {
    state.network.runId = null;
    netStopUi();
    netPrint(`> finished`);
    return;
  }
  if (event.line) netPrint(event.line);
});

async function loadNetwork() {
  try {
    const [info, actions] = await Promise.all([window.pc.net.info(), window.pc.net.actions()]);
    state.network.info = info;
    state.network.actions = actions;
    state.network.loaded = true;
    renderNetwork();
  } catch (error) {
    state.network.loaded = true;
    $('network-adapters').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

/* Product keys ------------------------------------------------------------- */

function keyRow(label, value, { mono = true } = {}) {
  const row = document.createElement('div');
  row.className = 'key-row';

  const info = document.createElement('div');
  info.className = 'key-info';
  const l = document.createElement('div');
  l.className = 'key-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = `key-value${mono ? '' : ' muted'}`;
  v.textContent = value;
  info.append(l, v);
  row.append(info);

  if (mono) {
    const copy = document.createElement('button');
    copy.className = 'btn btn-ghost btn-small';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await window.pc.copyText(value);
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    row.append(copy);
  }
  return row;
}

function renderKeys() {
  const body = $('keys-body');
  const data = state.keys.data;
  if (!data) {
    body.replaceChildren(empty('Reading licences…'));
    return;
  }

  body.replaceChildren();
  const w = data.windows;

  const winCard = document.createElement('div');
  winCard.className = 'spec-card wide';
  const h = document.createElement('h3');
  h.textContent = 'Windows';
  winCard.append(h);
  const hero = document.createElement('div');
  hero.className = 'spec-hero';
  hero.textContent = w.edition || 'Windows';
  winCard.append(hero);
  const sub = document.createElement('div');
  sub.className = 'spec-sub';
  sub.textContent = [w.status, w.channel].filter(Boolean).join(' · ');
  winCard.append(sub);

  const rows = document.createElement('div');
  rows.style.marginTop = '10px';
  if (w.oemKey) rows.append(keyRow('OEM key (in this PC’s firmware)', w.oemKey));
  if (w.retailKey && w.retailKey !== w.oemKey) rows.append(keyRow('Installed product key', w.retailKey));
  if (!w.oemKey && !w.retailKey) {
    if (w.digitalLicence) {
      rows.append(
        keyRow(
          'No stored key',
          'This is a digital licence tied to a Microsoft account. Sign in with that account after a reinstall to re-activate — there is no key to copy.',
          { mono: false }
        )
      );
    } else {
      rows.append(keyRow('Key', `Only the last five are available: …${w.partialKey || '?????'}`, { mono: false }));
    }
  }
  winCard.append(rows);
  body.append(winCard);

  if (data.office.length) {
    const label = document.createElement('div');
    label.className = 'group-title';
    label.textContent = `Microsoft Office · ${data.office.length}`;
    body.append(label);

    const card = document.createElement('div');
    card.className = 'spec-card wide';
    for (const o of data.office) {
      card.append(
        keyRow(
          `${o.edition}${o.channel ? ` · ${o.channel}` : ''} · ${o.status}`,
          `Last five: …${o.partialKey}`,
          { mono: false }
        )
      );
    }
    const note = document.createElement('div');
    note.className = 'spec-sub';
    note.style.marginTop = '8px';
    note.textContent = 'Office (Click-to-Run) does not store a recoverable full key — only the last five characters are available.';
    card.append(note);
    body.append(card);
  }
}

async function loadKeys() {
  state.keys.loaded = false;
  $('keys-body').replaceChildren(empty('Reading licences…'));
  try {
    state.keys.data = await window.pc.keys();
    state.keys.loaded = true;
    renderKeys();
  } catch (error) {
    state.keys.loaded = true;
    $('keys-body').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('keys-refresh').addEventListener('click', loadKeys);

/* Programs ----------------------------------------------------------------- */

function visiblePrograms() {
  const term = state.programs.search.trim().toLowerCase();
  const items = state.programs.items.filter(
    (program) => !term || `${program.name} ${program.publisher || ''}`.toLowerCase().includes(term)
  );

  const sizeOf = (program) => program.measuredBytes ?? program.estimatedBytes ?? -1;
  if (state.programs.sort === 'name') {
    items.sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base' }));
  } else if (state.programs.sort === 'date') {
    items.sort((a, b) => String(b.installedOn || '').localeCompare(String(a.installedOn || '')));
  } else {
    items.sort((a, b) => sizeOf(b) - sizeOf(a));
  }
  return items;
}

function programRow(program) {
  const row = document.createElement('div');
  row.className = 'row';

  const main = document.createElement('div');
  main.className = 'row-main';

  const name = document.createElement('div');
  name.className = 'row-name';
  name.textContent = program.name;

  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.textContent =
    [
      program.publisher,
      program.version,
      program.installedOn &&
        `installed ${new Date(program.installedOn).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })}`,
    ]
      .filter(Boolean)
      .join('  ·  ') || 'No publisher recorded';
  meta.title = program.installLocation || '';

  main.append(name, meta);

  const tags = document.createElement('div');
  tags.className = 'row-tags';
  if (program.missing) {
    const tag = document.createElement('span');
    tag.className = 'tag tag-danger';
    tag.textContent = 'Files missing';
    tag.title = 'The install folder is gone — this is a leftover entry. Clear it from the Registry tab.';
    tags.append(tag);
  }
  if (program.scope === 'user') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'Just you';
    tags.append(tag);
  }

  const size = document.createElement('div');
  size.className = 'row-size';
  const bytes = program.measuredBytes ?? program.estimatedBytes;
  size.textContent = bytes ? formatBytes(bytes) : '—';
  if (program.measuredBytes != null) {
    size.title = 'Measured on disk';
    size.classList.add('is-measured');
  } else if (program.estimatedBytes) {
    size.title = 'As recorded by the installer — press Measure for the real figure';
  }

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  if (program.installLocation && !program.missing) {
    const measure = document.createElement('button');
    measure.className = 'btn btn-ghost btn-small';
    measure.textContent = program.measuredBytes == null ? 'Measure' : 'Re-measure';
    measure.addEventListener('click', async () => {
      measure.disabled = true;
      measure.textContent = 'Measuring…';
      try {
        const result = await window.pc.programs.measure(program.id);
        program.measuredBytes = result.bytes;
        renderPrograms();
      } catch (error) {
        toast(error.message, 'error');
        measure.disabled = false;
        measure.textContent = 'Measure';
      }
    });

    const show = document.createElement('button');
    show.className = 'btn btn-ghost btn-small';
    show.textContent = 'Show folder';
    show.addEventListener('click', () => {
      window.pc.programs.reveal(program.id).catch((error) => toast(error.message, 'error'));
    });

    actions.append(measure, show);
  }

  const uninstall = document.createElement('button');
  uninstall.className = 'btn btn-small';
  uninstall.textContent = 'Uninstall';
  uninstall.disabled = !program.canUninstall;
  if (!program.canUninstall) uninstall.title = 'This program did not register an uninstaller.';
  uninstall.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: `Uninstall ${program.name}?`,
      body: "This opens the program's own uninstaller, which will ask you to confirm. BOB does not remove any files itself.",
      confirmLabel: 'Open uninstaller',
    });
    if (!ok) return;
    try {
      await window.pc.programs.uninstall(program.id);
      toast(`Opened the uninstaller for ${program.name}. Press Refresh when it finishes.`, 'good');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  actions.append(uninstall);

  const force = document.createElement('button');
  force.className = 'btn btn-ghost btn-small btn-danger-text';
  force.textContent = 'Force remove';
  force.title = "For when the program's own uninstaller will not run";
  force.addEventListener('click', () => forceRemoveProgram(program, force));
  actions.append(force);

  row.append(main, tags, size, actions);
  return row;
}

/** Describes a forced-removal plan as the lines of a confirmation. */
function describeForcePlan(plan) {
  const lines = ["The program's own uninstaller is skipped. These are moved to quarantine:", ''];

  if (plan.folder && plan.folder.exists) {
    lines.push(`• Install folder — ${plan.folder.path}`);
    lines.push(
      `   ${formatBytes(plan.folder.bytes)} in ${plan.folder.files.toLocaleString('en-GB')} file${
        plan.folder.files === 1 ? '' : 's'
      }${plan.folder.derived ? ' · found from where its uninstaller lives' : ''}`
    );
  }
  if (plan.shortcuts.length) {
    lines.push(`• ${plan.shortcuts.length} shortcut${plan.shortcuts.length === 1 ? '' : 's'} pointing into it`);
  }
  lines.push(
    `• Its entry in Add/Remove Programs${
      plan.folder && !plan.folder.exists ? ' (the install folder is already gone)' : ''
    }`
  );
  if (!plan.folder) lines.push('   No install folder was recorded, so no files are touched.');

  lines.push(
    '',
    'Nothing is deleted yet. Restore it all from the Backups tab, or discard it there to free the space.'
  );
  return lines.join('\n');
}

async function forceRemoveProgram(program, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Checking…';

  let plan;
  try {
    plan = await window.pc.programs.forcePlan(program.id);
  } catch (error) {
    toast(error.message, 'error');
    return;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }

  if (!plan.canForce) {
    await confirmAction({
      title: `Can't force-remove ${program.name}`,
      body: plan.refusals.join('\n\n'),
      alertOnly: true,
    });
    return;
  }

  const ok = await confirmAction({
    title: `Force-remove ${program.name}?`,
    body: describeForcePlan(plan),
    confirmLabel: 'Force remove',
  });
  if (!ok) return;

  button.disabled = true;
  button.textContent = 'Removing…';
  try {
    const result = await window.pc.programs.forceRemove(program.id);
    const extra = result.skippedShortcuts.length
      ? ` ${result.skippedShortcuts.length} shortcut${result.skippedShortcuts.length === 1 ? ' was' : 's were'} left in place.`
      : '';
    toast(
      `Removed ${result.name}${result.bytes ? ` — ${formatBytes(result.bytes)} in quarantine` : ''}. ` +
        `Restore it or free the space from Backups.${extra}`,
      'good'
    );
    await loadPrograms();
    loadBackups();
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
    button.textContent = label;
  }
}

function renderPrograms() {
  const list = $('programs-list');
  list.replaceChildren();

  if (!state.programs.loaded) {
    list.append(empty('Reading installed programs…'));
    return;
  }

  const items = visiblePrograms();
  if (!items.length) {
    list.append(empty(state.programs.search ? 'Nothing matches that search.' : 'No installed programs found.'));
    return;
  }

  for (const program of items) list.append(programRow(program));

  const known = state.programs.items.filter((p) => p.measuredBytes ?? p.estimatedBytes);
  const total = known.reduce((sum, p) => sum + (p.measuredBytes ?? p.estimatedBytes), 0);
  const missing = state.programs.items.filter((p) => p.missing).length;
  $('programs-subtitle').textContent =
    `${state.programs.items.length} programs · about ${formatBytes(total)} across the ${known.length} that report a size` +
    (missing ? ` · ${missing} leftover${missing === 1 ? '' : 's'}` : '');
  $('nav-programs-count').textContent = String(state.programs.items.length);
}

async function loadPrograms() {
  state.programs.loaded = false;
  renderPrograms();
  try {
    state.programs.items = await window.pc.programs.list();
    state.programs.loaded = true;
    renderPrograms();
  } catch (error) {
    state.programs.loaded = true;
    $('programs-list').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  }
}

$('programs-refresh').addEventListener('click', loadPrograms);
$('programs-search').addEventListener('input', (event) => {
  state.programs.search = event.target.value;
  renderPrograms();
});
$('programs-sort').addEventListener('change', (event) => {
  state.programs.sort = event.target.value;
  renderPrograms();
});

/* Duplicates --------------------------------------------------------------- */

function dupesRootIds() {
  return [...$('dupes-roots').querySelectorAll('input:checked')].map((input) => input.value);
}

function invalidateDupes(message) {
  state.dupes.scanned = false;
  state.dupes.groups = [];
  state.dupes.selected.clear();
  state.dupes.summary = null;
  $('dupes-groups').replaceChildren(empty(message));
  $('nav-dupes-count').textContent = '';
  updateDupesSelection();
}

/** How many copies of `group` are not marked for deletion. */
function keptInGroup(group) {
  return group.files.filter((file) => !state.dupes.selected.has(file.path)).length;
}

function updateDupesSelection() {
  const count = state.dupes.selected.size;
  let bytes = 0;
  for (const group of state.dupes.groups) {
    for (const file of group.files) {
      if (state.dupes.selected.has(file.path)) bytes += group.bytes;
    }
  }

  $('dupes-selection').hidden = count === 0;
  $('dupes-selection-text').textContent = `${count} cop${count === 1 ? 'y' : 'ies'} selected · ${formatBytes(
    bytes
  )} to reclaim`;
  $('dupes-trash').disabled = count === 0;
}

/** Marks every copy except the one `pick` chooses, for every group. */
function keepOnly(pick) {
  state.dupes.selected.clear();
  for (const group of state.dupes.groups) {
    const keeper = pick(group.files);
    for (const file of group.files) {
      if (file.path !== keeper.path) state.dupes.selected.add(file.path);
    }
  }
  renderDupes();
}

function renderDupes() {
  const container = $('dupes-groups');
  container.replaceChildren();

  if (!state.dupes.scanned) {
    container.append(empty('Choose your folders, then press Scan.'));
    return;
  }
  if (!state.dupes.groups.length) {
    container.append(empty('No duplicates found in those folders.'));
    $('dupes-subtitle').textContent = 'No duplicates found.';
    $('nav-dupes-count').textContent = '';
    return;
  }

  for (const group of state.dupes.groups) {
    const card = document.createElement('div');
    card.className = 'dupe-group';

    const head = document.createElement('div');
    head.className = 'dupe-head';
    const title = document.createElement('div');
    title.className = 'dupe-title';
    title.textContent = `${group.files[0].name}`;
    const stat = document.createElement('div');
    stat.className = 'dupe-stat';
    stat.textContent = `${group.count} copies · ${formatBytes(group.bytes)} each · ${formatBytes(
      group.wastedBytes
    )} wasted`;
    head.append(title, stat);
    card.append(head);

    const list = document.createElement('div');
    list.className = 'list';

    for (const file of group.files) {
      const row = document.createElement('label');
      row.className = 'row dupe-row';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = state.dupes.selected.has(file.path);
      input.addEventListener('change', () => {
        if (input.checked) {
          // Ticking this one must never be what empties the group.
          if (keptInGroup(group) <= 1) {
            input.checked = false;
            toast('Keep at least one copy of each file.', 'error');
            return;
          }
          state.dupes.selected.add(file.path);
        } else {
          state.dupes.selected.delete(file.path);
        }
        row.classList.toggle('is-doomed', input.checked);
        updateDupesSelection();
      });
      if (input.checked) row.classList.add('is-doomed');

      const main = document.createElement('div');
      main.className = 'row-main';
      const name = document.createElement('div');
      name.className = 'row-name';
      name.textContent = file.name;
      const meta = document.createElement('div');
      meta.className = 'row-meta';
      meta.textContent = `${file.folder}  ·  ${formatDate(file.modified)}`;
      meta.title = file.path;
      main.append(name, meta);

      const show = document.createElement('button');
      show.className = 'btn btn-ghost btn-small';
      show.textContent = 'Show';
      show.addEventListener('click', (event) => {
        event.preventDefault();
        window.pc.files.reveal(file.path).catch((error) => toast(error.message, 'error'));
      });

      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.append(show);

      row.append(input, main, actions);
      list.append(row);
    }

    card.append(list);
    container.append(card);
  }

  const summary = state.dupes.summary;
  if (summary) {
    $('dupes-subtitle').textContent =
      `${summary.duplicateFiles.toLocaleString('en-GB')} duplicate file${
        summary.duplicateFiles === 1 ? '' : 's'
      } across ${summary.totalGroups} group${summary.totalGroups === 1 ? '' : 's'} · ` +
      `${formatBytes(summary.wastedBytes)} reclaimable` +
      (summary.truncated ? ` (showing the ${state.dupes.groups.length} biggest)` : '');
    $('nav-dupes-count').textContent = formatBytes(summary.wastedBytes);
  }
  updateDupesSelection();
}

window.pc.dupes.onProgress(({ phase, scanned, done, total }) => {
  const fill = $('dupes-progress-fill');
  const label = $('dupes-progress-label');
  if (phase === 'listing') {
    fill.style.width = '8%';
    label.textContent = `Listing files… ${scanned.toLocaleString('en-GB')} checked`;
  } else if (phase === 'sampling') {
    fill.style.width = `${10 + (total ? (done / total) * 40 : 0)}%`;
    label.textContent = `Comparing the first 64 KB… ${done.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')}`;
  } else if (phase === 'hashing') {
    fill.style.width = `${55 + (total ? (done / total) * 40 : 0)}%`;
    label.textContent = `Checking full contents… ${done.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')}`;
  } else {
    fill.style.width = '100%';
    label.textContent = 'Finishing…';
  }
});

$('dupes-scan').addEventListener('click', async () => {
  const rootIds = dupesRootIds();
  if (!rootIds.length) {
    toast('Pick at least one folder to search.', 'error');
    return;
  }

  $('dupes-scan').disabled = true;
  $('dupes-trash').disabled = true;
  $('dupes-progress').hidden = false;
  $('dupes-progress-fill').style.width = '0%';
  $('dupes-groups').replaceChildren();

  try {
    const result = await window.pc.dupes.scan({
      rootIds,
      minBytes: Math.round(Number($('dupes-min').value) * 1024 * 1024),
    });
    state.dupes.groups = result.groups;
    state.dupes.summary = result;
    state.dupes.selected.clear();
    state.dupes.scanned = true;
    renderDupes();

    if (result.totalGroups > 0) {
      toast(
        `${formatBytes(result.wastedBytes)} reclaimable — checked ${result.scannedFiles.toLocaleString(
          'en-GB'
        )} files, read ${result.fullyHashed.toLocaleString('en-GB')} in full.`,
        'good'
      );
    }
  } catch (error) {
    $('dupes-groups').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  } finally {
    $('dupes-progress').hidden = true;
    $('dupes-scan').disabled = false;
  }
});

// Usually the most useful rule: the copy nearest the top of the tree is the
// one you filed deliberately, and the deeper ones are what a backup folder or
// a "(1)" download left behind.
$('dupes-keep-shallowest').addEventListener('click', () =>
  keepOnly((files) =>
    files.reduce((best, file) => {
      const depth = (p) => p.split('\\').length;
      if (depth(file.path) !== depth(best.path)) return depth(file.path) < depth(best.path) ? file : best;
      return file.path.length < best.path.length ? file : best;
    })
  )
);
$('dupes-keep-newest').addEventListener('click', () =>
  keepOnly((files) => files.reduce((best, file) => (file.modified > best.modified ? file : best)))
);
$('dupes-keep-oldest').addEventListener('click', () =>
  keepOnly((files) => files.reduce((best, file) => (file.modified < best.modified ? file : best)))
);
$('dupes-select-none').addEventListener('click', () => {
  state.dupes.selected.clear();
  renderDupes();
});

$('dupes-trash').addEventListener('click', async () => {
  const paths = [...state.dupes.selected];
  if (!paths.length) return;

  const bytes = state.dupes.groups.reduce(
    (sum, group) => sum + group.files.filter((f) => paths.includes(f.path)).length * group.bytes,
    0
  );

  const ok = await confirmAction({
    title: `Move ${paths.length} cop${paths.length === 1 ? 'y' : 'ies'} to the Recycle Bin?`,
    body: `${formatBytes(
      bytes
    )} reclaimed. One copy of every file is kept, and everything moved stays in the Recycle Bin until you empty it.`,
    confirmLabel: 'Move to Recycle Bin',
    danger: false,
  });
  if (!ok) return;

  $('dupes-trash').disabled = true;
  try {
    const result = await window.pc.dupes.trash(paths);
    toast(
      `Moved ${result.moved.length} cop${result.moved.length === 1 ? 'y' : 'ies'} to the Recycle Bin` +
        `${result.failed.length ? ` · ${result.failed.length} could not be moved` : ''}.`,
      result.failed.length ? 'error' : 'good'
    );

    const gone = new Set(result.moved.map((p) => p.toLowerCase()));
    for (const group of state.dupes.groups) {
      group.files = group.files.filter((file) => !gone.has(file.path.toLowerCase()));
      group.count = group.files.length;
      group.wastedBytes = group.bytes * Math.max(0, group.files.length - 1);
    }
    state.dupes.groups = state.dupes.groups.filter((group) => group.files.length > 1);
    state.dupes.selected.clear();
    if (state.dupes.summary) {
      state.dupes.summary = {
        ...state.dupes.summary,
        totalGroups: state.dupes.groups.length,
        duplicateFiles: state.dupes.groups.reduce((sum, g) => sum + g.count - 1, 0),
        wastedBytes: state.dupes.groups.reduce((sum, g) => sum + g.wastedBytes, 0),
      };
    }
    renderDupes();
    loadOverview();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    $('dupes-trash').disabled = false;
  }
});

/* Registry ----------------------------------------------------------------- */

function updateRegistrySelection() {
  const count = state.registry.selected.size;
  $('registry-selection').hidden = count === 0;
  $('registry-selection-text').textContent = `${count} item${count === 1 ? '' : 's'} selected`;
  $('registry-clean').disabled = count === 0;
}

function allRegistryItems() {
  return state.registry.groups.flatMap((group) => group.items);
}

function renderRegistry() {
  const container = $('registry-groups');
  container.replaceChildren();

  if (!state.registry.scanned) {
    container.append(empty('Press Scan to check the registry.'));
    return;
  }

  const total = allRegistryItems().length;
  if (!total) {
    container.append(empty('Nothing to clean — no registry entries point at missing programs.'));
    $('registry-subtitle').textContent = 'Nothing found. Your registry is tidy.';
    $('nav-registry-count').textContent = '';
    return;
  }

  for (const group of state.registry.groups) {
    if (!group.count) continue;

    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = `${group.label} · ${group.count}`;
    container.append(title);

    const blurb = document.createElement('p');
    blurb.className = 'group-blurb';
    blurb.textContent = `${group.description} ${group.safety}`;
    container.append(blurb);

    const list = document.createElement('div');
    list.className = 'list';

    for (const item of group.items) {
      const row = document.createElement('label');
      row.className = 'clean-row';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = state.registry.selected.has(item.id);
      input.disabled = item.needsAdmin && !state.admin;
      input.addEventListener('change', () => {
        if (input.checked) state.registry.selected.add(item.id);
        else state.registry.selected.delete(item.id);
        updateRegistrySelection();
      });

      const body = document.createElement('div');
      body.className = 'clean-body';

      const name = document.createElement('div');
      name.className = 'clean-name';
      name.append(document.createTextNode(item.name));
      if (item.needsAdmin && !state.admin) {
        const tag = document.createElement('span');
        tag.className = 'tag tag-warn';
        tag.textContent = 'Needs administrator';
        name.append(tag);
      }

      const detail = document.createElement('div');
      detail.className = 'clean-desc';
      detail.textContent = item.detail;

      const evidence = document.createElement('div');
      evidence.className = 'clean-safety mono';
      evidence.textContent = `missing: ${item.missingPath}`;
      evidence.title = `${item.hive}\\${item.subKey}${item.valueName ? ` → ${item.valueName}` : ''}`;

      body.append(name, detail, evidence);

      const kind = document.createElement('div');
      kind.className = 'clean-size';
      kind.textContent = item.kind === 'key' ? 'key' : 'value';

      row.append(input, body, kind);
      list.append(row);
    }

    container.append(list);
  }

  $('registry-subtitle').textContent = `${total} entr${total === 1 ? 'y' : 'ies'} point at programs that are no longer installed.`;
  $('nav-registry-count').textContent = String(total);
  updateRegistrySelection();
}

window.pc.registry.onProgress(({ label }) => {
  $('registry-progress-label').textContent = label === 'Done' ? 'Finishing…' : `${label}…`;
  const fill = $('registry-progress-fill');
  const current = parseFloat(fill.style.width) || 0;
  fill.style.width = `${Math.min(90, current + 15)}%`;
});

$('registry-scan').addEventListener('click', async () => {
  $('registry-scan').disabled = true;
  $('registry-clean').disabled = true;
  $('registry-progress').hidden = false;
  $('registry-progress-fill').style.width = '0%';
  $('registry-groups').replaceChildren();
  try {
    const result = await window.pc.registry.scan();
    state.registry.groups = result.groups;
    state.registry.selected.clear();
    state.registry.scanned = true;
    renderRegistry();
  } catch (error) {
    $('registry-groups').replaceChildren(empty(error.message));
    toast(error.message, 'error');
  } finally {
    $('registry-progress').hidden = true;
    $('registry-scan').disabled = false;
  }
});

$('registry-select-all').addEventListener('click', () => {
  state.registry.selected.clear();
  for (const item of allRegistryItems()) {
    if (!(item.needsAdmin && !state.admin)) state.registry.selected.add(item.id);
  }
  renderRegistry();
});

$('registry-select-none').addEventListener('click', () => {
  state.registry.selected.clear();
  renderRegistry();
});

$('registry-clean').addEventListener('click', async () => {
  const ids = [...state.registry.selected];
  if (!ids.length) return;

  const ok = await confirmAction({
    title: `Clean ${ids.length} registry entr${ids.length === 1 ? 'y' : 'ies'}?`,
    body: 'A restore point is written first, so you can put every one of these back from the Backups tab if anything misbehaves.',
    confirmLabel: 'Back up and clean',
    danger: false,
  });
  if (!ok) return;

  $('registry-clean').disabled = true;
  $('registry-scan').disabled = true;
  try {
    const result = await window.pc.registry.clean(ids);
    toast(
      `Removed ${result.removed} entr${result.removed === 1 ? 'y' : 'ies'}` +
        `${result.failed.length ? `, ${result.failed.length} could not be removed` : ''}. Restore point saved.`,
      result.failed.length ? 'error' : 'good'
    );
    state.registry.selected.clear();
    $('registry-scan').click();
    loadBackups();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    $('registry-scan').disabled = false;
  }
});

/* Backups ------------------------------------------------------------------ */

function backupRow(item) {
  const row = document.createElement('div');
  row.className = 'row';

  const main = document.createElement('div');
  main.className = 'row-main';

  const name = document.createElement('div');
  name.className = 'row-name';
  name.textContent = item.label;

  const moved = item.moved || [];
  const quarantined = item.quarantinedBytes || 0;
  const isProgram = item.kind === 'program';

  const meta = document.createElement('div');
  meta.className = 'row-meta';
  const when = new Date(item.createdAt);
  meta.textContent =
    `${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} ` +
    `at ${when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` +
    (isProgram
      ? quarantined
        ? ` · ${formatBytes(quarantined)} in quarantine`
        : ' · entry only, no files'
      : ` · ${item.count} item${item.count === 1 ? '' : 's'} · ${formatBytes(item.bytes)}`);
  meta.title = [...item.items.map((entry) => entry.description), ...moved.map((entry) => entry.from)].join('\n');

  main.append(name, meta);

  const tags = document.createElement('div');
  tags.className = 'row-tags';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = { startup: 'Startup', program: 'Program' }[item.kind] || 'Registry';
  tags.append(tag);
  // A removal that stopped part way: restoring puts back whatever did move.
  if (item.status === 'pending' || item.status === 'failed') {
    const incomplete = document.createElement('span');
    incomplete.className = 'tag tag-warn';
    incomplete.textContent = 'Incomplete';
    incomplete.title = 'This removal did not finish. Restore puts back everything that was moved.';
    tags.append(incomplete);
  }

  const restore = document.createElement('button');
  restore.className = 'btn btn-small';
  restore.textContent = 'Restore';
  restore.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: isProgram ? `Put ${item.label.replace(/^Program: /, '')} back?` : 'Put these entries back?',
      body: isProgram
        ? 'Its install folder, shortcuts and Add/Remove Programs entry go back exactly where they were.'
        : `${item.count} registry item${item.count === 1 ? '' : 's'} will be written back exactly as they were before removal.`,
      confirmLabel: 'Restore',
      danger: false,
    });
    if (!ok) return;
    restore.disabled = true;
    try {
      await window.pc.backups.restore(item.id);
      toast(
        isProgram
          ? 'Restored. The restore point is kept — discard it once you are sure.'
          : 'Restored. Sign out and back in if the entry was a startup item.',
        'good'
      );
      loadBackups();
      if (isProgram && state.programs.loaded) loadPrograms();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      restore.disabled = false;
    }
  });

  const discard = document.createElement('button');
  discard.className = 'btn btn-ghost btn-small';
  discard.textContent = quarantined ? `Discard · frees ${formatBytes(quarantined)}` : 'Discard';
  discard.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: quarantined ? `Delete ${formatBytes(quarantined)} for good?` : 'Discard this restore point?',
      body: quarantined
        ? 'The quarantined files are deleted permanently and the space is freed. They cannot be put back after this.'
        : 'The backup file is deleted. Anything it contained can no longer be put back.',
      confirmLabel: quarantined ? 'Delete for good' : 'Discard',
    });
    if (!ok) return;
    try {
      await window.pc.backups.remove(item.id);
      if (quarantined) toast(`Freed ${formatBytes(quarantined)}.`, 'good');
      loadBackups();
      loadOverview();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.append(restore, discard);

  row.append(main, tags, actions);
  return row;
}

async function loadBackups() {
  try {
    state.backups.items = await window.pc.backups.list();
  } catch {
    state.backups.items = [];
  }

  const list = $('backups-list');
  list.replaceChildren();

  if (!state.backups.items.length) {
    list.append(empty('No restore points yet. One is written automatically before anything is removed.'));
    $('nav-backups-count').textContent = '';
    $('backups-subtitle').textContent = 'Restore points are written before anything is removed from the registry.';
    return;
  }

  for (const item of state.backups.items) list.append(backupRow(item));
  $('nav-backups-count').textContent = String(state.backups.items.length);
  $('backups-subtitle').textContent = `${state.backups.items.length} restore point${
    state.backups.items.length === 1 ? '' : 's'
  } available.`;
}

$('backups-refresh').addEventListener('click', loadBackups);
$('backups-folder').addEventListener('click', () => {
  window.pc.backups.reveal().catch((error) => toast(error.message, 'error'));
});

/* Boot --------------------------------------------------------------------- */

let bootHidden = false;
function hideBoot() {
  if (bootHidden) return;
  bootHidden = true;
  const b = $('boot');
  if (!b) return;
  b.classList.add('is-gone');
  setTimeout(() => b.remove(), 400);
}

// Drop the loading overlay once the first data is in (or after a safety timeout
// so a slow PowerShell call can never leave it stuck on screen).
loadOverview().finally(hideBoot);
setTimeout(hideBoot, 6000);

loadRoots();
loadBackups();
renderFiles();
renderRegistry();
renderDupes();

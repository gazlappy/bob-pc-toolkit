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
  const lines = ['PC Cleanup — system report', new Date().toLocaleString('en-GB'), ''];
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
      body: "This opens the program's own uninstaller, which will ask you to confirm. PC Cleanup does not remove any files itself.",
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

loadOverview();
loadRoots();
loadBackups();
renderFiles();
renderRegistry();
renderDupes();

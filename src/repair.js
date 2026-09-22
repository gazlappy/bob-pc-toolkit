'use strict';

// Windows repair launcher: the bench-tech commands for a poorly Windows —
// SFC, DISM and chkdsk — with their output streaming into the app instead of a
// console window that vanishes when it closes.
//
// The commands are a fixed allow-list keyed by id; there is no user input, so
// nothing can be injected. Each is spawned directly and streamed line by line,
// with an id so it can be stopped. Most need administrator rights, which the
// renderer gates on.

const { spawn } = require('child_process');

// Fixed commands. Nothing here interpolates user input.
const COMMANDS = {
  sfc: {
    label: 'SFC scan',
    exe: 'sfc.exe',
    args: ['/scannow'],
    needsAdmin: true,
    blurb: 'Checks every protected system file and repairs any that are corrupt from a local cache. The usual first repair. Takes a few minutes.',
  },
  dismCheck: {
    label: 'DISM — check health',
    exe: 'Dism.exe',
    args: ['/Online', '/Cleanup-Image', '/CheckHealth'],
    needsAdmin: true,
    blurb: 'A quick read of a flag Windows already set — has the component store been marked corrupt? Instant.',
  },
  dismScan: {
    label: 'DISM — scan health',
    exe: 'Dism.exe',
    args: ['/Online', '/Cleanup-Image', '/ScanHealth'],
    needsAdmin: true,
    blurb: 'Actively scans the component store for corruption without repairing. A few minutes.',
  },
  dismRestore: {
    label: 'DISM — restore health',
    exe: 'Dism.exe',
    args: ['/Online', '/Cleanup-Image', '/RestoreHealth'],
    needsAdmin: true,
    blurb: 'Repairs the component store, pulling replacement files from Windows Update. Needs internet, and is what to run before SFC when SFC cannot fix everything.',
  },
  chkdsk: {
    label: 'Check disk (read-only)',
    exe: 'chkdsk.exe',
    args: ['C:'],
    needsAdmin: true,
    blurb: 'Reports on the C: file system without changing anything. To actually fix errors, Windows schedules that for the next restart — this app does not.',
  },
};

function list() {
  return Object.entries(COMMANDS).map(([id, c]) => ({
    id,
    label: c.label,
    needsAdmin: c.needsAdmin,
    blurb: c.blurb,
  }));
}

// Decodes a console chunk. SFC writes UTF-16LE (a null between each character);
// DISM and chkdsk write plain ASCII/UTF-8. Detect the former by its nulls.
function decodeChunk(buffer) {
  let nulls = 0;
  for (let i = 0; i < buffer.length; i += 1) if (buffer[i] === 0) nulls += 1;
  if (nulls > buffer.length / 4) return buffer.toString('utf16le');
  return buffer.toString('utf8');
}

const running = new Map();
let nextId = 1;

/**
 * Runs the allow-listed repair command `id`, streaming its output.
 * `onEvent` gets { id, line } per line, { id, progress, line } for a progress
 * update (a "% complete" line, so the UI can replace rather than append), and
 * { id, done, code } at exit.
 */
function start(id, onEvent) {
  const command = COMMANDS[id];
  if (!command) throw new Error('Unknown repair command.');

  const runId = nextId++;
  const child = spawn(command.exe, command.args, { windowsHide: true });
  running.set(runId, child);

  // SFC updates a percentage on one line with carriage returns, so \r ends a
  // line here too; those are tagged as progress so the UI overwrites in place.
  let buffer = '';
  const flush = (final) => {
    const parts = buffer.split(/\r\n|\r|\n/);
    buffer = final ? '' : parts.pop();
    for (const raw of parts) {
      const line = raw.split(String.fromCharCode(0)).join('').trimEnd();
      if (!line) continue;
      const progress = /\b\d{1,3}%\s*complete|\[=*\s*\d+\.\d+%/i.test(line);
      onEvent({ id: runId, line, progress });
    }
  };

  child.stdout.on('data', (chunk) => {
    buffer += decodeChunk(chunk);
    flush(false);
  });
  child.stderr.on('data', (chunk) => {
    buffer += decodeChunk(chunk);
    flush(false);
  });
  child.on('error', (error) => {
    onEvent({ id: runId, line: `Could not start ${command.exe}: ${error.message}` });
  });
  child.on('close', (code) => {
    flush(true);
    running.delete(runId);
    onEvent({ id: runId, done: true, code });
  });

  return runId;
}

function stop(runId) {
  const child = running.get(runId);
  if (child) {
    child.kill();
    running.delete(runId);
  }
  return true;
}

function stopAll() {
  for (const child of running.values()) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  running.clear();
}

module.exports = { list, start, stop, stopAll, __internals: { decodeChunk } };

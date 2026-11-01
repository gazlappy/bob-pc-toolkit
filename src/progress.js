'use strict';

// Before and after: what a repair actually changed on this PC. A set of readings is
// kept from before the work starts, so the difference comes from measurements rather
// than from what BOB did. Start times are Windows' own, from its boot log. The saved
// readings belong to one PC, so on a USB stick each PC keeps its own (settings.js).

const fs = require('fs');
const os = require('os');
const backup = require('./backup');
const registry = require('./registry');
const running = require('./running');
const settings = require('./settings');
const startup = require('./startup');

const KEY = 'improvement';
const RECENT_WORK_MS = 7 * 24 * 60 * 60 * 1000;

async function diskFree() {
  try {
    const stat = await fs.promises.statfs(`${process.env.SystemDrive || 'C:'}\\`);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

async function readings() {
  const list = await startup.list().catch(() => null);
  const scan = await registry.scan().catch(() => null);
  const rows = await running.list().catch(() => null);
  return {
    at: Date.now(),
    startupOn: list ? list.entries.filter((e) => e.enabled).length : null,
    startupTotal: list ? list.entries.length : null,
    registryDead: scan ? scan.total : null,
    running: rows ? rows.filter((r) => !r.windows).length : null,
    memUsed: os.totalmem() - os.freemem(),
    diskFree: await diskFree(),
  };
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// One odd start shouldn't set the figure, so a few are taken and the middle one used.
function typicalStart(boots) {
  if (!boots.length) return null;
  return {
    total: median(boots.map((b) => b.total)),
    main: median(boots.map((b) => b.main)),
    post: median(boots.map((b) => b.post)),
    count: boots.length,
    from: boots[boots.length - 1].when,
    to: boots[0].when,
  };
}

function startsBefore(history, ref, count = 3) {
  return typicalStart(history.filter((b) => Date.parse(b.when) < ref).slice(0, count));
}

function startsSince(history, ref) {
  return typicalStart(history.filter((b) => Date.parse(b.when) >= ref).slice(0, 5));
}

/**
 * Keeps the first readings this PC has. If BOB has already changed things here, its
 * newest restore point says when that began, and only start times can be recovered:
 * Windows logged those at the time, but nothing else was written down.
 */
async function ensureBefore() {
  const saved = settings.get(KEY);
  if (saved && saved.before) return saved;
  const points = await backup.list().catch(() => []);
  const times = points.map((p) => Date.parse(p.createdAt)).filter((t) => t && Date.now() - t < RECENT_WORK_MS);
  const report = await startup.bootReport();
  const next = { before: null, after: null };
  if (times.length) {
    const ref = Math.max(...times);
    next.before = { ref, recovered: true, boot: startsBefore(report.history, ref), readings: null };
  } else {
    const ref = Date.now();
    next.before = { ref, recovered: false, boot: startsBefore(report.history, ref), readings: await readings() };
  }
  settings.set(KEY, next);
  return next;
}

async function get() {
  const saved = await ensureBefore();
  const report = await startup.bootReport();
  const before = saved.before;
  // Taken without admin rights, the Before start time can still be filled in later.
  const beforeBoot = before.boot || startsBefore(report.history, before.ref);
  return {
    admin: report.admin,
    readable: report.readable,
    before: { ...before, boot: beforeBoot },
    current: { readings: await readings(), boot: report.history[0] || null },
    after: saved.after || { saved: false, boot: startsSince(report.history, before.ref), readings: null },
  };
}

async function newBefore() {
  const report = await startup.bootReport();
  const ref = Date.now();
  // Starting over means from how the PC is now, so older, slower starts don't count.
  settings.set(KEY, { before: { ref, recovered: false, boot: startsBefore(report.history, ref, 1), readings: await readings() }, after: null });
  return get();
}

async function saveAfter() {
  const saved = await ensureBefore();
  const report = await startup.bootReport();
  settings.set(KEY, { ...saved, after: { saved: true, at: Date.now(), boot: startsSince(report.history, saved.before.ref), readings: await readings() } });
  return get();
}

module.exports = { get, newBefore, saveAfter, ensureBefore, __internals: { typicalStart, startsBefore, startsSince, median } };

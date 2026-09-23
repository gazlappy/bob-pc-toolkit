'use strict';

// Customer report — one tidy, printable summary of the machine's health, built
// from what the other tabs already read: the spec, drive health, recent
// stability, security posture and battery wear. It is the professional
// leave-behind a bench job wants — light-themed so it prints and shares cleanly.

const system = require('./system');
const events = require('./events');
const security = require('./security');
const battery = require('./battery');

let lastData = null;

async function gather() {
  const safe = async (fn) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };
  const sys = await safe(() => system.info());
  const ev = await safe(() => events.read());
  const sec = await safe(() => security.read());
  const bat = await safe(() => battery.read());
  lastData = { generatedAt: new Date().toISOString(), sys, events: ev, security: sec, battery: bat };
  return lastData;
}

function latest() {
  return lastData;
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function gib(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '—';
  const gb = n / 1e9;
  return gb >= 1000 ? `${(gb / 1000).toFixed(2)} TB` : `${Math.round(gb)} GB`;
}

function row(k, v) {
  return `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td></tr>`;
}

function buildHtml(data) {
  const d = data || {};
  const sys = d.sys || {};
  const os = sys.os || {};
  const machine = sys.machine || {};
  const cpu = sys.cpu || {};
  const mem = sys.memory || {};
  const gpus = sys.gpus || [];
  const disks = sys.disks || [];
  const act = sys.activation || {};
  const ev = (d.events && d.events.summary) || {};
  const sec = d.security || {};
  const bat = d.battery || {};

  const when = new Date(d.generatedAt || Date.now());
  const dateStr = when.toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const systemRows = [
    row('Windows', `${os.caption || ''} (build ${os.build || '—'})`),
    row('Activation', act.status ? `${act.status}${act.partialKey ? ` · key …${act.partialKey}` : ''}` : '—'),
    row('Make / model', [machine.manufacturer, machine.model].filter(Boolean).join(' · ') || '—'),
    row('Motherboard', machine.board || '—'),
    row('BIOS', machine.biosVersion ? `${machine.biosVersion} (${machine.biosDate || ''})` : '—'),
    row('Processor', cpu.name || '—'),
    row('Memory', `${gib(mem.total)}${mem.slotsUsed ? ` · ${mem.slotsUsed}/${mem.slotsTotal} slots` : ''}`),
    row('Graphics', gpus.map((g) => g.name).filter(Boolean).join(', ') || '—'),
    row('Installed', os.installedOn || '—'),
    row('Computer name', os.computerName || sys.hostname || '—'),
  ].join('');

  const driveRows = disks.length
    ? disks
        .map((dr) => {
          const cls = /healthy|ok/i.test(dr.health || '') ? 'ok' : dr.health ? 'warn' : '';
          const extra = [
            dr.temperature != null ? `${dr.temperature}°C` : null,
            dr.powerOnHours != null ? `${dr.powerOnHours} h powered on` : null,
            dr.wear != null ? `${dr.wear}% wear` : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return `<tr><td>${esc(dr.name)}</td><td>${esc(dr.media || '')}</td><td>${esc(gib(dr.size))}</td><td><span class="pill ${cls}">${esc(dr.health || 'Unknown')}</span></td><td>${esc(extra || '—')}</td></tr>`;
        })
        .join('')
    : '<tr><td colspan="5">No drive information.</td></tr>';

  const stability = d.events
    ? `<table class="kv">
        ${row('Blue screens (45 days)', ev.bsod ?? 0)}
        ${row('Unexpected crashes', ev.crash ?? 0)}
        ${row('App crashes', ev.appcrash ?? 0)}
        ${row(`Errors (last ${ev.days || 14} days)`, ev.errors ?? 0)}
        ${row('Warnings', ev.warnings ?? 0)}
      </table>`
    : '<p class="muted">Event log not available.</p>';

  const secSections = (sec.sections || [])
    .map((section) => {
      const items = (section.checks || [])
        .map((c) => `<li><span class="dot ${esc(c.status)}"></span><b>${esc(c.label)}</b> — ${esc(c.value)}${c.detail ? ` <span class="muted">(${esc(c.detail)})</span>` : ''}</li>`)
        .join('');
      return `<h3>${esc(section.label)}</h3><ul class="checks">${items}</ul>`;
    })
    .join('');

  const batterySection =
    bat && bat.present
      ? `<table class="kv">
          ${row('Charge now', `${bat.chargePct}%`)}
          ${row('Health', bat.wearPct != null ? `${100 - bat.wearPct}% of original (${bat.wearPct}% worn)` : 'not reported')}
          ${row('Cycle count', bat.cycleCount || 'not reported')}
        </table>`
      : '<p class="muted">No battery (desktop or not reported).</p>';

  const overall = sec.summary
    ? sec.summary.bad
      ? { label: 'Needs attention', cls: 'bad' }
      : sec.summary.warn
        ? { label: 'A few things to check', cls: 'warn' }
        : { label: 'Healthy', cls: 'ok' }
    : { label: 'Report', cls: '' };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PC Health Report — ${esc(os.computerName || sys.hostname || 'PC')}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 "Segoe UI", system-ui, Arial, sans-serif; color: #1c2530; background: #f4f6f9; margin: 0; padding: 32px; }
  .sheet { max-width: 820px; margin: 0 auto; background: #fff; border: 1px solid #e2e7ee; border-radius: 12px; padding: 32px 36px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #eef1f5; padding-bottom: 16px; margin-bottom: 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #6b7684; font-size: 13px; }
  .badge { font-size: 12px; font-weight: 700; padding: 6px 12px; border-radius: 999px; white-space: nowrap; }
  .badge.ok { background: #e6f7ea; color: #1a7f37; }
  .badge.warn { background: #fdf2dc; color: #9a6a00; }
  .badge.bad { background: #fdecea; color: #b42318; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #6b7684; margin: 24px 0 8px; }
  h3 { font-size: 13px; margin: 14px 0 6px; }
  table { width: 100%; border-collapse: collapse; }
  table.kv td { padding: 4px 0; vertical-align: top; }
  table.kv td.k { color: #6b7684; width: 190px; }
  table.kv td.v { font-weight: 500; }
  table.drives { font-size: 13px; }
  table.drives th { text-align: left; color: #6b7684; font-weight: 600; padding: 6px 10px 6px 0; border-bottom: 1px solid #eef1f5; }
  table.drives td { padding: 7px 10px 7px 0; border-bottom: 1px solid #f2f4f7; }
  .pill { font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 999px; background: #eef1f5; color: #6b7684; }
  .pill.ok { background: #e6f7ea; color: #1a7f37; }
  .pill.warn { background: #fdf2dc; color: #9a6a00; }
  ul.checks { list-style: none; padding: 0; margin: 0; }
  ul.checks li { padding: 3px 0; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 8px; background: #b9c1cc; vertical-align: middle; }
  .dot.good, .dot.ok { background: #1a7f37; }
  .dot.warn { background: #d29922; }
  .dot.bad { background: #b42318; }
  .muted { color: #8b95a5; }
  footer { margin-top: 26px; padding-top: 14px; border-top: 1px solid #eef1f5; color: #8b95a5; font-size: 12px; }
  @media print { body { background: #fff; padding: 0; } .sheet { border: 0; } }
</style></head>
<body><div class="sheet">
  <header>
    <div>
      <h1>PC Health Report</h1>
      <div class="sub">${esc(os.computerName || sys.hostname || 'This PC')} · ${esc(dateStr)}</div>
    </div>
    <span class="badge ${overall.cls}">${esc(overall.label)}</span>
  </header>

  <h2>System</h2>
  <table class="kv">${systemRows}</table>

  <h2>Storage health</h2>
  <table class="drives"><thead><tr><th>Drive</th><th>Type</th><th>Size</th><th>Health</th><th>Detail</th></tr></thead><tbody>${driveRows}</tbody></table>

  <h2>Stability</h2>
  ${stability}

  <h2>Security</h2>
  ${secSections || '<p class="muted">Security check not available.</p>'}

  <h2>Battery</h2>
  ${batterySection}

  <footer>Generated by PC Cleanup on ${esc(dateStr)}. Read-only snapshot of the machine at that time.</footer>
</div></body></html>`;
}

module.exports = { gather, latest, buildHtml };

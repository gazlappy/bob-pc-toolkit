'use strict';

// Speed test: measured internet throughput, and the local network's link rate
// and latency. Two honestly-different things —
//
//   * Internet — real bytes moved to and from Cloudflare's speed endpoint and
//     timed, giving download / upload Mbps plus latency and jitter.
//   * Local network — the NIC's negotiated link rate (1 Gbps, or 100 Mbps if a
//     bad cable dropped it) and the measured round-trip to the gateway. A true
//     LAN *throughput* figure needs a cooperating server on the other end, so
//     it is not invented here; the link rate and latency are what a technician
//     actually checks.
//
// The internet transfers run in the main process, where there is no page CSP to
// block them.

const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const network = require('./network');

const DOWN_URL = (bytes) => `https://speed.cloudflare.com/__down?bytes=${bytes}`;
const UP_URL = 'https://speed.cloudflare.com/__up';

// Download sources tried in order. Cloudflare is closest and fastest when it
// answers, but rate-limits its data endpoint hard per IP after a few tests, so
// there are static-file fallbacks that do not. A cache-buster is appended so a
// proxy never serves a repeat from cache. Whichever first delivers bytes is
// kept for the rest of the run.
const DOWNLOAD_SOURCES = [
  { name: 'Cloudflare', url: () => DOWN_URL(90_000_000) },
  { name: 'OVH', url: () => `https://proof.ovh.net/files/100Mb.dat?n=${Date.now()}` },
  { name: 'Hetzner', url: () => `https://speed.hetzner.de/100MB.bin?n=${Date.now()}` },
];

const DOWNLOAD_MS = 8000;
const UPLOAD_MS = 7000;
const LATENCY_SAMPLES = 12;

function mbps(bytes, seconds) {
  return seconds > 0 ? (bytes * 8) / seconds / 1e6 : 0;
}

/** avg / min / jitter (mean absolute difference between consecutive samples). */
function stats(values) {
  if (!values.length) return { avg: null, min: null, jitter: null };
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  let diffSum = 0;
  for (let i = 1; i < values.length; i += 1) diffSum += Math.abs(values[i] - values[i - 1]);
  const jitter = values.length > 1 ? diffSum / (values.length - 1) : 0;
  return { avg, min: Math.min(...values), jitter };
}

async function measureLatency(emit) {
  const rtts = [];
  for (let i = 0; i < LATENCY_SAMPLES; i += 1) {
    const t = performance.now();
    try {
      const res = await fetch(DOWN_URL(0), { cache: 'no-store' });
      await res.arrayBuffer();
      // The first request pays TLS/connection setup; leave it out of the stats.
      if (i > 0) rtts.push(performance.now() - t);
    } catch {
      /* a dropped sample just lowers the count */
    }
    emit({ phase: 'latency', pct: (i + 1) / LATENCY_SAMPLES });
  }
  const s = stats(rtts);
  return { latencyMs: s.avg, jitterMs: s.jitter, samples: rtts.length };
}

async function measureDownload(emit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_MS);
  let received = 0;
  let lastEmit = 0;
  let lastStatus = 0;
  let working = null;
  const start = performance.now();

  const tick = () => {
    const now = performance.now();
    // Reads arrive thousands of times a second; forward ~10/s so the renderer
    // is not flooded.
    if (now - lastEmit >= 100) {
      lastEmit = now;
      const secs = (now - start) / 1000;
      emit({ phase: 'download', mbps: mbps(received, secs), pct: Math.min(1, (secs * 1000) / DOWNLOAD_MS) });
    }
  };

  try {
    for (const source of DOWNLOAD_SOURCES) {
      if (working && working !== source) continue;
      // Pull from this source repeatedly until the budget, or it fails — in
      // which case fall through to the next source.
      while (performance.now() - start < DOWNLOAD_MS) {
        let res;
        try {
          res = await fetch(source.url(), { cache: 'no-store', signal: controller.signal });
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          break; // network error — try the next source
        }
        lastStatus = res.status;
        if (!res.ok || !res.body) break; // refused (e.g. 429) — try the next
        working = source;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          tick();
        }
      }
      if (working === source) break; // this source carried the whole run
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    clearTimeout(timer);
  }

  // No bytes from any source means all were refused (rate limit / error), not a
  // genuine zero — report it as unavailable so the UI does not show "0 Mbps".
  if (received === 0) return { mbps: null, status: lastStatus, source: null };
  const secs = (performance.now() - start) / 1000;
  return { mbps: mbps(received, secs), status: lastStatus, source: working ? working.name : null };
}

async function measureUpload(emit) {
  // One buffer, sent repeatedly until the time budget is spent. Each POST is a
  // fresh request — a little overhead, but honest and simple.
  const chunk = Buffer.allocUnsafe(4_000_000);
  let sent = 0;
  let lastStatus = 0;
  const start = performance.now();

  while (performance.now() - start < UPLOAD_MS) {
    try {
      const res = await fetch(UP_URL, { method: 'POST', body: chunk, cache: 'no-store', duplex: 'half' });
      lastStatus = res.status;
      if (!res.ok) break;
    } catch {
      break;
    }
    sent += chunk.length;
    const secs = (performance.now() - start) / 1000;
    emit({ phase: 'upload', mbps: mbps(sent, secs), pct: Math.min(1, (secs * 1000) / UPLOAD_MS) });
  }

  if (sent === 0) return { mbps: null, status: lastStatus };
  const secs = (performance.now() - start) / 1000;
  return { mbps: mbps(sent, secs), status: lastStatus };
}

function pingStats(host, count) {
  return new Promise((resolve) => {
    const child = spawn('ping.exe', ['-n', String(count), host], { windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve({ times: [], lossPct: 100 }));
    child.on('close', () => {
      const times = [...out.matchAll(/time[=<]\s*(\d+)\s*ms/gi)].map((m) => Number(m[1]));
      const lossMatch = out.match(/\((\d+)%\s*loss\)/i);
      resolve({ times, lossPct: lossMatch ? Number(lossMatch[1]) : times.length ? 0 : 100 });
    });
  });
}

async function measureLan(emit) {
  emit({ phase: 'lan' });
  let info;
  try {
    info = await network.info();
  } catch {
    return { gateway: null };
  }
  const adapter =
    info.adapters.find((a) => a.gateway) || info.adapters.find((a) => a.ipv4.length) || null;
  if (!adapter || !adapter.gateway) {
    return { gateway: null, linkSpeedMbps: adapter ? adapter.speedMbps : null };
  }

  const { times, lossPct } = await pingStats(adapter.gateway, 10);
  const s = stats(times);
  return {
    gateway: adapter.gateway,
    adapter: adapter.connection || adapter.name,
    linkSpeedMbps: adapter.speedMbps,
    latencyMs: s.avg,
    minMs: s.min,
    jitterMs: s.jitter,
    lossPct,
  };
}

/** Runs the whole test, streaming progress through `onProgress`. */
async function run(onProgress) {
  const emit = (event) => onProgress && onProgress(event);

  const latency = await measureLatency(emit);
  emit({ phase: 'latency-done', ...latency });

  const download = await measureDownload(emit);
  emit({ phase: 'download-done', downMbps: download.mbps, status: download.status, source: download.source });

  const upload = await measureUpload(emit);
  emit({ phase: 'upload-done', upMbps: upload.mbps, status: upload.status });

  const lan = await measureLan(emit);
  emit({ phase: 'lan-done', lan });

  // "Busy" means a transfer could not be measured at all (every source refused),
  // not merely that Cloudflare rate-limited before a fallback succeeded.
  const busy = download.mbps === null || upload.mbps === null;

  return {
    latencyMs: latency.latencyMs,
    jitterMs: latency.jitterMs,
    downMbps: download.mbps,
    upMbps: upload.mbps,
    source: download.source,
    busy,
    lan,
  };
}

module.exports = { run, __internals: { stats, mbps, measureDownload, DOWNLOAD_SOURCES } };

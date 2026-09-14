'use strict';

// PowerShell bridge.
//
// Spawning powershell.exe costs ~1.4s cold and ~220ms warm, which the app was
// paying on every single call. Instead one host process is kept alive and fed
// scripts over stdin, taking a typical call down to a few milliseconds.
//
// Each script is sent base64-encoded on a single line and run through
// [scriptblock]::Create in a child scope, which avoids two problems at once:
// stdin-fed PowerShell mis-parsing multi-line blocks, and variables from one
// call leaking into the next. A sentinel line marks the end of each reply.

const { spawn, execFile } = require('child_process');

const ARGS = ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass'];
const PREAMBLE = [
  '$ProgressPreference = "SilentlyContinue"',
  '$ErrorActionPreference = "Continue"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$OutputEncoding = [System.Text.Encoding]::UTF8',
].join('; ');

let host = null;
let sequence = 0;
let chain = Promise.resolve();
let disposed = false;

function startHost() {
  const child = spawn('powershell.exe', [...ARGS, '-Command', '-'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const forget = () => {
    if (host === child) host = null;
  };
  child.on('error', forget);
  child.on('exit', forget);
  child.stdin.on('error', forget);

  child.stdin.write(`${PREAMBLE}\n`);
  return child;
}

function ensureHost() {
  if (!host && !disposed) host = startHost();
  return host;
}

// Fallback for the rare case where the long-lived host cannot be used.
function runOnce(script, timeout) {
  const encoded = Buffer.from(`${PREAMBLE}\n${script}`, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [...ARGS, '-EncodedCommand', encoded],
      { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout || '');
        if (err && !out.trim()) return reject(new Error(String(stderr || err.message).trim()));
        resolve(out);
      }
    );
  });
}

function send(child, script, timeout) {
  return new Promise((resolve, reject) => {
    sequence += 1;
    const marker = `<<PCC-END-${sequence}-${process.pid}>>`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onOut);
      child.stderr.off('data', onErr);
      child.off('exit', onExit);
      fn(value);
    };

    const timer = setTimeout(() => {
      // A wedged host would stall every later call, so replace it outright.
      if (host === child) {
        host = null;
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
      finish(reject, new Error('PowerShell timed out.'));
    }, timeout);

    const onOut = (chunk) => {
      stdout += chunk;
      const at = stdout.indexOf(marker);
      if (at !== -1) finish(resolve, { stdout: stdout.slice(0, at), stderr });
    };
    const onErr = (chunk) => {
      stderr += chunk;
    };
    const onExit = () => finish(reject, new Error('The PowerShell host stopped unexpectedly.'));

    child.stdout.on('data', onOut);
    child.stderr.on('data', onErr);
    child.once('exit', onExit);

    const line =
      `try { & ([scriptblock]::Create(` +
      `[System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))` +
      `)) } catch { [Console]::Error.WriteLine($_.Exception.Message) } ` +
      `finally { [Console]::Out.WriteLine('${marker}') }\n`;

    try {
      child.stdin.write(line);
    } catch (error) {
      finish(reject, error);
    }
  });
}

/** Runs a script and resolves with its stdout. Calls are serialised. */
function run(script, { timeout = 180000 } = {}) {
  const attempt = async () => {
    const child = ensureHost();
    if (!child) return runOnce(script, timeout);
    try {
      const { stdout } = await send(child, script, timeout);
      return stdout;
    } catch (error) {
      if (/timed out/i.test(error.message)) throw error;
      // The host died mid-flight; do this one the slow, reliable way.
      return runOnce(script, timeout);
    }
  };

  const result = chain.then(attempt, attempt);
  chain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** Starts the host early so the first real call does not pay the cold start. */
function warmUp() {
  if (disposed) return Promise.resolve(false);
  return run('$null').then(
    () => true,
    () => false
  );
}

function dispose() {
  disposed = true;
  if (host) {
    try {
      host.stdin.end();
      host.kill();
    } catch {
      /* already gone */
    }
    host = null;
  }
}

async function json(script, options) {
  const text = (await run(script, options)).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unexpected PowerShell output: ${text.slice(0, 300)}`);
  }
}

// ConvertTo-Json collapses a one-element array into a bare object, so every
// list that comes back from PowerShell goes through this.
function arr(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

// Defines $Payload inside the script from a JS value.
function payload(value) {
  const b64 = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  return `$Payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')) | ConvertFrom-Json`;
}

// Wraps a mutating script so failures come back as data rather than as a
// rejected promise with a wall of PowerShell error text.
function guarded(body) {
  return [
    '$ErrorActionPreference = "Stop"',
    'try {',
    body,
    '  [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress',
    '} catch {',
    '  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress',
    '}',
  ].join('\n');
}

// Runs a guarded script and throws if PowerShell reported a failure.
async function mutate(body, options) {
  const result = await json(guarded(body), options);
  if (!result || result.ok !== true) {
    throw new Error((result && result.error) || 'The operation failed.');
  }
  return true;
}

module.exports = { run, json, arr, payload, guarded, mutate, warmUp, dispose };

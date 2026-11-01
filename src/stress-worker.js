'use strict';

// One thread of load for the stress test. Every round's answer is known in
// advance, so a wrong answer is a real hardware error rather than just a hot PC.
// Loaded as text and run with eval because a Worker cannot start from inside the
// packed app archive. stress.js also requires it, for the known-good answer.

const crypto = require('crypto');
const { isMainThread, parentPort, workerData } = require('worker_threads');

const SEED = Buffer.alloc(1 << 20);
for (let i = 0; i < SEED.length; i += 1) SEED[i] = (i * 2654435761) >>> 24;

const SIZE = 96;
const A = new Float64Array(SIZE * SIZE);
const B = new Float64Array(SIZE * SIZE);
const C = new Float64Array(SIZE * SIZE);
for (let i = 0; i < A.length; i += 1) {
  A[i] = Math.sin(i * 0.37) + 1.5;
  B[i] = Math.cos(i * 0.11) - 0.25;
}

function cpuRound() {
  let hash = crypto.createHash('sha256').update(SEED).digest();
  for (let i = 0; i < 24; i += 1) hash = crypto.createHash('sha256').update(hash).update(SEED).digest();
  let total = 0;
  for (let pass = 0; pass < 6; pass += 1) {
    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c < SIZE; c += 1) {
        let sum = 0;
        for (let k = 0; k < SIZE; k += 1) sum += A[r * SIZE + k] * B[k * SIZE + c];
        C[r * SIZE + c] = sum;
      }
    }
    total += C[(pass * 37) % C.length];
  }
  let primes = 0;
  for (let n = 3; n < 60000; n += 2) {
    let prime = true;
    for (let d = 3; d * d <= n; d += 2) {
      if (n % d === 0) {
        prime = false;
        break;
      }
    }
    if (prime) primes += 1;
  }
  return `${hash.toString('hex')}:${total}:${primes}`;
}

function runCpu(expected) {
  let rounds = 0;
  let errors = 0;
  let last = Date.now();
  for (;;) {
    if (cpuRound() !== expected) errors += 1;
    rounds += 1;
    if (Date.now() - last > 1000) {
      parentPort.postMessage({ rounds, errors });
      rounds = 0;
      errors = 0;
      last = Date.now();
    }
  }
}

// Writes a value that differs at every address, reads it all back, then repeats
// with new values, so stuck bits and addressing faults both show.
function runMemory(bytes) {
  let block;
  try {
    block = new Uint32Array(new ArrayBuffer(bytes));
  } catch {
    parentPort.postMessage({ allocated: 0, failed: true });
    return;
  }
  block.fill(1);
  parentPort.postMessage({ allocated: bytes });
  const SEEDS = [0x00000000, 0xffffffff, 0xaaaaaaaa, 0x55555555, 0x12345678, 0xedcba987];
  for (let pass = 0; ; pass += 1) {
    const seed = SEEDS[pass % SEEDS.length];
    const step = (pass % 7) + 1;
    for (let i = 0; i < block.length; i += 1) block[i] = (seed ^ Math.imul(i, step)) >>> 0;
    let errors = 0;
    for (let i = 0; i < block.length; i += 1) {
      if (block[i] !== ((seed ^ Math.imul(i, step)) >>> 0)) errors += 1;
    }
    parentPort.postMessage({ passes: 1, errors });
  }
}

if (!isMainThread) {
  if (workerData.kind === 'cpu') runCpu(workerData.expected);
  else runMemory(workerData.bytes);
}

module.exports = { cpuRound };

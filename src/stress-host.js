'use strict';

// The process the stress threads live in. Below-normal priority still takes every
// spare cycle, but gives way to BOB and to the temperature readings, which would
// otherwise starve and leave the safety stop blind. A forked child outlives a
// killed parent, so it exits as soon as its link to BOB goes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { cpuRound } = require('./stress-worker');

try {
  os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  /* runs at normal priority: readings are slower, the test still works */
}

process.on('disconnect', () => process.exit(0));

process.once('message', ({ threads, blocks }) => {
  const source = fs.readFileSync(path.join(__dirname, 'stress-worker.js'), 'utf8');
  const start = (kind, workerData) => {
    const worker = new Worker(source, { eval: true, workerData });
    worker.on('message', (message) => process.send({ kind, ...message }));
    worker.on('error', () => process.send({ kind, crashed: 1 }));
  };
  if (threads) {
    const expected = cpuRound();
    for (let i = 0; i < threads; i += 1) start('cpu', { kind: 'cpu', expected });
  }
  for (const bytes of blocks) start('memory', { kind: 'memory', bytes });
});

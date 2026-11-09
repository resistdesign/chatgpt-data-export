#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyArchive } from './exporter.js';

const output = resolve(process.argv[2] ?? join(homedir(), 'ChatGPT-Data-Export'));
verifyArchive(output).then(results => {
  let problems = 0;
  for (const r of results) {
    problems += r.partial + r.failed.length + r.otherMissing.length;
    process.stdout.write(`${r.key}: ${r.complete}/${r.expected} complete, ${r.partial} partial, ${r.failed.length} missing/corrupt, ${r.otherMissing.length} account/Project problems\n`);
  }
  if (problems) process.exitCode = 2;
}, error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

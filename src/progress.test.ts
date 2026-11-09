import test from 'node:test';
import assert from 'node:assert/strict';
import { Progress, type ProgressSnapshot } from './progress.js';

test('conversation progress separates attempted, fully saved, partial and reused counts', () => {
  const snapshots: ProgressSnapshot[] = [];
  const progress = new Progress(snapshot => snapshots.push(snapshot), false);
  progress.set('Saving Project files', 3, 39, 'Project metadata');
  progress.set('Capturing', 0, 25, 'Checking checkpoints');
  progress.set('Capturing', 24, 25, 'Downloading conversation attachments', {
    attempted: 24, complete: 16, partial: 8, failed: 0, reused: 7, active: 1,
  });
  progress.waiting('cooldown: next request in 1s');
  const latest = snapshots.at(-1)!;
  assert.equal(latest.done, 24);
  assert.equal(latest.total, 25);
  assert.equal(latest.capture?.complete, 16);
  assert.equal(latest.capture?.partial, 8);
  assert.equal(latest.capture?.reused, 7);
  assert.equal(latest.note, 'Downloading conversation attachments');
  assert.equal(latest.waiting, 'cooldown: next request in 1s');
  assert.equal(latest.etaSeconds, null, 'do not invent estimates for unpredictable attachment retries');
  assert.ok(latest.stageSeconds <= latest.seconds, 'stage elapsed must not exceed total runtime');
});

test('entering a new stage clears old conversation metrics', () => {
  const snapshots: ProgressSnapshot[] = [];
  const progress = new Progress(snapshot => snapshots.push(snapshot), false);
  progress.set('Capturing', 2, 5, 'Saving', {
    attempted: 2, complete: 1, partial: 1, failed: 0, reused: 0, active: 0,
  });
  progress.set('Verifying', 0, 5, 'Hashing');
  const latest = snapshots.at(-1)!;
  assert.equal(latest.capture, undefined);
  assert.equal(latest.done, 0);
  assert.equal(latest.note, 'Hashing');
});

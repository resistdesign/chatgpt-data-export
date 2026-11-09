import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('compiled dashboard retains the missing Project file label after state updates', async () => {
  const [renderer, html] = await Promise.all([
    readFile(new URL('./desktop/renderer.js', import.meta.url), 'utf8'),
    readFile(new URL('./desktop/ui/index.html', import.meta.url), 'utf8'),
  ]);
  const label = 'Observe a missing Project file';

  assert.ok(html.includes(`id="observe-file"`), 'the observer button is present');
  assert.ok(html.includes(label), 'the original HTML shows the correct label');
  assert.match(
    renderer,
    /observe\.textContent\s*=\s*state\.fileObservation\.active\s*\?\s*'Stop observing download'\s*:\s*'Observe a missing Project file'/,
    'render(state) must not replace the correct label with a stale one',
  );
  assert.ok(!renderer.includes('Observe one ChatGPT download'), 'obsolete label must not reappear');
});

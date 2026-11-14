// -----------------------------------------------------------------------------
// FileStore on a real temporary directory: the count reaches the disk through
// a temporary file synced, a rename, and a sync of the directory (without it
// the rename may be lost on a power cut).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../src/store.js';

test('save: temporary file synced, renamed, then the directory synced; mode 0600', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'azure-speech-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const events = [];
  const fs = {
    readFile,
    rename: async (from, to) => {
      events.push([
        'rename',
        from === join(dir, 'azure-speech.json.tmp') && to === join(dir, 'azure-speech.json'),
      ]);
      return rename(from, to);
    },
    open: async (path, ...args) => {
      const handle = await open(path, ...args);
      const kind = path === dir ? 'dir' : 'file';
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push(['sync', kind]);
        return sync();
      };
      return handle;
    },
  };
  const store = new FileStore({ dir, fs });
  await store.save({ usage: { month: '2026-11', used: 42 } });
  assert.deepEqual(events, [
    ['sync', 'file'],
    ['rename', true],
    ['sync', 'dir'],
  ]);
  assert.deepEqual(await store.load(), { usage: { month: '2026-11', used: 42 } });
  assert.deepEqual(await readdir(dir), ['azure-speech.json']);
  assert.equal((await stat(join(dir, 'azure-speech.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(dir, 'azure-speech.json'), 'utf8')).usage.used, 42);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const script = fileURLToPath(new URL('./from-fal.mjs', import.meta.url));
const run = async (...args) => {
  try { const { stdout } = await exec(process.execPath, [script, ...args]); return { code: 0, out: JSON.parse(stdout) }; }
  catch (error) { return { code: error.code, out: error.stdout ? JSON.parse(error.stdout) : null, err: error.stderr }; }
};

test('translates a fal request and writes fal defaults explicitly', async () => {
  const { code, out } = await run('bytedance/seedance-2.5/image-to-video', '--json', JSON.stringify({ prompt: 'a boat', image_url: 'https://example.com/a.png', duration: '5' }));
  assert.equal(code, 0);
  assert.equal(out.request.model, 'bytedance/seedance-2.5');
  assert.equal(out.request.parameters.generate_audio, true);
  assert.deepEqual(out.request.input.references, [{ role: 'first_frame', url: 'https://example.com/a.png' }]);
});

test('exits 1 with reasons when the request needs changes', async () => {
  const { code, out } = await run('bytedance/seedance-2.5/text-to-video', '--json', '{"prompt":"a boat"}');
  assert.equal(code, 1);
  assert.equal(out.errors[0].field, 'duration');
});

test('lists mapped endpoints and rejects bad usage', async () => {
  const { code, out } = await run('--list');
  assert.equal(code, 0);
  assert.ok(out.some(row => row.fal === 'fal-ai/nano-banana-2' && row.yir === 'google/nano-banana-2' && row.supported));
  assert.equal((await run('fal-ai/nano-banana-2')).code, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const script = fileURLToPath(new URL('./from-fal.mjs', import.meta.url));
const run = async (args, env) => {
  try { const { stdout } = await exec(process.execPath, [script, ...args], { env }); return { code: 0, out: JSON.parse(stdout) }; }
  catch (error) { return { code: error.code, out: error.stdout ? JSON.parse(error.stdout) : null, err: error.stderr }; }
};

test('translates a fal request and writes fal defaults explicitly', async () => {
  const { code, out } = await run(['bytedance/seedance-2.5/image-to-video', '--json', JSON.stringify({ prompt: 'a boat', image_url: 'https://example.com/a.png', duration: '5' })]);
  assert.equal(code, 0);
  assert.equal(out.request.model, 'bytedance/seedance-2.5');
  assert.equal(out.request.parameters.generate_audio, true);
  assert.deepEqual(out.request.input.references, [{ role: 'first_frame', url: 'https://example.com/a.png' }]);
});

test('exits 1 with reasons when the request needs changes', async () => {
  const { code, out } = await run(['bytedance/seedance-2.5/text-to-video', '--json', '{"prompt":"a boat"}']);
  assert.equal(code, 1);
  assert.equal(out.errors[0].field, 'duration');
});

test('lists mapped endpoints and rejects bad usage', async () => {
  const { code, out } = await run(['--list']);
  assert.equal(code, 0);
  assert.ok(out.some(row => row.fal === 'fal-ai/nano-banana-2' && row.yir === 'google/nano-banana-2' && row.supported));
  assert.equal((await run(['fal-ai/nano-banana-2'])).code, 2);
});

test('quotes each translated operation on its own route', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path: req.url, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ supply: { available: true }, expected_amount: '0.000500' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ...process.env, YIR_API_KEY: 'fixture-key', YIR_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  const voice = 'English_expressive_narrator';
  const speech = { prompt: 'Hello', voice_setting: { voice_id: voice }, output_format: 'url' };
  for (const [endpoint, body] of [
    ['meta/muse-image/text-to-image', { prompt: 'A red balloon', aspect_ratio: '1:1' }],
    ['bytedance/seedance-2.5/image-to-video', { prompt: 'a boat', image_url: 'https://example.com/a.png', duration: '5' }],
    ['fal-ai/minimax/speech-2.8-hd', speech],
  ]) {
    const { code, out } = await run([endpoint, '--json', JSON.stringify(body), '--quote'], env);
    assert.equal(code, 0, JSON.stringify(out));
    assert.deepEqual(out.quote, { available: true, expected_amount_usd: '0.000500', per_job: true });
  }
  assert.deepEqual(requests.map(({ method, path }) => [method, path]), [
    ['POST', '/v1/images/quotes'], ['POST', '/v1/videos/quotes'], ['POST', '/v1/audio/quotes'],
  ]);
  assert.deepEqual(requests[2].body, { model: 'minimax/speech-2.8-hd', input: { type: 'text', prompt: 'Hello' }, parameters: { voice } });

  const { code, out } = await run(['fal-ai/minimax/speech-2.8-hd', '--json', JSON.stringify({ ...speech, voice_setting: undefined }), '--quote'], env);
  assert.equal(code, 1);
  assert.equal(out.errors[0].field, 'voice_setting');
  assert.equal(requests.length, 3);
});

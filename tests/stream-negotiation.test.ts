import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialState, JsonStore } from '../src/main/store';
import { PetService } from '../src/main/service';
import { testAiConnection } from '../src/main/ai';

test('a provider explicitly requiring streaming is retried once and its Responses event stream is understood', async t => {
  const requests: { body: any; accept?: string }[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push({ body, accept: req.headers.accept });
    if (!body.stream) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stream must be set to true', code: 'invalid_request' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n');
    res.end('event: response.completed\ndata: {"type":"response.completed","response":{"output_text":"OK","output":[]}}\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address() as { port: number };
  const result = await testAiConnection({ ...initialState().settings, baseUrl: `http://127.0.0.1:${port}`, protocol: 'responses', apiKey: 'fixture-key' });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.stream, false);
  assert.equal(requests[1].body.stream, true);
  assert.equal(requests[1].body.store, false);
  assert.equal(requests[1].accept, 'text/event-stream');
  assert.equal(result.endpoint, `http://127.0.0.1:${port}/v1/responses`);
});

test('malformed native tool arguments cannot create tasks or memories', async t => {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ output: [{ type: 'function_call', name: 'mika_reply', arguments: '{incomplete' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mika-tool-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = new PetService(new JsonStore(dir), 'darwin');
  const { port } = server.address() as { port: number };
  service.saveSettings({ baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'responses', apiKey: 'fixture-key' });
  const state = await service.sendMessage('请记住我喜欢早上写作，并提醒我写作');
  assert.equal(state.tasks.length, 0);
  assert.equal(state.memories.length, 0);
  assert.match(state.messages.at(-1)!.text, /操作参数不完整/);
});

test('an explicit stream_required code negotiates streaming without requiring a literal true in the error', async t => {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    if (!body.stream) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'stream_required', message: 'Streaming is required for this endpoint.' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: response.completed\ndata: {"type":"response.completed","response":{"output_text":"OK"}}\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address() as { port: number };
  const result = await testAiConnection({ ...initialState().settings, baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'responses', apiKey: 'fixture-key' });
  assert.equal(result.ok, true);
  assert.deepEqual(requests.map(request => request.stream), [false, true]);
});

test('a natural-language promise to call the user at a time reports that no reminder or memory was persisted', async t => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ output_text: '好的，明天下午三点准时叫你开会。' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mika-unsubmitted-reminder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = new PetService(new JsonStore(dir), 'darwin');
  const { port } = server.address() as { port: number };
  service.saveSettings({ baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'responses', apiKey: 'fixture-key' });
  const state = await service.sendMessage('明天下午三点叫我开会');
  assert.match(state.messages.at(-1)!.text, /明天下午三点准时叫你开会/);
  assert.match(state.messages.at(-1)!.text, /未实际修改待办或长期记忆/);
  assert.equal(state.tasks.length, 0);
  assert.equal(state.memories.length, 0);
  const restored = new JsonStore(dir);
  assert.equal(restored.state.tasks.length, 0);
  assert.equal(restored.state.memories.length, 0);
});

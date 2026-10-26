import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { JsonStore } from '../src/main/store';
import { PetService } from '../src/main/service';
import { askAi, parseAiResult } from '../src/main/ai';

function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-service-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, service: new PetService(new JsonStore(dir), 'darwin') };
}

test('tasks and chat survive a fresh service instance; API key stays outside snapshots', async t => {
  const { dir, service } = setup(t);
  await service.sendMessage('10分钟后提醒我喝水');
  service.saveSettings({ apiKey: 'test-secret', model: 'test-model' });
  const restored = new PetService(new JsonStore(dir), 'darwin');
  assert.equal(restored.snapshot().tasks.length, 1);
  assert.equal(restored.snapshot().tasks[0].title.includes('喝水'), true);
  assert.equal(restored.snapshot().messages.length, 3);
  assert.equal(restored.snapshot().settings.apiKeyConfigured, true);
  assert.equal(JSON.stringify(restored.snapshot()).includes('test-secret'), false);
});

test('reminders are durable, show overdue work, and fire again after snooze only', t => {
  const { dir, service } = setup(t);
  const now = new Date('2026-10-23T10:00:00+08:00');
  const task = service.createTask({ title: '交报告', dueAt: '2026-10-23T09:00:00+08:00' });
  assert.equal(service.collectReminders(now).length, 1);
  const restored = new PetService(new JsonStore(dir), 'darwin');
  assert.equal(restored.collectReminders(now).length, 0);
  assert.equal(restored.snapshot().reminders.length, 1);
  restored.dismissReminder(task.id);
  assert.equal(restored.collectReminders(now).length, 0);
  restored.snoozeTask(task.id, 10, now);
  assert.equal(restored.snapshot().reminders.length, 0);
  assert.equal(restored.collectReminders(new Date(now.getTime() + 9 * 60000)).length, 0);
  assert.equal(restored.collectReminders(new Date(now.getTime() + 10 * 60000)).length, 1);
  restored.updateTask(task.id, { status: 'completed' });
  assert.equal(restored.snapshot().reminders.length, 0);
  assert.equal(restored.collectReminders(new Date(now.getTime() + 30 * 60000)).length, 0);
});

test('deleting a task removes its reminder; invalid times never enter the store', t => {
  const { service } = setup(t);
  assert.throws(() => service.createTask({ title: '测试', dueAt: 'invalid' }));
  assert.equal(service.snapshot().tasks.length, 0);
  const task = service.createTask({ title: '测试', dueAt: new Date(0).toISOString() });
  service.collectReminders();
  service.deleteTask(task.id);
  assert.equal(service.snapshot().tasks.length, 0);
  assert.equal(service.snapshot().reminders.length, 0);
});

test('corrupt persisted data is reported without overwriting it', t => {
  const { dir } = setup(t);
  const file = path.join(dir, 'mika-data.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => new JsonStore(dir));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('AI rejects invented IDs, ambiguous timestamps and malformed actions before applying them', () => {
  assert.throws(() => parseAiResult('{"reply":"好了","actions":[{"type":"complete","id":"missing"}]}', []));
  assert.throws(() => parseAiResult('{"reply":"好了","actions":[{"type":"create","task":{"title":"开会","dueAt":"2026-10-24T15:00:00"}}]}', []));
  assert.throws(() => parseAiResult('{"reply":"好了","actions":[{"type":"delete","id":"missing"}]}', []));
});

test('configured AI route sends context, applies real model-shaped actions, and persists results', async t => {
  const { dir, service } = setup(t);
  let requestBody: any;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer test-key');
    let body = '';
    for await (const chunk of req) body += chunk;
    requestBody = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: '已记下买牛奶，还没有设置提醒时间。', actions: [{ type: 'create', task: { title: '买牛奶', dueAt: null, durationMinutes: 15, priority: 'normal' } }] }) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number };
  service.saveSettings({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key', model: 'test-model' });
  await service.sendMessage('帮我记一下买牛奶');
  assert.equal(requestBody.model, 'test-model');
  assert.equal(requestBody.messages.at(-1).content, '帮我记一下买牛奶');
  assert.equal(service.snapshot().tasks[0].title, '买牛奶');
  assert.equal(new PetService(new JsonStore(dir), 'darwin').snapshot().tasks.length, 1);
});

test('provider failure remains visible and never falls back to unannounced task changes', async t => {
  const { service } = setup(t);
  const server = http.createServer((_req, res) => { res.writeHead(401); res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number };
  service.saveSettings({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'test-key' });
  const state = await service.sendMessage('10分钟后提醒我喝水');
  assert.equal(state.tasks.length, 0);
  assert.match(state.messages.at(-1)!.text, /API Key 无效/);
});

test('a delayed AI response preserves manual edits and does not partially apply its action batch', async t => {
  const { service } = setup(t);
  const task = service.createTask({ title: '开会', dueAt: '2026-10-24T07:00:00Z' });
  let release!: () => void;
  let received!: () => void;
  const responseGate = new Promise<void>(resolve => { release = resolve; });
  const requestReceived = new Promise<void>(resolve => { received = resolve; });
  const server = http.createServer(async (_req, res) => {
    received();
    await responseGate;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      reply: '已调整。', actions: [
        { type: 'create', task: { title: '不应部分创建', dueAt: null } },
        { type: 'update', id: task.id, patch: { dueAt: '2026-10-24T07:30:00Z' } },
      ],
    }) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { release(); server.closeAllConnections(); server.close(); });
  const { port } = server.address() as { port: number };
  service.saveSettings({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key' });
  const pending = service.sendMessage('把开会改到明天三点半');
  await requestReceived;
  service.updateTask(task.id, { dueAt: '2026-10-25T08:00:00Z' });
  release();
  const state = await pending;
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].dueAt, '2026-10-25T08:00:00Z');
  assert.match(state.messages.at(-1)!.text, /已保留你的新修改/);
});

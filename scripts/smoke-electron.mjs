import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';

const require = createRequire(import.meta.url);
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mika-electron-'));
const failures = [];
let app;
let modelServer;
let releaseModel = () => {};

async function launch() {
  const instance = await electron.launch({
    executablePath: require('electron'),
    args: [...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []), '.'],
    cwd: process.cwd(), timeout: 30_000,
    env: { ...process.env, MIKA_DATA_DIR: dataDir, MIKA_DEV_URL: '', MOMO_DEV_URL: '' },
  });
  app = instance;
  instance.on('window', win => win.on('pageerror', error => failures.push(error.message)));
  await instance.firstWindow();
  let panel;
  for (let attempt = 0; attempt < 100; attempt++) {
    panel = instance.windows().find(win => win.url().includes('view=panel'));
    if (panel) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!panel) throw new Error(`Panel not found: ${instance.windows().map(win => win.url()).join(', ')}`);
  await panel.waitForFunction(() => Boolean(window.petApi));
  await panel.locator('.app-shell').waitFor();
  return { instance, panel };
}

try {
  let launched = await launch();
  app = launched.instance;
  let panel = launched.panel;
  assert.equal((await panel.evaluate(() => window.petApi.getState())).platform, process.platform);
  const personal = await panel.evaluate(async () => {
    await window.petApi.saveProfile({ name: '小林', role: '个人开发者', preferences: '先给结论，再给具体步骤' });
    const added = await window.petApi.addMemory({ content: '我喜欢在上午处理需要专注的事情', category: 'preference' });
    const memory = added.memories.find(item => item.content === '我喜欢在上午处理需要专注的事情');
    await window.petApi.updateMemory(memory.id, { content: '我偏好上午专注工作，下午处理杂事', category: 'routine' });
    const temporary = await window.petApi.addMemory({ content: '这条临时记忆应该被删除', category: 'other' });
    return window.petApi.deleteMemory(temporary.memories.find(item => item.content === '这条临时记忆应该被删除').id);
  });
  assert.equal(personal.profile.name, '小林');
  assert.equal(personal.memories.length, 1);
  const memoryId = personal.memories[0].id;
  assert.equal(personal.memories[0].content, '我偏好上午专注工作，下午处理杂事');
  await panel.getByRole('textbox', { name: '告诉米卡你的安排' }).fill('3秒后提醒我喝水');
  await panel.getByRole('button', { name: '发送消息', exact: true }).click();
  await panel.getByRole('button', { name: '完成 喝水', exact: true }).waitFor();
  const initial = await panel.evaluate(() => window.petApi.getState());
  const id = initial.tasks[0].id;
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('view=panel'));
    window.close();
  });
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('view=panel')).isVisible()), false);
  await panel.locator('.reminder-banner').waitFor({ state: 'attached', timeout: 12_000 });
  const reminded = await panel.evaluate(() => window.petApi.getState());
  assert.equal(reminded.reminders[0].taskId, id);
  assert.ok(reminded.tasks[0].lastNotifiedAt);
  await panel.evaluate(() => window.petApi.openPanel());
  await panel.locator('.reminder-banner').waitFor();
  await fs.mkdir('test-results', { recursive: true });
  await panel.screenshot({ path: 'test-results/desktop-reminder.png' });
  await app.close(); app = null;

  launched = await launch();
  app = launched.instance; panel = launched.panel;
  const restored = await panel.evaluate(() => window.petApi.getState());
  assert.equal(restored.tasks.length, 1);
  assert.equal(restored.tasks[0].id, id);
  assert.equal(restored.tasks[0].lastNotifiedAt, reminded.tasks[0].lastNotifiedAt);
  assert.equal(restored.reminders.length, 1);
  assert.equal(restored.profile.name, '小林');
  assert.equal(restored.profile.preferences, '先给结论，再给具体步骤');
  assert.equal(restored.memories.length, 1);
  assert.equal(restored.memories[0].id, memoryId);
  assert.equal(restored.memories[0].category, 'routine');
  assert.equal(restored.memories[0].content, '我偏好上午专注工作，下午处理杂事');
  await panel.getByRole('button', { name: '稍后 10 分钟', exact: true }).click();
  await panel.locator('.reminder-banner').waitFor({ state: 'detached' });
  const snoozed = await panel.evaluate(() => window.petApi.getState());
  assert.ok(Date.parse(snoozed.tasks[0].dueAt) > Date.now() + 9 * 60_000);
  await panel.getByRole('button', { name: '完成 喝水', exact: true }).click();
  await panel.getByRole('button', { name: '完成 喝水', exact: true }).waitFor({ state: 'detached' });
  assert.equal((await panel.evaluate(() => window.petApi.getState())).tasks[0].status, 'completed');
  await panel.evaluate(() => window.petApi.saveSettings({ apiKey: 'ipc-test-key' }));
  assert.equal(JSON.stringify(await panel.evaluate(() => window.petApi.getState())).includes('ipc-test-key'), false);
  const pet = app.windows().find(win => win.url().includes('view=pet'));
  assert.ok(pet, 'desktop pet window exists');
  await pet.locator('.pet-character-button').waitFor();
  await pet.screenshot({ path: 'test-results/desktop-pet.png', omitBackground: true });

  let receivedModel;
  const modelRequested = new Promise(resolve => { receivedModel = resolve; });
  const modelGate = new Promise(resolve => { releaseModel = resolve; });
  modelServer = http.createServer(async (_req, res) => {
    receivedModel();
    await modelGate;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: '今天的事情已经完成，休息一下吧。', actions: [] }) } }] }));
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const { port } = modelServer.address();
  await panel.evaluate(baseUrl => window.petApi.saveSettings({ baseUrl, apiKey: 'local-fixture-key', model: 'fixture', protocol: 'chat-completions' }), `http://127.0.0.1:${port}/v1`);
  const replyPending = panel.evaluate(() => window.petApi.sendMessage('帮我安排今天'));
  replyPending.catch(() => {});
  await modelRequested;
  await pet.locator('.momo-pet[data-state="thinking"]').waitFor();
  assert.equal((await panel.evaluate(() => window.petApi.getState())).assistantBusy, true);
  await pet.screenshot({ path: 'test-results/desktop-thinking.png', omitBackground: true });
  releaseModel();
  await replyPending;
  await pet.locator('.momo-pet[data-state="idle"]').waitFor();
  await pet.screenshot({ path: 'test-results/desktop-idle.png', omitBackground: true });
  assert.equal((await panel.evaluate(() => window.petApi.getState())).assistantBusy, false);
  assert.deepEqual(failures, []);
  console.log('Mika desktop smoke passed: actual Electron IPC, profile and memory CRUD with restart persistence, closed-panel reminders, deduplication, snooze, complete, dragon pet, and shared AI thinking state.');
} finally {
  releaseModel();
  if (modelServer) { modelServer.closeAllConnections(); modelServer.close(); }
  if (app) await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}

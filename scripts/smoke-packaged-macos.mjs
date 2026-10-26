import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// This checks the application extracted from the distributable ZIP, not the
// development Electron executable or a loose copy of dist/.
if (process.platform !== 'darwin') {
  console.log(`SKIP packaged macOS smoke: a macOS runner is required (current platform: ${process.platform}).`);
  process.exit(0);
}

const arch = process.env.MIKA_ARCH || process.env.MOMO_ARCH || process.arch;
assert.ok(['arm64', 'x64'].includes(arch), 'MIKA_ARCH must be arm64 or x64');
const bundle = path.resolve('release', `verify-${arch}`, 'Mika.app');
const executablePath = path.join(bundle, 'Contents', 'MacOS', 'Mika');
await fs.access(executablePath, constants.X_OK);
await fs.access(path.join(bundle, 'Contents', 'Resources', 'app.asar'), constants.R_OK);

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `mika-packaged-${arch}-`));
const failures = [];
let app;
let passed = false;

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function within(promise, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeApp() {
  if (!app) return;
  const current = app;
  app = undefined;
  try {
    await within(current.close(), 15_000, 'Closing the packaged application');
  } catch (error) {
    // A stuck application must not survive the job or retain its test profile.
    current.process().kill('SIGKILL');
    throw error;
  }
}

async function findView(instance, view) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = instance.windows().find(window => {
      try { return new URL(window.url()).searchParams.get('view') === view; }
      catch { return false; }
    });
    if (found) {
      found.setDefaultTimeout(15_000);
      await found.waitForFunction(() => Boolean(window.petApi), undefined, { polling: 100, timeout: 15_000 });
      return found;
    }
    await pause(100);
  }
  throw new Error(`Packaged ${view} window was not created. URLs: ${instance.windows().map(window => window.url()).join(', ')}`);
}

async function checkDragonArtwork(window, label) {
  await window.locator('.momo-pet').first().waitFor({ state: 'attached' });
  const decoded = await within(window.evaluate(async () => {
    const images = [...document.querySelectorAll('.momo-pet img.momo-image')];
    await Promise.all(images.map(image => image.decode()));
    return images.map(image => ({ src: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight }));
  }), 15_000, `Decoding ${label} dragon artwork`);
  assert.ok(decoded.length > 0, `${label} must contain the bundled dragon artwork`);
  for (const image of decoded) {
    assert.ok(image.src.startsWith('file:'), `${label} artwork must load from the packaged files`);
    assert.ok(image.width > 0 && image.height > 0, `${label} dragon artwork failed to decode`);
  }
}

async function launch() {
  console.log(`Launching packaged ${arch} Mika.app`);
  const instance = await electron.launch({
    executablePath,
    // The app's own app.asar supplies its entry point. Passing "." here would
    // accidentally exercise the checkout instead of the installed application.
    args: [],
    cwd: process.cwd(),
    timeout: 30_000,
    env: { ...process.env, MIKA_DATA_DIR: dataDir, MIKA_DEV_URL: '', MOMO_DEV_URL: '' },
  });
  app = instance;
  const tracked = new Set();
  const trackWindow = window => {
    if (tracked.has(window)) return;
    tracked.add(window);
    window.on('pageerror', error => failures.push(error.message));
    window.on('crash', () => failures.push('A packaged renderer crashed'));
  };
  instance.on('window', trackWindow);
  instance.windows().forEach(trackWindow);
  // All test inputs use local mode and bundled assets. Also fail if a renderer
  // unexpectedly attempts to fetch an external HTTP resource.
  await instance.context().route(/^https?:\/\//, route => {
    failures.push(`Unexpected network request: ${route.request().url()}`);
    return route.abort();
  });
  assert.equal(await instance.evaluate(({ app: electronApp }) => electronApp.isPackaged), true);
  const [panel, pet] = await Promise.all([findView(instance, 'panel'), findView(instance, 'pet')]);
  await panel.locator('.app-shell').waitFor();
  assert.equal((await panel.evaluate(() => window.petApi.getState())).platform, 'darwin');
  assert.equal((await pet.evaluate(() => window.petApi.getState())).platform, 'darwin');
  await Promise.all([checkDragonArtwork(panel, 'Panel'), checkDragonArtwork(pet, 'Pet')]);
  return { panel, pet };
}

try {
  let { panel, pet } = await launch();
  const empty = await panel.evaluate(() => window.petApi.getState());
  assert.equal(empty.tasks.length, 0, 'The packaged smoke must use a fresh test profile');
  assert.equal(empty.settings.apiKeyConfigured, false, 'The smoke must not use an external AI API');
  console.log('Packaged preload, macOS state, and both dragon images loaded');

  const personal = await within(panel.evaluate(async () => {
    await window.petApi.saveProfile({ name: '小林', role: '个人开发者', preferences: '先给结论，再给具体步骤' });
    const added = await window.petApi.addMemory({ content: '我喜欢在上午处理需要专注的事情', category: 'preference' });
    const memory = added.memories.find(item => item.content === '我喜欢在上午处理需要专注的事情');
    await window.petApi.updateMemory(memory.id, { content: '我偏好上午专注工作，下午处理杂事', category: 'routine' });
    const temporary = await window.petApi.addMemory({ content: '这条临时记忆应该被删除', category: 'other' });
    return window.petApi.deleteMemory(temporary.memories.find(item => item.content === '这条临时记忆应该被删除').id);
  }), 10_000, 'Saving profile and editing personal memories');
  assert.equal(personal.profile.name, '小林');
  assert.equal(personal.memories.length, 1);
  const memoryId = personal.memories[0].id;
  assert.equal(personal.memories[0].content, '我偏好上午专注工作，下午处理杂事');
  console.log('Packaged profile and memory create/update/delete IPC verified');

  // Use the real preload IPC and local parser. No scheduler, clock, reminder
  // implementation, or application state is replaced by a test fixture.
  const createdState = await within(panel.evaluate(() => window.petApi.sendMessage('3秒后提醒我喝水')), 10_000, 'Creating a local reminder');
  assert.equal(createdState.tasks.length, 1);
  const created = createdState.tasks[0];
  assert.equal(created.title, '喝水');
  assert.ok(Math.abs(Date.parse(created.dueAt) - Date.parse(created.createdAt) - 3_000) < 500, 'The task must be a real three-second reminder');
  assert.equal(createdState.reminders.length, 0, 'The reminder must not fire early');

  const closedPanel = await app.evaluate(({ BrowserWindow }) => {
    const panelWindow = BrowserWindow.getAllWindows().find(window => new URL(window.webContents.getURL()).searchParams.get('view') === 'panel');
    if (!panelWindow) throw new Error('Panel BrowserWindow is missing');
    panelWindow.close();
    return { visible: panelWindow.isVisible(), destroyed: panelWindow.isDestroyed() };
  });
  assert.deepEqual(closedPanel, { visible: false, destroyed: false }, 'Closing the panel must hide it and keep reminders running');
  await panel.locator('.reminder-banner').filter({ hasText: '喝水' }).waitFor({ state: 'attached', timeout: 20_000 });
  await pet.locator('.pet-bubble.has-reminder').filter({ hasText: '喝水' }).waitFor();
  await pet.locator('.momo-pet[data-state="reminder"]').waitFor();
  await checkDragonArtwork(pet, 'Reminder pet');
  const delivered = await panel.evaluate(() => window.petApi.getState());
  const deliveredTask = delivered.tasks.find(task => task.id === created.id);
  assert.ok(deliveredTask.lastNotifiedAt, 'The delivery marker must be persisted');
  assert.equal(delivered.reminders.filter(reminder => reminder.taskId === created.id).length, 1);
  console.log('Real three-second reminder fired while the panel was closed');
  await closeApp();

  ({ panel, pet } = await launch());
  const restored = await panel.evaluate(() => window.petApi.getState());
  assert.equal(restored.tasks.length, 1);
  assert.equal(restored.tasks[0].id, created.id);
  assert.equal(restored.tasks[0].lastNotifiedAt, deliveredTask.lastNotifiedAt);
  assert.equal(restored.reminders.filter(reminder => reminder.taskId === created.id).length, 1);
  assert.equal(restored.profile.name, '小林');
  assert.equal(restored.profile.preferences, '先给结论，再给具体步骤');
  assert.equal(restored.memories.length, 1);
  assert.equal(restored.memories[0].id, memoryId);
  assert.equal(restored.memories[0].category, 'routine');
  assert.equal(restored.memories[0].content, '我偏好上午专注工作，下午处理杂事');
  // Observe more than two actual three-second scheduler intervals after restart.
  // A duplicate delivery would replace lastNotifiedAt or append another reminder.
  await pause(6_500);
  const afterTicks = await panel.evaluate(() => window.petApi.getState());
  assert.equal(afterTicks.tasks[0].lastNotifiedAt, deliveredTask.lastNotifiedAt, 'Restart must not redeliver an already delivered reminder');
  assert.equal(afterTicks.reminders.filter(reminder => reminder.taskId === created.id).length, 1);

  await panel.evaluate(taskId => window.petApi.dismissReminder(taskId), created.id);
  await closeApp();
  ({ panel } = await launch());
  const dismissed = await panel.evaluate(() => window.petApi.getState());
  assert.equal(dismissed.tasks[0].id, created.id, 'Dismissing a reminder must retain its task');
  assert.equal(dismissed.tasks[0].lastNotifiedAt, deliveredTask.lastNotifiedAt);
  assert.equal(dismissed.reminders.length, 0, 'Dismissed reminder must not reappear after restart');
  assert.deepEqual(failures, [], 'Packaged renderers must not crash, throw errors, or fetch network resources');
  console.log('Profile and memory restart persistence, reminder deduplication, and dismissed state verified');
  passed = true;
} catch (error) {
  console.error('FAIL packaged macOS smoke:', error);
  process.exitCode = 1;
} finally {
  try { await closeApp(); }
  catch (error) { console.error('FAIL packaged application cleanup:', error); process.exitCode = 1; }
  try { await fs.rm(dataDir, { recursive: true, force: true }); }
  catch (error) { console.error('FAIL temporary profile cleanup:', error); process.exitCode = 1; }
}

if (passed && !process.exitCode) {
  console.log(`PASS Mika packaged macOS smoke (${arch}): extracted app.asar, preload IPC, profile and memory CRUD, both dragon windows, real reminders, restart persistence, and no redelivery.`);
}

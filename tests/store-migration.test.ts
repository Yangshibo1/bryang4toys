import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialProfile, initialState, JsonStore } from '../src/main/store';

function directory(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mika-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function legacyState() {
  return {
    version: 1,
    tasks: [{ id: 'legacy-task', title: '交报告', dueAt: '2026-10-26T07:00:00Z', durationMinutes: 40, priority: 'high', status: 'pending', createdAt: '2026-10-25T04:00:00Z', lastNotifiedAt: '2026-10-26T07:00:05Z' }],
    messages: [{ id: 'legacy-chat', role: 'user', text: '这段历史要保留', createdAt: '2026-10-25T04:00:00Z' }],
    reminders: [{ taskId: 'legacy-task', title: '交报告', dueAt: '2026-10-26T07:00:00Z' }],
    settings: { baseUrl: 'https://provider.example/v1', model: 'my-existing-model', apiKey: 'fixture-key-to-preserve', apiKeyConfigured: false, notificationsEnabled: false, alwaysOnTop: false },
  };
}

test('fresh Mika state enables configurable AI and personal context without claiming model availability', t => {
  const store = new JsonStore(directory(t));
  assert.equal(path.basename(store.file), 'mika-data.json');
  assert.equal(store.state.version, 2);
  assert.equal(store.state.settings.baseUrl, 'https://api.openai.com/v1');
  assert.equal(store.state.settings.model, 'gpt-6-luna');
  assert.equal(store.state.settings.protocol, 'chat-completions');
  assert.equal(store.state.settings.memoryEnabled, true);
  assert.deepEqual(store.state.profile, initialProfile());
  assert.deepEqual(store.state.memories, []);
  assert.match(store.state.messages[0].text, /米卡 Mika/);
  assert.match(store.state.messages[0].text, /设置.*模型接口/);
});

test('Momo v1 migration preserves tasks, conversations, reminders and provider credentials without changing the original', t => {
  const root = directory(t);
  const old = legacyState();
  const source = path.join(root, 'momo-data.json');
  const bytes = JSON.stringify(old, null, 2);
  fs.writeFileSync(source, bytes);
  const store = new JsonStore(root);
  assert.equal(store.state.version, 2);
  assert.deepEqual(store.state.tasks, old.tasks);
  assert.deepEqual(store.state.messages, old.messages);
  assert.deepEqual(store.state.reminders, old.reminders);
  for (const key of ['baseUrl', 'model', 'apiKey', 'notificationsEnabled', 'alwaysOnTop'] as const) {
    assert.equal(store.state.settings[key], old.settings[key]);
  }
  assert.equal(store.state.settings.protocol, 'chat-completions');
  assert.equal(store.state.settings.apiKeyConfigured, true);
  assert.equal(fs.readFileSync(source, 'utf8'), bytes);
  const restored = new JsonStore(root);
  assert.deepEqual(restored.state, store.state);
  assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).version, 2);
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
});

test('legacy application directories migrate only when there is no current Mika or local Momo data', t => {
  const root = directory(t);
  const legacy = path.join(root, 'old-app');
  const current = path.join(root, 'new-app');
  fs.mkdirSync(legacy);
  const state = initialState();
  state.profile.name = '小杨';
  state.settings.protocol = 'responses';
  state.settings.memoryEnabled = false;
  state.memories = [{ id: 'memory-one', content: '用户正在学习摄影', category: 'goal', source: 'manual', createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z' }];
  const oldFile = path.join(legacy, 'mika-data.json');
  const bytes = JSON.stringify(state);
  fs.writeFileSync(oldFile, bytes);
  const store = new JsonStore(current, [legacy]);
  assert.deepEqual(store.state, state);
  assert.equal(fs.readFileSync(oldFile, 'utf8'), bytes);
  store.state.profile.name = '新称呼';
  store.save();
  assert.equal(new JsonStore(current, [legacy]).state.profile.name, '新称呼');
  assert.equal(fs.readFileSync(oldFile, 'utf8'), bytes);
});

test('existing Mika data always wins over legacy data and is not rewritten during construction', t => {
  const root = directory(t);
  const state = initialState();
  state.profile.name = '当前数据';
  const bytes = JSON.stringify(state);
  fs.writeFileSync(path.join(root, 'mika-data.json'), bytes);
  fs.writeFileSync(path.join(root, 'momo-data.json'), JSON.stringify(legacyState()));
  const store = new JsonStore(root);
  assert.equal(store.state.profile.name, '当前数据');
  assert.equal(store.state.tasks.length, 0);
  assert.equal(fs.readFileSync(store.file, 'utf8'), bytes);
});

test('corrupt current Mika data never falls back to an old valid store or exposes credential content', t => {
  const root = directory(t);
  const current = path.join(root, 'mika-data.json');
  const old = path.join(root, 'momo-data.json');
  const broken = '{"apiKey":"fixture-secret-must-not-be-printed",';
  const legacy = JSON.stringify(legacyState());
  fs.writeFileSync(current, broken);
  fs.writeFileSync(old, legacy);
  assert.throws(() => new JsonStore(root), error => error instanceof Error && /无法读取本地数据/.test(error.message) && !error.message.includes('fixture-secret'));
  assert.equal(fs.readFileSync(current, 'utf8'), broken);
  assert.equal(fs.readFileSync(old, 'utf8'), legacy);
});

test('unsupported or corrupt legacy data is preserved and no replacement Mika store is created', t => {
  const root = directory(t);
  const source = path.join(root, 'momo-data.json');
  const bytes = JSON.stringify({ ...legacyState(), version: 99 });
  fs.writeFileSync(source, bytes);
  assert.throws(() => new JsonStore(root), /无法读取本地数据/);
  assert.equal(fs.readFileSync(source, 'utf8'), bytes);
  assert.equal(fs.existsSync(path.join(root, 'mika-data.json')), false);
});

for (const scenario of [
  { name: 'untouched keyless DeepSeek defaults', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '', upgrades: true },
  { name: 'configured DeepSeek account', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'fixture-existing-key', upgrades: false },
  { name: 'custom model with no key yet', baseUrl: 'https://api.deepseek.com/v1', model: 'my-custom-model', apiKey: '', upgrades: false },
  { name: 'custom provider with no key yet', baseUrl: 'https://my-provider.example/v1', model: 'deepseek-chat', apiKey: '', upgrades: false },
]) {
  test(`v1 provider migration handles ${scenario.name} without changing the legacy file`, t => {
    const root = directory(t);
    const legacy = legacyState();
    Object.assign(legacy.settings, { baseUrl: scenario.baseUrl, model: scenario.model, apiKey: scenario.apiKey });
    const source = path.join(root, 'momo-data.json');
    const bytes = JSON.stringify(legacy);
    fs.writeFileSync(source, bytes);
    const restored = new JsonStore(root);
    assert.equal(restored.state.settings.baseUrl, scenario.upgrades ? 'https://api.openai.com/v1' : scenario.baseUrl);
    assert.equal(restored.state.settings.model, scenario.upgrades ? 'gpt-6-luna' : scenario.model);
    assert.equal(restored.state.settings.apiKey, scenario.apiKey);
    assert.equal(fs.readFileSync(source, 'utf8'), bytes);
  });
}

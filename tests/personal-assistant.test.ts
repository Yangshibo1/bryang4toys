import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../src/main/store';
import { PetService } from '../src/main/service';

function serviceFor(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mika-personal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, service: new PetService(new JsonStore(dir), 'darwin') };
}

async function modelFor(t: TestContext, respond: (body: any) => any | Promise<any>) {
  const errors: string[] = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const result = await respond(JSON.parse(raw));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
    } catch (error) {
      errors.push(String(error)); res.writeHead(500); res.end('{}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); assert.deepEqual(errors, []); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

test('personal profile and manual memory edits survive restart and deletion is persistent', t => {
  const { dir, service } = serviceFor(t);
  service.saveProfile({ name: '小林', role: '设计师', goals: '完成个人作品集', assistantStyle: '直接给建议，少客套' });
  const memory = service.addMemory({ content: '周三下午留给写作', category: 'routine' });
  service.addMemory({ content: '周三 下午 留给写作', category: 'routine' });
  assert.equal(service.snapshot().memories.length, 1, 'duplicate facts must not accumulate');
  service.updateMemory(memory.id, { content: '周四下午留给写作' });
  const restored = new PetService(new JsonStore(dir), 'darwin');
  assert.equal(restored.snapshot().profile.name, '小林');
  assert.equal(restored.snapshot().profile.assistantStyle, '直接给建议，少客套');
  assert.equal(restored.snapshot().memories[0].category, 'routine');
  assert.equal(restored.snapshot().memories[0].content, '周四下午留给写作');
  restored.deleteMemory(memory.id);
  assert.equal(new PetService(new JsonStore(dir), 'darwin').snapshot().memories.length, 0);
});

test('AI remembers a stated fact, uses it after restart, then updates and forgets it', async t => {
  const { dir, service } = serviceFor(t);
  service.saveProfile({ name: '小林', preferences: '建议简洁一些' });
  const manual = service.addMemory({ content: '周三下午留给写作', category: 'routine' });
  let phase = 0;
  let rememberedId = '';
  const baseUrl = await modelFor(t, body => {
    assert.equal(body.model, 'gpt-6-luna');
    const context = body.messages[0].content;
    assert.ok(context.includes('小林'));
    assert.ok(context.includes('建议简洁一些'));
    if (phase === 0) return { reply: '我会记住你喜欢上午集中工作。', actions: [], memoryActions: [{ type: 'remember', content: '喜欢上午集中工作', category: 'routine' }] };
    assert.ok(context.includes('喜欢上午集中工作') || phase > 1);
    if (phase === 1) return { reply: '已改为下午集中工作。', actions: [], memoryActions: [{ type: 'update', id: rememberedId, content: '喜欢下午集中工作', category: 'routine' }] };
    if (phase === 2) return { reply: '已忘掉这个工作偏好。', actions: [], memoryActions: [{ type: 'forget', id: rememberedId }] };
    assert.ok(!context.includes('周三下午留给写作'), 'disabled long-term memory must not be injected');
    return { reply: '记忆已关闭，本次只聊天。', actions: [], memoryActions: [{ type: 'remember', content: '不应该保存', category: 'other' }] };
  });
  service.saveSettings({ baseUrl, apiKey: 'fixture-key', protocol: 'chat-completions', memoryEnabled: true, model: 'gpt-6-luna' });
  await service.sendMessage('请记住，我喜欢上午集中工作');
  const fact = service.snapshot().memories.find(memory => memory.source === 'conversation');
  assert.ok(fact); rememberedId = fact.id;
  const restored = new PetService(new JsonStore(dir), 'darwin');
  phase = 1;
  await restored.sendMessage('更正一下，我喜欢下午集中工作');
  assert.equal(restored.snapshot().memories.find(memory => memory.id === rememberedId)?.content, '喜欢下午集中工作');
  phase = 2;
  await restored.sendMessage('忘掉我集中工作的时间偏好');
  assert.equal(restored.snapshot().memories.length, 1);
  assert.equal(restored.snapshot().memories[0].id, manual.id);
  restored.saveSettings({ memoryEnabled: false });
  phase = 3;
  await restored.sendMessage('今天有什么建议');
  assert.equal(restored.snapshot().memories.length, 1);
  assert.ok(!restored.snapshot().memories.some(memory => memory.content === '不应该保存'));
});

test('testing an unsaved API configuration checks the chosen model without persisting its key', async t => {
  const { service } = serviceFor(t);
  const baseUrl = await modelFor(t, body => {
    assert.equal(body.model, 'custom-gpt-6-luna');
    return { reply: '连接正常', actions: [], memoryActions: [] };
  });
  const result = await service.testAiConnection({ baseUrl, apiKey: 'unsaved-secret', model: 'custom-gpt-6-luna', protocol: 'chat-completions' });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'custom-gpt-6-luna');
  assert.equal(service.snapshot().settings.apiKeyConfigured, false);
  assert.equal(JSON.stringify(result).includes('unsaved-secret'), false);
  assert.equal(service.snapshot().messages.length, 1);
});

test('manual memory changes made during a delayed AI reply are retained atomically', async t => {
  const { service } = serviceFor(t);
  const memory = service.addMemory({ content: '喜欢上午工作', category: 'routine' });
  let received!: () => void; let release!: () => void;
  const requestSeen = new Promise<void>(resolve => { received = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const baseUrl = await modelFor(t, async () => {
    received(); await gate;
    return { reply: '已更新', actions: [{ type: 'create', task: { title: '不应部分创建', dueAt: null } }], memoryActions: [{ type: 'update', id: memory.id, content: '喜欢晚上工作' }] };
  });
  service.saveSettings({ baseUrl, apiKey: 'fixture-key', protocol: 'chat-completions' });
  const pending = service.sendMessage('记住我现在喜欢晚上工作');
  await requestSeen;
  service.updateMemory(memory.id, { content: '手动改为下午工作' });
  release();
  const state = await pending;
  assert.equal(state.memories[0].content, '手动改为下午工作');
  assert.equal(state.tasks.length, 0);
  assert.match(state.messages.at(-1)!.text, /已保留你的新修改/);
});

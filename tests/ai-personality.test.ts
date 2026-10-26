import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { PersonalMemory, Task } from '../src/shared/types';
import { askAi, parseAiResult, testAiConnection } from '../src/main/ai';
import { initialProfile, initialState, type SavedSettings } from '../src/main/store';

const memory: PersonalMemory = {
  id: 'known-memory', content: '用户希望每周练习三次摄影', category: 'goal', source: 'manual',
  createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z',
};
const task: Task = {
  id: 'known-task', title: '交报告', dueAt: null, durationMinutes: 30, priority: 'normal', status: 'pending', createdAt: '2026-10-25T00:00:00Z',
};
const personal = {
  profile: { ...initialProfile(), name: '小杨', role: '设计师', assistantStyle: '直接一点，用摄影相关的例子', preferences: '先给简短结论' },
  memories: [memory],
};

function chatReply(reply: string | object) {
  return { choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] };
}

async function fixture(t: TestContext, handler: (body: any, request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void>) {
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    try { await handler(JSON.parse(body), request, response); }
    catch (error) { response.writeHead(500); response.end('{}'); throw error; }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address() as { port: number };
  const settings: SavedSettings = { ...initialState().settings, baseUrl: `http://127.0.0.1:${port}/gateway/v1/`, apiKey: 'fixture-api-key', model: 'gpt-6 luna' };
  return settings;
}

test('Chat Completions sends the exact configured model, personal context, and only the last 24 conversational messages', async t => {
  let payload: any;
  const settings = await fixture(t, (body, request, response) => {
    assert.equal(request.url, '/gateway/v1/chat/completions?api-version=example');
    assert.equal(request.headers.authorization, 'Bearer fixture-api-key');
    payload = body;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(chatReply('```json\n{"reply":"可以，我们从摄影构图聊起。","actions":[]}\n```')));
  });
  settings.baseUrl += '?api-version=example';
  const recent = Array.from({ length: 27 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `history-${i}` }));
  recent.unshift({ role: 'system', text: 'UNTRUSTED_ROLE_MUST_NOT_BECOME_SYSTEM' });
  const result = await askAi('聊聊怎么提升构图', [task], settings, recent, new Date('2026-10-26T08:00:00Z'), personal);
  assert.match(result.reply, /摄影构图/);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.memoryActions, []);
  assert.equal(payload.model, 'gpt-6 luna');
  assert.equal('temperature' in payload, false);
  assert.equal(payload.messages.length, 26);
  assert.equal(payload.messages[0].role, 'system');
  assert.match(payload.messages[0].content, /米卡 Mika/);
  assert.match(payload.messages[0].content, /直接一点，用摄影相关的例子/);
  assert.match(payload.messages[0].content, /用户希望每周练习三次摄影/);
  assert.match(payload.messages[0].content, /known-task/);
  assert.equal(payload.messages[1].content, 'history-3');
  assert.deepEqual(payload.messages.at(-1), { role: 'user', content: '聊聊怎么提升构图' });
  assert.equal(JSON.stringify(payload).includes('UNTRUSTED_ROLE_MUST_NOT_BECOME_SYSTEM'), false);
  assert.equal(JSON.stringify(payload).includes(settings.apiKey), false);
});

test('Responses uses instructions/input roles and extracts standard output message text after reasoning items', async t => {
  let payload: any;
  const settings = await fixture(t, (body, request, response) => {
    assert.equal(request.url, '/gateway/v1/responses');
    payload = body;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ reply: '记住了，你偏好简短回答。', actions: [], memoryActions: [{ type: 'remember', content: '用户偏好简短回答', category: 'preference' }] }) }] },
    ] }));
  });
  settings.protocol = 'responses';
  const result = await askAi('以后尽量简短回答', [], settings, [{ role: 'assistant', text: '上次我们聊了摄影' }], undefined, personal);
  assert.equal(payload.model, 'gpt-6 luna');
  assert.equal('temperature' in payload, false);
  assert.equal('messages' in payload, false);
  assert.match(payload.instructions, /小杨/);
  assert.match(payload.instructions, /known-memory/);
  assert.deepEqual(payload.input, [{ role: 'assistant', content: '上次我们聊了摄影' }, { role: 'user', content: '以后尽量简短回答' }]);
  assert.deepEqual(result.memoryActions, [{ type: 'remember', content: '用户偏好简短回答', category: 'preference' }]);
});

test('disabled memory retains the explicit profile but sends no long-term facts and ignores provider memory operations', async t => {
  let payload: any;
  const settings = await fixture(t, (body, _request, response) => {
    payload = body;
    response.end(JSON.stringify(chatReply({ reply: '我们可以继续讨论摄影。', actions: [], memoryActions: [{ type: 'forget', id: 'not-visible-to-the-model' }] })));
  });
  settings.memoryEnabled = false;
  const result = await askAi('继续讨论', [], settings, [], undefined, personal);
  assert.match(payload.messages[0].content, /小杨/);
  assert.match(payload.messages[0].content, /长期记忆已关闭/);
  assert.equal(JSON.stringify(payload).includes(memory.content), false);
  assert.equal(JSON.stringify(payload).includes(memory.id), false);
  assert.deepEqual(result.memoryActions, []);
  assert.equal(personal.memories.length, 1);
});

test('switching memory off while a request is in flight discards its late memory actions', async t => {
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requestReceived = new Promise<void>(resolve => { received = resolve; });
  const settings = await fixture(t, async (_body, _request, response) => {
    received();
    await gate;
    response.end(JSON.stringify(chatReply({ reply: '好的。', actions: [], memoryActions: [{ type: 'remember', content: '用户喜欢摄影', category: 'preference' }] })));
  });
  t.after(release);
  const pending = askAi('我喜欢摄影', [], settings, [], undefined, personal);
  await requestReceived;
  settings.memoryEnabled = false;
  release();
  assert.deepEqual((await pending).memoryActions, []);
});

test('memory parsing validates IDs, drops exact duplicates, supports corrections/forgetting, and remains compatible with old replies', () => {
  assert.deepEqual(parseAiResult('{"reply":"你好"}', []).memoryActions, []);
  const result = parseAiResult(JSON.stringify({ reply: '已处理', memoryActions: [
    { type: 'remember', content: `  ${memory.content}  ` },
    { type: 'remember', content: '喜欢自然光摄影', category: 'preference' },
    { type: 'remember', content: '喜欢自然光摄影' },
    { type: 'update', id: memory.id, content: '用户希望每周练习两次摄影', category: 'goal' },
    { type: 'forget', id: memory.id },
  ] }), [], [memory]);
  assert.equal(result.memoryActions.length, 3);
  assert.deepEqual(result.memoryActions.map(action => action.type), ['remember', 'update', 'forget']);
  for (const type of ['update', 'forget']) {
    assert.throws(() => parseAiResult(JSON.stringify({ reply: 'ok', memoryActions: [{ type, id: 'invented', content: '不应保存' }] }), [], [memory]), /不存在的记忆/);
  }
  assert.throws(() => parseAiResult('{"reply":"ok","actions":[null]}', []), /无效的任务操作/);
  assert.throws(() => parseAiResult('{"reply":"ok","memoryActions":[{"type":"remember","content":"  "}]}', []), /记忆内容无效/);
});

for (const protocol of ['chat-completions', 'responses'] as const) {
  test(`connection test makes a minimal real ${protocol} model request without changing configuration`, async t => {
    let payload: any;
    const observedTimeouts: number[] = [];
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { observedTimeouts.push(milliseconds); return originalTimeout(milliseconds); });
    const settings = await fixture(t, (body, request, response) => {
      payload = body;
      assert.equal(request.url, protocol === 'responses' ? '/gateway/v1/responses' : '/gateway/v1/chat/completions');
      response.end(JSON.stringify(protocol === 'responses' ? { output_text: 'OK' } : chatReply('OK')));
    });
    settings.protocol = protocol;
    const before = structuredClone(settings);
    const result = await testAiConnection(settings);
    assert.equal(result.ok, true);
    assert.equal(result.model, settings.model);
    assert.ok(result.latencyMs >= 0);
    assert.deepEqual(settings, before);
    assert.equal(payload.model, settings.model);
    assert.equal('temperature' in payload, false);
    const messages = protocol === 'responses' ? payload.input : payload.messages;
    assert.equal(messages.filter((message: any) => message.role === 'user').length, 1);
    assert.equal(messages.at(-1).content, 'ping');
    assert.deepEqual(observedTimeouts, [90_000]);
    assert.equal(JSON.stringify(result).includes(settings.apiKey), false);
    assert.equal(JSON.stringify(payload).includes(memory.content), false);
  });
}

test('provider failures report authentication/model errors without repeating provider-echoed credentials', async t => {
  let status = 401;
  let responseBody: unknown = { error: { message: 'invalid Bearer fixture-api-key', code: 'invalid_api_key' } };
  const settings = await fixture(t, (_body, _request, response) => {
    response.writeHead(status);
    response.end(JSON.stringify(responseBody));
  });
  const auth = await testAiConnection(settings);
  assert.equal(auth.ok, false);
  assert.match(auth.message, /API Key 无效/);
  assert.equal(JSON.stringify(auth).includes(settings.apiKey), false);
  status = 404;
  responseBody = { error: { code: 'model_not_found', message: 'model missing; Authorization: Bearer fixture-api-key' } };
  const missing = await testAiConnection(settings);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /模型不存在/);
  assert.equal(JSON.stringify(missing).includes(settings.apiKey), false);
  await assert.rejects(askAi('你好', [], settings, []), error => error instanceof Error && /模型不存在/.test(error.message) && !error.message.includes(settings.apiKey));
});

test('invalid URLs and invalid provider JSON never leak embedded credentials in connection results', async t => {
  const settings = await fixture(t, (_body, _request, response) => { response.end('broken response fixture-api-key'); });
  const malformed = await testAiConnection(settings);
  assert.equal(malformed.ok, false);
  assert.match(malformed.message, /有效 JSON/);
  assert.equal(JSON.stringify(malformed).includes(settings.apiKey), false);
  const embedded = await testAiConnection({ ...settings, baseUrl: 'https://user:fixture-api-key@example.com/v1' });
  assert.equal(embedded.ok, false);
  assert.equal(JSON.stringify(embedded).includes(settings.apiKey), false);
  assert.match(embedded.message, /单独的 API 密钥字段/);
  const missing = await testAiConnection({ ...settings, apiKey: '' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /先填写 API 密钥/);
});

test('a response body that stalls after headers is classified as a timeout rather than invalid JSON', async t => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 90_000);
    return originalTimeout(30);
  });
  const settings = await fixture(t, (_body, _request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.flushHeaders();
    response.write('{"choices":');
    // The real HTTP request is aborted by its signal while reading the body.
  });
  const result = await testAiConnection(settings);
  assert.equal(result.ok, false);
  assert.match(result.message, /超时/);
  assert.equal(JSON.stringify(result).includes(settings.apiKey), false);
});

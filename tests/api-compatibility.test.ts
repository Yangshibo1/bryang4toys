import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingHttpHeaders } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askAi, testAiConnection } from '../src/main/ai';
import { initialState, JsonStore, type SavedSettings } from '../src/main/store';
import { PetService } from '../src/main/service';

type Protocol = SavedSettings['protocol'];
interface SeenRequest {
  url: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: any;
}
interface FixtureReply {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

async function fixture(t: TestContext, reply: (request: SeenRequest, index: number) => FixtureReply | Promise<FixtureReply>) {
  const requests: SeenRequest[] = [];
  const failures: string[] = [];
  const server = http.createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const seen = {
        url: request.url || '', method: request.method || '', headers: request.headers,
        body: raw ? JSON.parse(raw) : null,
      };
      requests.push(seen);
      const result = await reply(seen, requests.length - 1);
      response.writeHead(result.status || 200, { 'Content-Type': 'application/json', ...result.headers });
      response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end('{}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.deepEqual(failures, [], 'The local provider fixture must complete without handler errors');
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const settings: SavedSettings = {
    ...initialState().settings,
    baseUrl: origin,
    apiKey: 'fixture-api-key',
    model: 'fixture-model',
    protocol: 'responses',
  };
  return { origin, settings, requests };
}

function ordinaryReply(protocol: Protocol, text: string) {
  return protocol === 'responses'
    ? { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }
    : { choices: [{ message: { role: 'assistant', content: text } }] };
}

function serviceFor(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mika-api-compatibility-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, service: new PetService(new JsonStore(directory), 'darwin') };
}

test('a root API URL uses /v1/responses with explicit JSON acceptance, non-streaming input, and one normalized Bearer prefix', async t => {
  const provider = await fixture(t, () => ({ body: { output_text: 'OK' } }));
  provider.settings.apiKey = '  Authorization: Bearer fixture-api-key  ';
  const result = await testAiConnection(provider.settings);
  assert.equal(result.ok, true);
  assert.equal(provider.requests.length, 1);
  const request = provider.requests[0];
  assert.equal(request.url, '/v1/responses');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.accept, 'application/json');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers.authorization, 'Bearer fixture-api-key');
  assert.equal(request.body.stream, false);
  assert.equal(request.body.model, 'fixture-model');
  assert.equal('tools' in request.body, false, 'Connection testing should not require action tools');
});

test('explicit root endpoints, custom prefixes, and URL queries remain intact instead of being rewritten to a guessed provider path', async t => {
  const provider = await fixture(t, () => ({ body: { output_text: 'OK' } }));
  const cases = [
    ['/responses?api-version=beta', '/responses?api-version=beta'],
    ['/proxy/openai?region=hk&api-version=beta', '/proxy/openai/responses?region=hk&api-version=beta'],
    ['/proxy/v3/responses?route=personal', '/proxy/v3/responses?route=personal'],
  ];
  for (const [configured, expected] of cases) {
    const result = await testAiConnection({ ...provider.settings, baseUrl: `${provider.origin}${configured}` });
    assert.equal(result.ok, true);
    assert.equal(provider.requests.at(-1)!.url, expected);
  }
  assert.equal(provider.requests.length, cases.length);
});

for (const protocol of ['responses', 'chat-completions'] as const) {
  test(`${protocol} ordinary natural-language chat does not require a structured JSON envelope`, async t => {
    const text = '听起来今天有些疲惫。\n我们先聊聊你最想放下的那件事，不急着安排任务。';
    const provider = await fixture(t, () => ({ body: ordinaryReply(protocol, text) }));
    const result = await askAi('我今天有些累，想聊聊。', [], { ...provider.settings, protocol }, []);
    assert.equal(result.reply, text);
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.memoryActions, []);
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].body.stream, false);
  });

  test(`${protocol} native mika_reply tool arguments create durable tasks and conversation memories through PetService`, async t => {
    const operations = {
      reply: '已设置交报告提醒，也记住了你偏好简短回答。',
      actions: [{ type: 'create', task: { title: '交报告', dueAt: '2026-10-28T07:00:00Z', durationMinutes: 30, priority: 'high' } }],
      memoryActions: [{ type: 'remember', content: '用户偏好简短回答', category: 'preference' }],
    };
    const provider = await fixture(t, request => {
      const tool = request.body.tools?.[0];
      assert.equal(protocol === 'responses' ? tool.name : tool.function.name, 'mika_reply');
      return { body: protocol === 'responses'
        ? { output: [{ type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'mika_reply', arguments: JSON.stringify(operations) }] }
        : { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'mika_reply', arguments: JSON.stringify(operations) } }] } }] },
      };
    });
    const { directory, service } = serviceFor(t);
    service.saveSettings({ ...provider.settings, protocol });
    const result = await service.sendMessage('明天下午三点提醒我交报告，并记住我偏好简短回答。');
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].title, '交报告');
    assert.equal(result.tasks[0].dueAt, '2026-10-28T07:00:00Z');
    assert.equal(result.tasks[0].priority, 'high');
    assert.equal(result.memories.length, 1);
    assert.equal(result.memories[0].content, '用户偏好简短回答');
    assert.equal(result.memories[0].category, 'preference');
    assert.equal(result.memories[0].source, 'conversation');
    assert.equal(result.messages.at(-1)!.text, operations.reply);
    const restored = new PetService(new JsonStore(directory), 'darwin').snapshot();
    assert.deepEqual(restored.tasks, result.tasks);
    assert.deepEqual(restored.memories, result.memories);
    assert.equal(restored.messages.at(-1)!.text, operations.reply);
    assert.equal(provider.requests.length, 1);
  });

  test(`${protocol} retries once without tools only after an explicit unsupported-tools provider response`, async t => {
    const provider = await fixture(t, (request, index) => {
      if (index === 0) {
        assert.ok(Array.isArray(request.body.tools));
        return { status: 400, body: { error: { code: 'unsupported_parameter', param: 'tools', message: 'This endpoint does not support tools' } } };
      }
      assert.equal(index, 1, 'An unsupported-tools fallback must be attempted only once');
      assert.equal('tools' in request.body, false);
      assert.equal('tool_choice' in request.body, false);
      assert.equal(request.body.stream, false);
      return { body: ordinaryReply(protocol, '当然可以，我们可以自然地聊聊。') };
    });
    const result = await askAi('你好，聊一聊最近的状态。', [], { ...provider.settings, protocol }, []);
    assert.equal(provider.requests.length, 2);
    assert.equal(result.reply, '当然可以，我们可以自然地聊聊。');
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.memoryActions, []);
  });
}

test('HTTP 200 HTML is diagnosed explicitly without disclosing its body, API key, or URL query', async t => {
  const provider = await fixture(t, () => ({
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: '<!doctype html><html><body>RAW_PROVIDER_BODY fixture-api-key QUERY_SENTINEL</body></html>',
  }));
  const result = await testAiConnection({
    ...provider.settings,
    baseUrl: `${provider.origin}/gateway/fixture-api-key?access_token=QUERY_SENTINEL`,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /返回了网页/);
  assert.equal(result.status, 200);
  assert.equal(result.responseType, 'text/html');
  assert.equal(result.endpoint, `${provider.origin}/gateway/[已隐藏]/responses`);
  const diagnostic = JSON.stringify(result);
  for (const forbidden of ['RAW_PROVIDER_BODY', 'fixture-api-key', 'QUERY_SENTINEL', 'access_token', '<html>']) {
    assert.equal(diagnostic.includes(forbidden), false, forbidden);
  }
  assert.equal(provider.requests.length, 1);
});

for (const status of [400, 401] as const) {
  test(`HTTP ${status} does not trigger a tools fallback or any automatic retry when it is not an eligible unsupported-tools response`, async t => {
    const provider = await fixture(t, () => ({ status, body: { error: {
      code: status === 401 ? 'invalid_api_key' : 'invalid_request_error',
      param: status === 401 ? 'tools' : 'input',
      message: status === 401 ? 'unsupported tools for fixture-api-key QUERY_SENTINEL' : 'invalid input fixture-api-key QUERY_SENTINEL',
    } } }));
    await assert.rejects(askAi('你好', [], {
      ...provider.settings, baseUrl: `${provider.origin}?secret=QUERY_SENTINEL`,
    }, []), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, status === 401 ? /API Key|401/ : /400/);
      const diagnostic = JSON.stringify(Object.assign({ message: error.message }, error));
      assert.equal(diagnostic.includes('fixture-api-key'), false);
      assert.equal(diagnostic.includes('QUERY_SENTINEL'), false);
      return true;
    });
    assert.equal(provider.requests.length, 1);
  });
}

test('a reminder or memory request answered with plain text explicitly reports no mutation and does not fake persistence', async t => {
  const provider = await fixture(t, () => ({ body: { output_text: '好的，已经帮你记下了。' } }));
  const { directory, service } = serviceFor(t);
  service.saveSettings(provider.settings);
  const state = await service.sendMessage('十分钟后提醒我喝水，并记住我喜欢简短回答。');
  assert.equal(state.tasks.length, 0);
  assert.equal(state.memories.length, 0);
  assert.match(state.messages.at(-1)!.text, /未实际修改待办或长期记忆/);
  assert.doesNotMatch(state.messages.at(-1)!.text, /没有返回有效的结构化回复/);
  const restored = new PetService(new JsonStore(directory), 'darwin').snapshot();
  assert.equal(restored.tasks.length, 0);
  assert.equal(restored.memories.length, 0);
  assert.equal(provider.requests.length, 1);
});

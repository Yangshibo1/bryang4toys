import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ProviderFormatError, readProviderPayload } from '../src/main/provider-response';

function frame(value: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`;
}

function chat(content: string) {
  return { choices: [{ index: 0, delta: { content } }] };
}

async function server(t: TestContext, handler: (response: http.ServerResponse) => void) {
  const instance = http.createServer((_request, response) => handler(response));
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const { port } = instance.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

test('valid JSON and UTF-8 BOM parse even when a gateway mislabels the response as HTML', async () => {
  const body = { choices: [{ message: { content: '你好' } }] };
  const response = new Response(`\uFEFF  ${JSON.stringify(body)}\r\n`, { headers: { 'Content-Type': 'text/html' } });
  assert.deepEqual(await readProviderPayload(response, 'chat-completions'), body);
});

test('Chat SSE merges answer deltas, ignores reasoning and usage, and accepts a wrong JSON media type', async () => {
  const response = new Response(
    ': keepalive\n\n'
    + frame({ choices: [{ delta: { role: 'assistant', reasoning_content: 'PRIVATE_REASONING_MUST_NOT_BECOME_ANSWER' } }] })
    + frame(chat('O')) + frame(chat('K')) + frame({ choices: [], usage: { total_tokens: 3 } }) + 'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'application/json' } },
  );
  const result: any = await readProviderPayload(response, 'chat-completions');
  assert.equal(result.choices[0].message.content, 'OK');
  assert.equal(JSON.stringify(result).includes('PRIVATE_REASONING'), false);
});

test('a reasoning-only Chat stream does not manufacture an answer', async () => {
  const response = new Response(frame({ choices: [{ delta: { reasoning_content: 'Not an answer' } }] }) + 'data: [DONE]\n\n');
  const result: any = await readProviderPayload(response, 'chat-completions');
  assert.equal(result.choices[0].message.content, '');
});

test('real HTTP SSE handles UTF-8 characters, split CRLF and multiline data fields', async t => {
  const wire = Buffer.from(`\uFEFF: heartbeat\r\n\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"你好🐉"}}]}\r\n\r\ndata: [DONE]\r\n\r\n`);
  const url = await server(t, response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let offset = 0;
    const write = () => {
      if (response.destroyed) return;
      if (offset >= wire.length) { response.end(); return; }
      response.write(wire.subarray(offset, ++offset));
      setImmediate(write);
    };
    write();
  });
  const result: any = await readProviderPayload(await fetch(url), 'chat-completions');
  assert.equal(result.choices[0].message.content, '你好🐉');
});

test('Responses deltas, done and completed are replacements rather than repeated output', async () => {
  const answer = '{"reply":"你好","actions":[]}';
  const response = new Response(
    frame({ type: 'response.created', response: { id: 'response-one' } })
    + frame({ type: 'response.reasoning_summary_text.delta', delta: 'Private reasoning' })
    + frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: answer.slice(0, 10) })
    + frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: answer.slice(10) })
    + frame({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: answer })
    + frame({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }] } }),
  );
  const result: any = await readProviderPayload(response, 'responses');
  assert.equal(result.output_text, answer);
  assert.deepEqual(JSON.parse(result.output_text), { reply: '你好', actions: [] });
  assert.equal(JSON.stringify(result).includes('Private reasoning'), false);
});

test('Responses done-only and delta-only streams work with event names and trailing EOF frames', async () => {
  const done = new Response(frame({ output_index: 0, content_index: 0, text: '完整答案' }, 'response.output_text.done'));
  assert.equal((await readProviderPayload(done, 'responses') as any).output_text, '完整答案');
  const delta = new Response('event: response.output_text.delta\ndata: {"delta":"答案"}');
  assert.equal((await readProviderPayload(delta, 'responses') as any).output_text, '答案');
});

test('Responses associates item IDs with output indexes when a gateway omits indexes on deltas', async () => {
  const response = new Response(frame({ type: 'response.output_text.delta', item_id: 'message-one', delta: '答案' })
    + frame({ type: 'response.output_text.done', item_id: 'message-one', output_index: 0, content_index: 0, text: '答案' })
    + 'data: [DONE]\n\n');
  assert.equal((await readProviderPayload(response, 'responses') as any).output_text, '答案');
});

test('SSE errors override prior partial answers and return the original error object without throwing its contents', async () => {
  const error = { code: 'invalid_api_key', message: 'Bearer FIXTURE_SECRET_MUST_NOT_APPEAR_IN_EXCEPTIONS' };
  const response = new Response(frame(chat('This partial answer must not succeed')) + frame({ error }) + 'data: [DONE]\n\n');
  assert.deepEqual(await readProviderPayload(response, 'chat-completions'), { error });
  const failed = new Response(frame({ type: 'response.output_text.delta', delta: 'partial' })
    + frame({ type: 'response.failed', response: { status: 'failed', error } }));
  assert.deepEqual(await readProviderPayload(failed, 'responses'), { error });
  const named = new Response(frame(error, 'error'));
  assert.deepEqual(await readProviderPayload(named, 'responses'), { error });
});

test('a DONE event cancels a connection that remains open, and completed Responses do the same', { timeout: 2000 }, async () => {
  for (const protocol of ['chat-completions', 'responses'] as const) {
    let cancelled = false;
    const payload = protocol === 'chat-completions' ? frame(chat('OK')) + 'data: [DONE]\n\n'
      : frame({ type: 'response.completed', response: { output_text: 'OK' } });
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(payload)); },
      cancel() { cancelled = true; },
    }));
    const result: any = await readProviderPayload(response, protocol);
    assert.equal(protocol === 'responses' ? result.output_text : result.choices[0].message.content, 'OK');
    assert.equal(cancelled, true);
  }
});

test('HTML, empty responses, malformed JSON and malformed SSE have safe typed errors', async () => {
  for (const fixture of [
    { body: '<html>FIXTURE_SECRET_HTML</html>', kind: 'html' },
    { body: '  \r\n', kind: 'empty' },
    { body: '{"message":"FIXTURE_SECRET_BROKEN",', kind: 'invalid-json' },
    { body: 'data: FIXTURE_SECRET_NOT_JSON\n\n', kind: 'invalid-json' },
    { body: frame({ unexpected: 'FIXTURE_SECRET_UNKNOWN_EVENT' }), kind: 'invalid-json' },
  ] as const) {
    await assert.rejects(readProviderPayload(new Response(fixture.body), 'chat-completions'), error => {
      assert.ok(error instanceof ProviderFormatError);
      assert.equal(error.kind, fixture.kind);
      assert.equal(error.message.includes('FIXTURE_SECRET'), false);
      return true;
    });
  }
  await assert.rejects(readProviderPayload(new Response(null), 'responses'), error => error instanceof ProviderFormatError && error.kind === 'empty');
});

test('real HTTP response-body aborts propagate as transport aborts rather than formatting errors', async t => {
  const url = await server(t, response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.flushHeaders();
    response.write(': waiting\n\n');
  });
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  const pending = readProviderPayload(response, 'responses');
  controller.abort();
  await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError' && !(error instanceof ProviderFormatError));
});

test('real HTTP Chat SSE preserves indexed function calls and assembles split names and JSON arguments', async t => {
  const args = JSON.stringify({ reply: '记好啦', actions: [], memoryActions: [] });
  const wire = frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-one', type: 'function', function: { name: 'mika_', arguments: args.slice(0, 12) } }] } }] })
    + frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'reply', arguments: args.slice(12) } }] } }] })
    + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    + 'data: [DONE]\n\n';
  const url = await server(t, response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(wire);
  });
  const result: any = await readProviderPayload(await fetch(url), 'chat-completions');
  assert.deepEqual(result.choices[0].message.tool_calls, [{ id: 'call-one', type: 'function', function: { name: 'mika_reply', arguments: args } }]);
  assert.equal(result.choices[0].message.content, '');
});

test('real HTTP Responses SSE reconstructs function calls without completed and preserves final completed output', async t => {
  const args = JSON.stringify({ reply: '好', actions: [], memoryActions: [] });
  const item = { id: 'fc-one', type: 'function_call', call_id: 'call-one', name: 'mika_reply', arguments: args, status: 'completed' };
  let completed = false;
  const url = await server(t, response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(frame({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } })
      + frame({ type: 'response.function_call_arguments.delta', item_id: 'fc-one', output_index: 0, delta: args.slice(0, 8) })
      + frame({ type: 'response.function_call_arguments.delta', item_id: 'fc-one', output_index: 0, delta: args.slice(8) })
      + frame({ type: 'response.function_call_arguments.done', item_id: 'fc-one', output_index: 0, arguments: args })
      + frame({ type: 'response.output_item.done', output_index: 0, item })
      + (completed ? frame({ type: 'response.completed', response: { id: 'response-one', status: 'completed', output: [item] } }) : ''));
  });
  const partial: any = await readProviderPayload(await fetch(url), 'responses');
  assert.deepEqual(partial.output, [item]);
  assert.equal(partial.output_text, '');
  completed = true;
  const final: any = await readProviderPayload(await fetch(url), 'responses');
  assert.equal(final.id, 'response-one');
  assert.deepEqual(final.output, [item]);
  assert.equal(final.output[0].arguments, args);
});

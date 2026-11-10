export class ProviderFormatError extends Error {
  constructor(readonly kind: 'html' | 'empty' | 'invalid-json') {
    super(kind === 'html' ? '模型接口返回了网页内容。'
      : kind === 'empty' ? '模型接口返回了空响应。'
      : '模型接口没有返回可识别的 JSON 或事件流。');
    this.name = 'ProviderFormatError';
  }
}

type Protocol = 'chat-completions' | 'responses';
type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.flatMap(part => object(part) && typeof part.text === 'string' ? [part.text] : []).join('') : '';
}

function responseText(value: JsonObject): string {
  if (typeof value.output_text === 'string' && value.output_text) return value.output_text;
  return Array.isArray(value.output) ? value.output.flatMap(item => object(item) && Array.isArray(item.content)
    ? item.content.flatMap(part => object(part) && typeof part.text === 'string' ? [part.text] : []) : []).join('\n') : '';
}

class EventPayload {
  terminal = false;
  events = 0;
  private error: unknown;
  private hasError = false;
  private chatText = '';
  private chatFinal: string | undefined;
  private chatTools = new Map<number, { id?: string; type: string; function: { name: string; arguments: string } }>();
  private chatFinalTools: unknown[] | undefined;
  private finalResponse: JsonObject | undefined;
  private parts = new Map<string, { output: number; content: number; sequence: number; delta: string; final?: string }>();
  private partAliases = new Map<string, string>();
  private items = new Map<string, { output: number; sequence: number; item: JsonObject }>();
  private itemAliases = new Map<string, string>();

  constructor(private protocol: Protocol) {}

  accept(event: string, data: string): void {
    if (!data.trim() || this.terminal) return;
    this.events++;
    if (data.trim() === '[DONE]') { this.terminal = true; return; }
    let value: unknown;
    try { value = JSON.parse(data); }
    catch { throw new ProviderFormatError('invalid-json'); }
    if (!object(value)) throw new ProviderFormatError('invalid-json');
    const type = typeof value.type === 'string' ? value.type : event;
    if (value.error !== undefined && value.error !== null) {
      this.fail(value.error);
      return;
    }
    if (type === 'error' || event === 'error') {
      this.fail(value);
      return;
    }
    if (type === 'response.failed' || type === 'response.incomplete') {
      this.fail(object(value.response) && value.response.error != null ? value.response.error
        : { code: type === 'response.failed' ? 'response_failed' : 'response_incomplete' });
      return;
    }

    if (this.protocol === 'chat-completions') {
      if (!Array.isArray(value.choices)) {
        if (event === 'ping' || object(value.usage)) return;
        throw new ProviderFormatError('invalid-json');
      }
      if (!value.choices.length) return; // Optional usage-only chunk.
      const choice = value.choices.find(item => object(item) && item.index === 0) ?? value.choices[0];
      if (!object(choice)) throw new ProviderFormatError('invalid-json');
      if (object(choice.delta)) {
        this.chatText += textContent(choice.delta.content);
        if (Array.isArray(choice.delta.tool_calls)) {
          for (const [position, call] of choice.delta.tool_calls.entries()) {
            if (!object(call)) throw new ProviderFormatError('invalid-json');
            const index = typeof call.index === 'number' ? call.index : position;
            let tool = this.chatTools.get(index);
            if (!tool) {
              tool = { type: 'function', function: { name: '', arguments: '' } };
              this.chatTools.set(index, tool);
            }
            if (typeof call.id === 'string') tool.id = call.id;
            if (typeof call.type === 'string') tool.type = call.type;
            if (object(call.function)) {
              if (typeof call.function.name === 'string') tool.function.name += call.function.name;
              if (typeof call.function.arguments === 'string') tool.function.arguments += call.function.arguments;
            }
          }
        }
      }
      // Some compatible gateways send one full completion in an SSE envelope.
      if (object(choice.message) && choice.message.content != null) this.chatFinal = textContent(choice.message.content);
      if (object(choice.message) && Array.isArray(choice.message.tool_calls)) this.chatFinalTools = choice.message.tool_calls;
      // Deliberately ignore reasoning_content and token usage.
      return;
    }

    if (type === 'response.completed') {
      if (!object(value.response)) throw new ProviderFormatError('invalid-json');
      if (value.response.error != null || value.response.status === 'failed' || value.response.status === 'incomplete') {
        this.fail(value.response.error ?? { code: 'response_failed' });
        return;
      }
      this.finalResponse = value.response;
      this.terminal = true;
      return;
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      if (!object(value.item)) throw new ProviderFormatError('invalid-json');
      this.rememberItem(value, value.item);
      return;
    }
    if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
      const item = this.rememberItem(value);
      item.type = 'function_call';
      if (typeof value.name === 'string') item.name = value.name;
      if (typeof value.call_id === 'string') item.call_id = value.call_id;
      if (type === 'response.function_call_arguments.delta') {
        if (typeof value.delta !== 'string') throw new ProviderFormatError('invalid-json');
        item.arguments = `${typeof item.arguments === 'string' ? item.arguments : ''}${value.delta}`;
      } else {
        if (typeof value.arguments !== 'string') throw new ProviderFormatError('invalid-json');
        item.arguments = value.arguments;
      }
      return;
    }
    if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
      const output = typeof value.output_index === 'number' ? value.output_index : 0;
      const content = typeof value.content_index === 'number' ? value.content_index : 0;
      const aliases = [
        ...(typeof value.output_index === 'number' ? [`output:${output}:${content}`] : []),
        ...(typeof value.item_id === 'string' ? [`item:${value.item_id}:${content}`] : []),
      ];
      const key = aliases.map(alias => this.partAliases.get(alias)).find(alias => alias !== undefined) ?? aliases[0] ?? `output:0:${content}`;
      for (const alias of aliases) this.partAliases.set(alias, key);
      let part = this.parts.get(key);
      if (!part) {
        part = { output, content, sequence: this.parts.size, delta: '' };
        this.parts.set(key, part);
      }
      if (typeof value.output_index === 'number') part.output = value.output_index;
      if (type === 'response.output_text.delta') {
        if (typeof value.delta !== 'string') throw new ProviderFormatError('invalid-json');
        part.delta += value.delta;
      } else {
        if (typeof value.text !== 'string') throw new ProviderFormatError('invalid-json');
        part.final = value.text;
      }
      return;
    }
    // Responses lifecycle and reasoning events carry no answer text.
    if (/^response\.(?:created|in_progress|queued|output_item\.(?:added|done)|content_part\.(?:added|done)|reasoning(?:_summary)?(?:\.|_))/.test(type)
      || event === 'ping') return;
    throw new ProviderFormatError('invalid-json');
  }

  private fail(error: unknown): void {
    this.hasError = true;
    this.error = error;
    this.terminal = true;
  }

  private rememberItem(frame: JsonObject, incoming?: JsonObject): JsonObject {
    const id = typeof incoming?.id === 'string' ? incoming.id : typeof frame.item_id === 'string' ? frame.item_id : undefined;
    const aliases = [
      ...(typeof frame.output_index === 'number' ? [`output:${frame.output_index}`] : []),
      ...(id ? [`item:${id}`] : []),
    ];
    const key = aliases.map(alias => this.itemAliases.get(alias)).find(alias => alias !== undefined) ?? aliases[0] ?? 'output:0';
    for (const alias of aliases) this.itemAliases.set(alias, key);
    let entry = this.items.get(key);
    if (!entry) {
      entry = { output: typeof frame.output_index === 'number' ? frame.output_index : 0, sequence: this.items.size, item: {} };
      this.items.set(key, entry);
    }
    if (typeof frame.output_index === 'number') entry.output = frame.output_index;
    if (id) entry.item.id = id;
    if (incoming) Object.assign(entry.item, incoming);
    return entry.item;
  }

  result(): unknown {
    if (this.hasError) return { error: this.error };
    if (!this.events) throw new ProviderFormatError('invalid-json');
    if (this.protocol === 'chat-completions') {
      const tools = this.chatFinalTools ?? [...this.chatTools.entries()].sort(([a], [b]) => a - b).map(([, tool]) => tool);
      return { choices: [{ message: {
        role: 'assistant', content: this.chatFinal ?? this.chatText,
        ...(tools.length ? { tool_calls: tools } : {}),
      } }] };
    }
    const partial = [...this.parts.values()].sort((a, b) => a.output - b.output || a.content - b.content || a.sequence - b.sequence)
      .map(part => part.final ?? part.delta).join('\n');
    // A done/completed event repeats deltas; use it as a replacement, never append it.
    const items = [...this.items.values()].sort((a, b) => a.output - b.output || a.sequence - b.sequence).map(entry => entry.item);
    const response = { ...this.finalResponse };
    if ((!Array.isArray(response.output) || !response.output.length) && items.length) response.output = items;
    const text = responseText(response) || partial;
    return { ...response, output_text: text };
  }
}

/** Reads wire JSON or OpenAI-compatible SSE; provider content is never copied into exceptions. */
export async function readProviderPayload(response: Response, protocol: Protocol): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderFormatError('empty');
  const decoder = new TextDecoder();
  const payload = new EventPayload(protocol);
  let mode: 'unknown' | 'json' | 'sse' = 'unknown';
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let completed = false;

  function dispatch(): void {
    if (data.length) payload.accept(event, data.join('\n'));
    event = '';
    data = [];
  }

  function line(value: string): void {
    if (!value) { dispatch(); return; }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') data.push(content);
    if (field === 'event') event = content;
  }

  function consume(final: boolean): void {
    while (!payload.terminal) {
      const end = buffer.search(/[\r\n]/);
      if (end < 0) break;
      // Keep a trailing CR until the next chunk so a split CRLF is one newline.
      if (!final && buffer[end] === '\r' && end === buffer.length - 1) break;
      const value = buffer.slice(0, end);
      const width = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(end + width);
      line(value);
    }
    if (final && !payload.terminal) {
      if (buffer) line(buffer);
      buffer = '';
      dispatch();
    }
  }

  function detect(final: boolean): 'unknown' | 'json' | 'sse' {
    if (mode !== 'unknown') return mode;
    const start = buffer.trimStart(); // Includes UTF-8 BOM and leading whitespace.
    if (!start) return 'unknown';
    const prefixes = ['data:', 'event:', 'id:', 'retry:'];
    if (start.startsWith(':') || prefixes.some(prefix => start.startsWith(prefix))) {
      buffer = start;
      return 'sse';
    }
    return final || !prefixes.some(prefix => prefix.startsWith(start)) ? 'json' : 'unknown';
  }

  try {
    while (true) {
      // Native AbortError/TimeoutError propagates so the caller can classify its 90s timeout.
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      mode = detect(done);
      if (mode === 'sse') consume(done);
      if (payload.terminal) return payload.result();
      if (done) {
        completed = true;
        if (mode === 'sse') return payload.result();
        const text = buffer.trim();
        if (!text) throw new ProviderFormatError('empty');
        try { return JSON.parse(text); }
        catch { throw new ProviderFormatError(text.startsWith('<') ? 'html' : 'invalid-json'); }
      }
    }
  } finally {
    // DONE/completed/error can arrive while a gateway keeps the connection alive.
    // Cancellation is intentionally not awaited: a broken producer must not hold up the result.
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

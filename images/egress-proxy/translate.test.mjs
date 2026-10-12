import { describe, expect, it } from 'vitest';
import {
  chatToMessage,
  chatToResponse,
  countTokens,
  messagesToChat,
  readChatStream,
  responsesToChat,
  streamChatAsMessages,
  streamChatAsResponses,
} from './translate.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Minimal stand-in for http.ServerResponse that records what the converters write. */
function fakeRes() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    write(chunk) {
      this.body += chunk;
      return true;
    },
    end() {
      this.ended = true;
    },
  };
}

/** Parses the SSE body written to a fakeRes into [{ event, data }]. */
function events(res) {
  return res.body
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event: ')).slice(7);
      const data = JSON.parse(lines.find((l) => l.startsWith('data: ')).slice(6));
      return { event, data };
    });
}

/** An upstream Chat Completions SSE stream as the proxy sees it (async iterable of Buffers). */
function sseUpstream(chunks, { splitEvery } = {}) {
  const text = chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = Buffer.from(text, 'utf8');
  const pieces = [];
  const size = splitEvery ?? bytes.length;
  for (let i = 0; i < bytes.length; i += size) pieces.push(bytes.subarray(i, i + size));
  return (async function* () {
    for (const piece of pieces) yield piece;
  })();
}

const delta = (d, finish_reason = null) => ({ choices: [{ index: 0, delta: d, finish_reason }] });

// A realistic llama.cpp/vLLM stream: text, then one tool call whose arguments are split across chunks, then usage.
const TEXT_THEN_TOOL = [
  delta({ role: 'assistant', content: '' }),
  delta({ content: 'Let me ' }),
  delta({ content: 'check.' }),
  delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
  delta({}, 'tool_calls'),
  { choices: [], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } },
];

// ── readChatStream ────────────────────────────────────────────────────────────

describe('readChatStream', () => {
  it('reassembles events split across arbitrary byte boundaries (including inside multi-byte characters)', async () => {
    const seen = [];
    await readChatStream(sseUpstream([delta({ content: 'Grüße 👋' }), delta({ content: '!' })], { splitEvery: 3 }), (c) => seen.push(c));
    expect(seen.map((c) => c.choices[0].delta.content).join('')).toBe('Grüße 👋!');
  });

  it('skips [DONE], comments, empty data and malformed JSON', async () => {
    const seen = [];
    const upstream = [Buffer.from(': keep-alive\n\ndata: \n\ndata: {not json\n\ndata: {"ok":1}\n\ndata: [DONE]\n\n')];
    await readChatStream(upstream, (c) => seen.push(c));
    expect(seen).toEqual([{ ok: 1 }]);
  });
});

// ── Anthropic Messages → Chat ─────────────────────────────────────────────────

describe('messagesToChat', () => {
  it('maps the system prompt (string or blocks), sampling params and stop sequences', () => {
    const chat = messagesToChat({
      model: 'qwen3',
      system: [
        { type: 'text', text: 'You are ' },
        { type: 'text', text: 'helpful.', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 1024,
      temperature: 0.2,
      top_p: 0.9,
      stop_sequences: ['END'],
    });
    expect(chat).toEqual({
      model: 'qwen3',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ],
      max_tokens: 1024,
      stream: false,
      temperature: 0.2,
      top_p: 0.9,
      stop: ['END'],
    });
  });

  it('omits the system message when there is none and requests usage when streaming', () => {
    const chat = messagesToChat({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 5, stream: true });
    expect(chat.messages).toEqual([{ role: 'user', content: 'x' }]);
    expect(chat.stream).toBe(true);
    expect(chat.stream_options).toEqual({ include_usage: true });
    expect(chat).not.toHaveProperty('stop');
    expect(chat).not.toHaveProperty('temperature');
  });

  it('turns assistant tool_use blocks into tool_calls and user tool_result blocks into tool messages', () => {
    const chat = messagesToChat({
      model: 'm',
      max_tokens: 100,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'List files' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'dropped' },
            { type: 'text', text: 'Sure.' },
            { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
            { type: 'tool_use', id: 'toolu_2', name: 'noop' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'a.txt\n' }, { type: 'text', text: 'b.txt' }] },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true },
            { type: 'text', text: 'Thanks' },
          ],
        },
      ],
    });
    expect(chat.messages).toEqual([
      { role: 'user', content: 'List files' },
      {
        role: 'assistant',
        content: 'Sure.',
        tool_calls: [
          { id: 'toolu_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
          { id: 'toolu_2', type: 'function', function: { name: 'noop', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'a.txt\nb.txt' },
      { role: 'tool', tool_call_id: 'toolu_2', content: 'Error: boom' },
      { role: 'user', content: 'Thanks' },
    ]);
  });

  it('uses content null for assistant turns that only call tools, and "" for empty ones', () => {
    const chat = messagesToChat({
      model: 'm',
      max_tokens: 1,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
        { role: 'assistant', content: [] },
      ],
    });
    expect(chat.messages[0]).toMatchObject({ role: 'assistant', content: null });
    expect(chat.messages[1]).toEqual({ role: 'assistant', content: '' });
  });

  it('converts images to image_url parts (base64 and url sources)', () => {
    const chat = messagesToChat({
      model: 'm',
      max_tokens: 1,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
          ],
        },
      ],
    });
    expect(chat.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'image_url', image_url: { url: 'https://x/y.png' } },
      ],
    });
  });

  it('maps tool definitions, drops server tools without input_schema and maps tool_choice', () => {
    const schema = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] };
    const base = {
      model: 'm',
      max_tokens: 1,
      messages: [],
      tools: [
        { name: 'bash', description: 'Run a command', input_schema: schema },
        { name: 'nodesc', input_schema: { type: 'object' } },
        { type: 'web_search_20250305', name: 'web_search' },
      ],
    };
    const chat = messagesToChat(base);
    expect(chat.tools).toEqual([
      { type: 'function', function: { name: 'bash', description: 'Run a command', parameters: schema } },
      { type: 'function', function: { name: 'nodesc', description: '', parameters: { type: 'object' } } },
    ]);
    expect(chat).not.toHaveProperty('tool_choice');
    expect(messagesToChat({ ...base, tool_choice: { type: 'auto' } })).not.toHaveProperty('tool_choice');
    expect(messagesToChat({ ...base, tool_choice: { type: 'any' } }).tool_choice).toBe('required');
    expect(messagesToChat({ ...base, tool_choice: { type: 'none' } }).tool_choice).toBe('none');
    expect(messagesToChat({ ...base, tool_choice: { type: 'tool', name: 'bash' } }).tool_choice).toEqual({ type: 'function', function: { name: 'bash' } });
  });
});

describe('chatToMessage', () => {
  it('maps text, tool calls, stop reason and usage', () => {
    const msg = chatToMessage(
      {
        choices: [
          {
            message: { content: 'Running it.', tool_calls: [{ id: 'call_9', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      },
      'claude-sonnet',
    );
    expect(msg).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet',
      content: [
        { type: 'text', text: 'Running it.' },
        { type: 'tool_use', id: 'call_9', name: 'bash', input: { command: 'ls' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 3 },
    });
    expect(msg.id).toMatch(/^msg_[0-9a-f]{24}$/);
  });

  it.each([
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['tool_calls', 'tool_use'],
    ['function_call', 'tool_use'],
    ['content_filter', 'end_turn'],
    [null, 'end_turn'],
    ['something_new', 'end_turn'],
  ])('maps finish_reason %s to stop_reason %s', (finish, stop) => {
    expect(chatToMessage({ choices: [{ message: { content: 'x' }, finish_reason: finish }] }, 'm').stop_reason).toBe(stop);
  });

  it('keeps unparsable tool arguments as raw, generates missing ids and defaults usage to 0', () => {
    const msg = chatToMessage({ choices: [{ message: { content: null, tool_calls: [{ function: { name: 'x', arguments: '{oops' } }, { function: { name: 'y', arguments: '' } }] } }] }, 'm');
    expect(msg.content).toEqual([
      { type: 'tool_use', id: expect.stringMatching(/^toolu_/), name: 'x', input: { raw: '{oops' } },
      { type: 'tool_use', id: expect.stringMatching(/^toolu_/), name: 'y', input: {} },
    ]);
    expect(msg.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('copes with an empty response', () => {
    expect(chatToMessage({}, 'm')).toMatchObject({ content: [], stop_reason: 'end_turn' });
  });
});

describe('countTokens', () => {
  it('estimates roughly one token per four characters of system, messages and tools', () => {
    const body = { system: 'abcd', messages: [{ role: 'user', content: 'hello world' }], tools: [] };
    const expected = Math.ceil(JSON.stringify(['abcd', body.messages, []]).length / 4);
    expect(countTokens(body)).toEqual({ input_tokens: expected });
  });

  it('works for an empty body and grows with the input', () => {
    expect(countTokens({}).input_tokens).toBeGreaterThan(0);
    expect(countTokens({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] }).input_tokens).toBeGreaterThanOrEqual(1000);
  });
});

describe('readChatStream: last line', () => {
  it('handles a final event without a trailing newline', async () => {
    const seen = [];
    const upstream = (async function* () {
      yield Buffer.from('data: {"a":1}\n\ndata: {"b":2}');
    })();
    await readChatStream(upstream, (chunk) => seen.push(chunk));
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('streamChatAsMessages', () => {
  it('reports prompt tokens from the end of the chat stream in message_delta', async () => {
    const res = fakeRes();
    const chunks = [
      { choices: [{ index: 0, delta: { content: 'Hi' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 1234, completion_tokens: 5 } },
    ];
    await streamChatAsMessages(sseUpstream(chunks), res, 'm');
    const delta = events(res).find((e) => e.event === 'message_delta');
    expect(delta.data.usage).toEqual({ input_tokens: 1234, output_tokens: 5 });
  });

  it('emits Anthropic events in order for text followed by a streamed tool call', async () => {
    const res = fakeRes();
    await streamChatAsMessages(sseUpstream(TEXT_THEN_TOOL, { splitEvery: 17 }), res, 'claude-model');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.ended).toBe(true);

    const ev = events(res);
    expect(ev.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    // every event carries its own type
    for (const e of ev) expect(e.data.type).toBe(e.event);

    expect(ev[0].data.message).toMatchObject({ role: 'assistant', model: 'claude-model', content: [], stop_reason: null });
    expect(ev[1].data).toMatchObject({ index: 0, content_block: { type: 'text', text: '' } });
    expect(ev[2].data).toMatchObject({ index: 0, delta: { type: 'text_delta', text: 'Let me ' } });
    expect(ev[3].data).toMatchObject({ index: 0, delta: { type: 'text_delta', text: 'check.' } });
    expect(ev[4].data).toMatchObject({ index: 0 });
    expect(ev[5].data).toMatchObject({ index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} } });
    expect(ev[6].data).toMatchObject({ index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } });
    expect(ev[7].data).toMatchObject({ index: 1, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } });
    expect(ev[8].data).toMatchObject({ index: 1 });
    expect(ev[9].data).toMatchObject({ delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } });

    // the partial JSON reassembles to the original arguments
    const json = ev.filter((e) => e.data.delta?.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('');
    expect(JSON.parse(json)).toEqual({ path: 'a.txt' });
  });

  it('opens one block per parallel tool call and handles arguments in the first chunk', async () => {
    const res = fakeRes();
    await streamChatAsMessages(
      sseUpstream([
        delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{}' } }] }),
        delta({ tool_calls: [{ index: 1, function: { name: 'two', arguments: '{"x":1}' } }] }),
        delta({}, 'tool_calls'),
      ]),
      res,
      'm',
    );
    const ev = events(res);
    const starts = ev.filter((e) => e.event === 'content_block_start');
    expect(starts.map((e) => [e.data.index, e.data.content_block.name])).toEqual([
      [0, 'one'],
      [1, 'two'],
    ]);
    expect(starts[0].data.content_block.id).toBe('a');
    expect(starts[1].data.content_block.id).toMatch(/^toolu_/); // missing id generated
    expect(ev.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index)).toEqual([0, 1]);
    expect(ev.at(-2).data.delta.stop_reason).toBe('tool_use');
  });

  it('maps finish_reason length to max_tokens and still terminates an empty stream properly', async () => {
    const res = fakeRes();
    await streamChatAsMessages(sseUpstream([delta({ content: 'cut' }, 'length')]), res, 'm');
    expect(events(res).at(-2).data.delta.stop_reason).toBe('max_tokens');

    const empty = fakeRes();
    await streamChatAsMessages(sseUpstream([]), empty, 'm');
    expect(events(empty).map((e) => e.event)).toEqual(['message_start', 'message_delta', 'message_stop']);
    expect(events(empty)[1].data).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } });
  });

  it('starts a new text block when text follows a tool call', async () => {
    const res = fakeRes();
    await streamChatAsMessages(
      sseUpstream([delta({ tool_calls: [{ index: 0, id: 't', function: { name: 'x', arguments: '{}' } }] }), delta({ content: 'after' })]),
      res,
      'm',
    );
    const starts = events(res).filter((e) => e.event === 'content_block_start');
    expect(starts.map((e) => [e.data.index, e.data.content_block.type])).toEqual([
      [0, 'tool_use'],
      [1, 'text'],
    ]);
  });
});

// ── OpenAI Responses → Chat ───────────────────────────────────────────────────

describe('responsesToChat', () => {
  it('maps instructions, string input and limits', () => {
    const { chat, customTools } = responsesToChat({
      model: 'gpt-x',
      instructions: 'Be terse.',
      input: 'Hello',
      max_output_tokens: 256,
      temperature: 0,
      stream: true,
    });
    expect(chat).toEqual({
      model: 'gpt-x',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Hello' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 256,
      temperature: 0,
    });
    expect(customTools.size).toBe(0);
  });

  it('maps developer messages to system, joins text parts, keeps images and drops reasoning items', () => {
    const { chat } = responsesToChat({
      model: 'm',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Rules' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'Look' }, { type: 'input_image', image_url: 'data:image/png;base64,AA' }] },
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Line 1' }, { type: 'output_text', text: 'Line 2' }, { type: 'output_text', text: '' }] },
      ],
    });
    expect(chat.messages).toEqual([
      { role: 'system', content: 'Rules' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
        ],
      },
      { role: 'assistant', content: 'Line 1\nLine 2' },
    ]);
  });

  it('groups consecutive function calls into one assistant message and maps their outputs', () => {
    const { chat } = responsesToChat({
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: 'go' },
        { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":["ls"]}' },
        { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: '*** Begin Patch' },
        { type: 'local_shell_call', call_id: 'c3', action: { type: 'exec', command: ['pwd'] } },
        { type: 'function_call_output', call_id: 'c1', output: 'a.txt' },
        { type: 'custom_tool_call_output', call_id: 'c2', output: 'Done' },
        { type: 'local_shell_call_output', call_id: 'c3', output: { stdout: '/w' } },
      ],
    });
    expect(chat.messages).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"cmd":["ls"]}' } },
          { id: 'c2', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' } },
          { id: 'c3', type: 'function', function: { name: 'local_shell', arguments: '{"type":"exec","command":["pwd"]}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'a.txt' },
      { role: 'tool', tool_call_id: 'c2', content: 'Done' },
      { role: 'tool', tool_call_id: 'c3', content: '{"stdout":"/w"}' },
    ]);
  });

  it('starts a new assistant message for calls after an assistant text message', () => {
    const { chat } = responsesToChat({
      model: 'm',
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking' }] },
        { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' },
      ],
    });
    expect(chat.messages).toEqual([
      { role: 'assistant', content: 'Checking' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    ]);
  });

  it('turns custom tools into functions taking {input} and remembers their names', () => {
    const { chat, customTools } = responsesToChat({
      model: 'm',
      input: [],
      tools: [
        { type: 'function', name: 'shell', description: 'Run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
        { type: 'function', name: 'bare' },
        { type: 'custom', name: 'apply_patch', description: 'Apply a patch', format: { type: 'grammar' } },
        { type: 'local_shell' },
        { type: 'web_search' },
      ],
      tool_choice: 'required',
    });
    expect([...customTools]).toEqual(['apply_patch']);
    expect(chat.tools).toHaveLength(4);
    expect(chat.tools[0]).toEqual({ type: 'function', function: { name: 'shell', description: 'Run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } });
    expect(chat.tools[1].function).toEqual({ name: 'bare', description: '', parameters: { type: 'object', properties: {} } });
    expect(chat.tools[2].function.name).toBe('apply_patch');
    expect(chat.tools[2].function.description).toContain('Apply a patch');
    expect(chat.tools[2].function.description).toContain('"input"');
    expect(chat.tools[2].function.parameters).toEqual({
      type: 'object',
      properties: { input: { type: 'string', description: 'Raw tool input' } },
      required: ['input'],
    });
    expect(chat.tools[3].function).toMatchObject({ name: 'local_shell', parameters: { required: ['command'] } });
    expect(chat.tool_choice).toBe('required');
  });

  it('maps tool_choice and leaves it out without tools', () => {
    const tools = [{ type: 'function', name: 'f' }];
    expect(responsesToChat({ model: 'm', input: [], tools, tool_choice: 'auto' }).chat).not.toHaveProperty('tool_choice');
    expect(responsesToChat({ model: 'm', input: [], tools, tool_choice: 'none' }).chat.tool_choice).toBe('none');
    expect(responsesToChat({ model: 'm', input: [], tools, tool_choice: { type: 'function', name: 'f' } }).chat.tool_choice).toEqual({ type: 'function', function: { name: 'f' } });
    const noTools = responsesToChat({ model: 'm', input: [], tools: [{ type: 'web_search' }], tool_choice: 'required' }).chat;
    expect(noTools).not.toHaveProperty('tools');
    expect(noTools).not.toHaveProperty('tool_choice');
  });
});

describe('chatToResponse', () => {
  it('builds a completed response with message and function_call items and usage', () => {
    const resp = chatToResponse(
      {
        choices: [{ message: { content: 'Hi', tool_calls: [{ id: 'call_1', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }] } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
      'gpt-x',
      new Set(),
    );
    expect(resp).toMatchObject({
      object: 'response',
      status: 'completed',
      model: 'gpt-x',
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      output: [
        { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hi', annotations: [] }] },
        { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}', status: 'completed' },
      ],
    });
    expect(resp.id).toMatch(/^resp_/);
    expect(typeof resp.created_at).toBe('number');
  });

  it('unwraps {input} for custom tools and keeps raw arguments when they are not JSON', () => {
    const custom = new Set(['apply_patch']);
    const resp = chatToResponse(
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'c1', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' } },
                { id: 'c2', function: { name: 'apply_patch', arguments: 'raw patch text' } },
                { id: 'c3', function: { name: 'apply_patch', arguments: '{"other":1}' } },
              ],
            },
          },
        ],
      },
      'm',
      custom,
    );
    expect(resp.output).toEqual([
      expect.objectContaining({ type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' }),
      expect.objectContaining({ type: 'custom_tool_call', call_id: 'c2', input: 'raw patch text' }),
      expect.objectContaining({ type: 'custom_tool_call', call_id: 'c3', input: '{"other":1}' }),
    ]);
    expect(resp.usage).toBeUndefined();
  });

  it('defaults missing arguments to {} and generates missing call ids', () => {
    const resp = chatToResponse({ choices: [{ message: { tool_calls: [{ function: { name: 'f' } }] } }] }, 'm', new Set());
    expect(resp.output[0]).toMatchObject({ type: 'function_call', arguments: '{}', call_id: expect.stringMatching(/^call_/) });
  });
});

describe('streamChatAsResponses', () => {
  it('emits Responses events in order for text followed by a streamed tool call', async () => {
    const res = fakeRes();
    await streamChatAsResponses(sseUpstream(TEXT_THEN_TOOL, { splitEvery: 11 }), res, 'gpt-x', new Set());
    expect(res.status).toBe(200);
    expect(res.ended).toBe(true);
    const ev = events(res);
    expect(ev.map((e) => e.event)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.output_item.done',
      'response.completed',
    ]);
    for (const e of ev) expect(e.data.type).toBe(e.event);

    const created = ev[0].data.response;
    expect(created).toMatchObject({ status: 'in_progress', model: 'gpt-x', output: [] });
    const msgId = ev[1].data.item.id;
    expect(ev[1].data).toMatchObject({ output_index: 0, item: { type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
    expect(ev[3].data).toMatchObject({ item_id: msgId, output_index: 0, content_index: 0, delta: 'Let me ' });
    expect(ev[5].data).toMatchObject({ item_id: msgId, text: 'Let me check.' });
    expect(ev[6].data.item).toMatchObject({ id: msgId, status: 'completed', content: [{ type: 'output_text', text: 'Let me check.' }] });
    expect(ev[7].data).toMatchObject({ output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'read_file', status: 'in_progress' } });
    expect(ev[8].data).toMatchObject({ output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}', status: 'completed' } });

    const done = ev[9].data.response;
    expect(done.id).toBe(created.id);
    expect(done.status).toBe('completed');
    expect(done.usage).toEqual({ input_tokens: 42, output_tokens: 7, total_tokens: 49 });
    expect(done.output.map((o) => o.type)).toEqual(['message', 'function_call']);
  });

  it('emits custom_tool_call items for custom tools and keeps parallel calls in order', async () => {
    const res = fakeRes();
    await streamChatAsResponses(
      sseUpstream([
        delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'apply_patch', arguments: '{"in' } }] }),
        delta({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'shell', arguments: '{}' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'put":"PATCH"}' } }] }),
      ]),
      res,
      'm',
      new Set(['apply_patch']),
    );
    const ev = events(res);
    const doneItems = ev.filter((e) => e.event === 'response.output_item.done').map((e) => [e.data.output_index, e.data.item]);
    expect(doneItems).toEqual([
      [0, expect.objectContaining({ type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: 'PATCH' })],
      [1, expect.objectContaining({ type: 'function_call', call_id: 'c2', name: 'shell', arguments: '{}' })],
    ]);
    const completed = ev.at(-1).data.response;
    expect(completed.output.map((o) => o.call_id)).toEqual(['c1', 'c2']);
    expect(completed.usage).toBeUndefined();
  });

  it('completes an empty stream with no output', async () => {
    const res = fakeRes();
    await streamChatAsResponses(sseUpstream([]), res, 'm', new Set());
    const ev = events(res);
    expect(ev.map((e) => e.event)).toEqual(['response.created', 'response.completed']);
    expect(ev[1].data.response.output).toEqual([]);
  });
});

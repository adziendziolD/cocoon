// API translation for chat-only model servers (llama.cpp, vLLM, LM Studio, …), dependency-free.
//
//  - Anthropic Messages  (/v1/messages, used by Claude Code) → OpenAI Chat Completions
//  - OpenAI Responses    (/v1/responses, used by Codex)      → OpenAI Chat Completions
//
// Both directions support streaming (SSE) and tool calls. Unsupported details (thinking blocks, prompt caching,
// hosted tools) are dropped.
import { randomBytes } from 'node:crypto';

const newId = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part === 'string' ? part : (part.text ?? part.output ?? (part.type === 'image' ? '[image]' : '')))).join('')
      : content == null
        ? ''
        : JSON.stringify(content);

/** Reads OpenAI SSE chunks from an upstream response; calls onChunk(json) for each data event. */
export async function readChatStream(upstream, onChunk) {
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (raw) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      onChunk(JSON.parse(data));
    } catch {
      // ignore malformed chunks
    }
  };
  for await (const piece of upstream) {
    buffer += decoder.decode(piece, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      handle(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  }
  // A last line without a trailing newline.
  handle(buffer + decoder.decode());
}

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);

// ── Anthropic Messages → Chat ────────────────────────────────────────────────

const STOP_REASONS = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };

function anthropicImage(block) {
  const src = block.source ?? {};
  return { type: 'image_url', image_url: { url: src.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : src.url } };
}

export function messagesToChat(body) {
  const messages = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const message of body.messages ?? []) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolCalls = message.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push({ role: 'assistant', content: text || (toolCalls.length ? null : ''), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    // user: tool results become tool messages (they must directly follow the assistant tool calls)
    const parts = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        const content = textOf(block.content);
        messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.is_error ? `Error: ${content}` : content });
      } else if (block.type === 'text') parts.push({ type: 'text', text: block.text });
      else if (block.type === 'image') parts.push(anthropicImage(block));
    }
    if (parts.length) messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
  }
  const chat = { model: body.model, messages, max_tokens: body.max_tokens, stream: Boolean(body.stream) };
  if (body.stream) chat.stream_options = { include_usage: true };
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  if (body.stop_sequences?.length) chat.stop = body.stop_sequences;
  if (body.tools?.length) {
    chat.tools = body.tools
      .filter((tool) => tool.input_schema)
      .map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: tool.input_schema } }));
    const choice = body.tool_choice;
    if (choice?.type === 'any') chat.tool_choice = 'required';
    else if (choice?.type === 'tool') chat.tool_choice = { type: 'function', function: { name: choice.name } };
    else if (choice?.type === 'none') chat.tool_choice = 'none';
  }
  return chat;
}

export function chatToMessage(chat, model) {
  const choice = chat.choices?.[0] ?? {};
  const content = [];
  if (choice.message?.content) content.push({ type: 'text', text: choice.message.content });
  for (const call of choice.message?.tool_calls ?? []) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments || '{}');
    } catch {
      input = { raw: call.function?.arguments };
    }
    content.push({ type: 'tool_use', id: call.id || newId('toolu'), name: call.function?.name, input });
  }
  return {
    id: newId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: STOP_REASONS[choice.finish_reason] ?? 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: chat.usage?.prompt_tokens ?? 0, output_tokens: chat.usage?.completion_tokens ?? 0 },
  };
}

/** Streams an upstream chat completion as Anthropic Messages events. */
export async function streamChatAsMessages(upstream, res, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  sse(res, 'message_start', {
    message: { id: newId('msg'), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });
  let index = -1;
  let open = null; // 'text' | 'tool'
  const tools = new Map(); // chat tool index → block index
  let stopReason = 'end_turn';
  const usage = { input_tokens: 0, output_tokens: 0 };
  const close = () => {
    if (open) sse(res, 'content_block_stop', { index });
    open = null;
  };
  await readChatStream(upstream, (chunk) => {
    if (chunk.usage) {
      usage.input_tokens = chunk.usage.prompt_tokens ?? usage.input_tokens;
      usage.output_tokens = chunk.usage.completion_tokens ?? usage.output_tokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (delta.content) {
      if (open !== 'text') {
        close();
        index += 1;
        open = 'text';
        sse(res, 'content_block_start', { index, content_block: { type: 'text', text: '' } });
      }
      sse(res, 'content_block_delta', { index, delta: { type: 'text_delta', text: delta.content } });
    }
    for (const call of delta.tool_calls ?? []) {
      const key = call.index ?? 0;
      if (!tools.has(key)) {
        close();
        index += 1;
        open = 'tool';
        tools.set(key, index);
        sse(res, 'content_block_start', { index, content_block: { type: 'tool_use', id: call.id || newId('toolu'), name: call.function?.name ?? '', input: {} } });
      }
      if (call.function?.arguments) sse(res, 'content_block_delta', { index: tools.get(key), delta: { type: 'input_json_delta', partial_json: call.function.arguments } });
    }
    if (choice.finish_reason) stopReason = STOP_REASONS[choice.finish_reason] ?? 'end_turn';
  });
  close();
  // The chat stream reports prompt tokens only at the end; message_start had to send 0.
  sse(res, 'message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } });
  sse(res, 'message_stop', {});
  res.end();
}

/** Rough token estimate for /v1/messages/count_tokens (chat servers have no equivalent). */
export function countTokens(body) {
  const text = JSON.stringify([body.system ?? '', body.messages ?? [], body.tools ?? []]);
  return { input_tokens: Math.ceil(text.length / 4) };
}

// ── OpenAI Responses → Chat ──────────────────────────────────────────────────

const CUSTOM_TOOL_SCHEMA = { type: 'object', properties: { input: { type: 'string', description: 'Raw tool input' } }, required: ['input'] };

export function responsesToChat(body) {
  const messages = [];
  const customTools = new Set();
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  const items = typeof body.input === 'string' ? [{ type: 'message', role: 'user', content: body.input }] : (body.input ?? []);
  for (const item of items) {
    const type = item.type ?? (item.role ? 'message' : undefined);
    if (type === 'message') {
      const role = item.role === 'developer' ? 'system' : item.role;
      if (typeof item.content === 'string') {
        messages.push({ role, content: item.content });
        continue;
      }
      const parts = (item.content ?? [])
        .map((part) =>
          part.type === 'input_image'
            ? { type: 'image_url', image_url: { url: part.image_url } }
            : { type: 'text', text: part.text ?? part.refusal ?? '' },
        )
        .filter((part) => part.type !== 'text' || part.text);
      const onlyText = parts.every((p) => p.type === 'text');
      messages.push({ role, content: onlyText ? parts.map((p) => p.text).join('\n') : parts });
    } else if (type === 'function_call' || type === 'custom_tool_call' || type === 'local_shell_call') {
      const call = {
        id: item.call_id ?? item.id,
        type: 'function',
        function: {
          name: item.name ?? 'local_shell',
          arguments: type === 'custom_tool_call' ? JSON.stringify({ input: item.input ?? '' }) : type === 'local_shell_call' ? JSON.stringify(item.action ?? {}) : (item.arguments ?? '{}'),
        },
      };
      const last = messages.at(-1);
      if (last?.role === 'assistant' && last.tool_calls && !last.content) last.tool_calls.push(call);
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: textOf(item.output) });
    }
    // reasoning and other items are dropped
  }
  const chat = { model: body.model, messages, stream: Boolean(body.stream) };
  if (body.stream) chat.stream_options = { include_usage: true };
  if (body.max_output_tokens) chat.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  const tools = [];
  for (const tool of body.tools ?? []) {
    if (tool.type === 'function') tools.push({ type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? { type: 'object', properties: {} } } });
    else if (tool.type === 'custom') {
      customTools.add(tool.name);
      tools.push({ type: 'function', function: { name: tool.name, description: `${tool.description ?? ''}\nPass the complete raw input as the "input" string.`, parameters: CUSTOM_TOOL_SCHEMA } });
    } else if (tool.type === 'local_shell') {
      tools.push({
        type: 'function',
        function: {
          name: 'local_shell',
          description: 'Run a shell command',
          parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } }, workdir: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['command'] },
        },
      });
    }
  }
  if (tools.length) {
    chat.tools = tools;
    const choice = body.tool_choice;
    if (choice === 'required' || choice === 'none') chat.tool_choice = choice;
    else if (choice?.type === 'function') chat.tool_choice = { type: 'function', function: { name: choice.name } };
  }
  return { chat, customTools };
}

function outputItemForCall(call, customTools) {
  const name = call.function?.name ?? '';
  const args = call.function?.arguments || '{}';
  const callId = call.id || newId('call');
  if (customTools.has(name)) {
    let input = args;
    try {
      input = JSON.parse(args).input ?? args;
    } catch {
      // keep raw
    }
    return { type: 'custom_tool_call', id: newId('ctc'), call_id: callId, name, input, status: 'completed' };
  }
  return { type: 'function_call', id: newId('fc'), call_id: callId, name, arguments: args, status: 'completed' };
}

const messageItem = (id, text) => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });

function responseEnvelope(id, model, status, output, usage) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    usage: usage && { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? 0 },
  };
}

export function chatToResponse(chat, model, customTools) {
  const choice = chat.choices?.[0] ?? {};
  const output = [];
  if (choice.message?.content) output.push(messageItem(newId('msg'), choice.message.content));
  for (const call of choice.message?.tool_calls ?? []) output.push(outputItemForCall(call, customTools));
  return responseEnvelope(newId('resp'), model, 'completed', output, chat.usage);
}

/** Streams an upstream chat completion as OpenAI Responses events. */
export async function streamChatAsResponses(upstream, res, model, customTools) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const responseId = newId('resp');
  sse(res, 'response.created', { response: responseEnvelope(responseId, model, 'in_progress', []) });
  const output = [];
  let text = null; // { id, index, text }
  const calls = new Map(); // chat index → { call, outputIndex }
  let usage;
  const finishText = () => {
    if (!text) return;
    sse(res, 'response.output_text.done', { item_id: text.id, output_index: text.index, content_index: 0, text: text.text });
    const item = messageItem(text.id, text.text);
    output[text.index] = item;
    sse(res, 'response.output_item.done', { output_index: text.index, item });
    text = null;
  };
  await readChatStream(upstream, (chunk) => {
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      if (!text) {
        text = { id: newId('msg'), index: output.length, text: '' };
        output.push(null);
        sse(res, 'response.output_item.added', {
          output_index: text.index,
          item: { type: 'message', id: text.id, role: 'assistant', status: 'in_progress', content: [] },
        });
        sse(res, 'response.content_part.added', { item_id: text.id, output_index: text.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      text.text += delta.content;
      sse(res, 'response.output_text.delta', { item_id: text.id, output_index: text.index, content_index: 0, delta: delta.content });
    }
    for (const part of delta.tool_calls ?? []) {
      const key = part.index ?? 0;
      let entry = calls.get(key);
      if (!entry) {
        finishText();
        entry = { call: { id: part.id, function: { name: part.function?.name ?? '', arguments: '' } }, outputIndex: output.length };
        output.push(null);
        calls.set(key, entry);
      }
      if (part.id) entry.call.id = part.id;
      if (part.function?.name) entry.call.function.name = part.function.name;
      if (part.function?.arguments) entry.call.function.arguments += part.function.arguments;
    }
  });
  finishText();
  for (const { call, outputIndex } of calls.values()) {
    const item = outputItemForCall(call, customTools);
    output[outputIndex] = item;
    sse(res, 'response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress' } });
    sse(res, 'response.output_item.done', { output_index: outputIndex, item });
  }
  sse(res, 'response.completed', { response: responseEnvelope(responseId, model, 'completed', output.filter(Boolean), usage) });
  res.end();
}

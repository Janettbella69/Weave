// A scripted Anthropic-format endpoint for tests: no real model, no key, no cost.
// Adapted from scripts/agent-sdk-probe/probe.mjs (which stays standalone); product tests share this copy.
import http from 'node:http';

export const isMain = body => Array.isArray(body?.tools) && body.tools.some(t => t.name === 'Bash' || t.name === 'Read');
const assistants = body => (body.messages || []).filter(m => m.role === 'assistant').length;

export function lastToolResults(body) {
  const last = (body.messages || []).at(-1);
  if (!Array.isArray(last?.content)) return [];
  return last.content.filter(x => x.type === 'tool_result')
    .map(x => typeof x.content === 'string' ? x.content : (x.content || []).map(y => y.text || '').join(''));
}

// Picks the reply by how many assistant turns the main agent has had so far.
export const steps = list => body => {
  if (!isMain(body)) return {text: 't'};
  const step = list[assistants(body)] || {text: 'end'};
  return typeof step === 'function' ? step(body) : step;
};

function stream(res, blocks, usage, model, id) {
  const stop = blocks.some(b => b.tool) ? 'tool_use' : 'end_turn';
  res.writeHead(200, {'Content-Type': 'text/event-stream'});
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({type: event, ...data})}\n\n`);
  send('message_start', {message: {id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: usage.input, output_tokens: 1}}});
  blocks.forEach((b, index) => {
    if (b.tool) {
      send('content_block_start', {index, content_block: {type: 'tool_use', id: 'toolu_' + Math.random().toString(36).slice(2, 14), name: b.tool, input: {}}});
      send('content_block_delta', {index, delta: {type: 'input_json_delta', partial_json: JSON.stringify(b.input || {})}});
    } else {
      send('content_block_start', {index, content_block: {type: 'text', text: ''}});
      send('content_block_delta', {index, delta: {type: 'text_delta', text: b.text}});
    }
    send('content_block_stop', {index});
  });
  send('message_delta', {delta: {stop_reason: stop, stop_sequence: null}, usage: {output_tokens: usage.output}});
  send('message_stop', {});
  res.end();
}

export async function startFakeModel() {
  let route = () => ({text: 'ok'}), usage = {input: 50, output: 10};
  const captured = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    captured.push({path: req.url, headers: req.headers, body, bytes: raw.length});
    if (req.url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end('{"input_tokens":100}');
    }
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); return res.end('{}'); }
    const blocks = route(body) ?? {text: 'ok'};
    stream(res, Array.isArray(blocks) ? blocks : [blocks], usage, body.model, 'msg_' + captured.length);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    captured,
    script(next, nextUsage) { route = next; if (nextUsage) usage = nextUsage; },
    close() { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}

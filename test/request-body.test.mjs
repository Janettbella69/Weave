import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withBufferedBody} from '../hosted/lib/weave/request-body.mjs';

test('没有请求体（GET）就原样交出去', async () => {
  const request = new Request('http://127.0.0.1:4317/api/status');
  assert.equal(await withBufferedBody(request), request);
});

test('有请求体就先整个读完：原请求的流读空了，新请求带着同样的方法、地址、请求头和内容', async () => {
  const request = new Request('http://127.0.0.1:4317/api/internal/x', {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: 'Basic abc'},
    body: '{"a":1}',
  });
  const buffered = await withBufferedBody(request);
  assert.equal(request.bodyUsed, true);
  assert.equal(buffered.method, 'POST');
  assert.equal(buffered.url, request.url);
  assert.equal(buffered.headers.get('authorization'), 'Basic abc');
  assert.equal(buffered.headers.get('content-type'), 'application/json');
  assert.equal(await buffered.text(), '{"a":1}');
});

test('流式请求体在交出去之前一直读到结尾', async () => {
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls > 3) controller.close();
      else controller.enqueue(new TextEncoder().encode('x'));
    },
  });
  const request = new Request('http://127.0.0.1:4317/', {method: 'POST', body: stream, duplex: 'half'});
  const buffered = await withBufferedBody(request);
  assert.equal(pulls, 4, '读到流结束才返回');
  assert.equal(await buffered.text(), 'xxx');
});

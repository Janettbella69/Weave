import {test} from 'node:test';
import assert from 'node:assert/strict';
import {basicAuthGate} from '../hosted/lib/weave/basic-auth.mjs';

const SETTING = 'isabella:p@ss:word with spaces';
const basic = credentials => 'Basic ' + Buffer.from(credentials).toString('base64');
const at = (path, headers = {}) => new Request('http://127.0.0.1:4317' + path, {headers});

test('没设密码就不拦', async () => {
  assert.equal(await basicAuthGate(at('/'), ''), null);
  assert.equal(await basicAuthGate(at('/api/status'), undefined), null);
});

test('内部接口不拦：它们有自己的令牌（Agent 服务、微信桥接、后台判断）', async () => {
  for (const path of ['/api/internal/agent/tools/log_completion', '/api/internal/wechat/tick', '/api/internal/hermes/claim']) {
    assert.equal(await basicAuthGate(at(path), SETTING), null, path);
  }
});

test('没带、带错、格式不对都是 401，并让浏览器弹出登录框', async () => {
  for (const authorization of [undefined, basic('isabella:wrong'), basic('someone:p@ss:word with spaces'), 'Bearer abc', 'Basic %%%']) {
    const r = await basicAuthGate(at('/api/status', authorization ? {authorization} : {}), SETTING);
    assert.ok(r, String(authorization));
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), 'Basic realm="Weave", charset="UTF-8"');
  }
});

test('带对就放行，密码里有冒号和空格也能对上', async () => {
  assert.equal(await basicAuthGate(at('/', {authorization: basic(SETTING)}), SETTING), null);
  assert.equal(await basicAuthGate(at('/api/chat', {authorization: basic(SETTING)}), SETTING), null);
});

test('看起来像内部接口但不是的路径照样要密码', async () => {
  for (const path of ['/api/internalx', '/api/Internal/agent/tools/x', '/internal/agent']) {
    const r = await basicAuthGate(at(path), SETTING);
    assert.equal(r?.status, 401, path);
  }
});

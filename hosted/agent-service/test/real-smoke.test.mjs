import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startFakeModel, steps} from './helpers/fake-model.mjs';

const SCRIPT = fileURLToPath(new URL('../../../scripts/agent-sdk-probe/real-smoke.mjs', import.meta.url));

function runScript(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT], {env: {...process.env, ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({code, out, err}));
  });
}

test('冒烟脚本对假接口全部 PASS', {timeout: 120000}, async () => {
  const fake = await startFakeModel();
  fake.script(steps([
    {tool: 'mcp__weave__log_completion', input: {habit_id: 'walk', date: '2026-11-01'}},
    {tool: 'Skill', input: {skill: 'weave:weekly-review'}},
    body => {
      const stats = JSON.stringify(body.messages).match(/python3 ([^\s\\"]+stats\.py)/)?.[1] || 'missing-stats.py';
      return {tool: 'Bash', input: {command: `python3 ${stats}`, description: 'stats'}};
    },
    {tool: 'Bash', input: {command: 'python3 -c "print(6*7)"', description: 'calc'}},
    {text: '完成'},
  ]));
  try {
    const r = await runScript({SMOKE_BASE_URL: fake.baseUrl, DEEPSEEK_API_KEY: 'fake-key-123456', AGENT_PROVIDER_API_KEY: ''});
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.out.match(/^PASS/gm)?.length, 4, r.out);
    const modelCalls = fake.captured.filter(c => c.path.startsWith('/v1/messages'));
    assert.ok(modelCalls.length > 0, 'the script never reached the model endpoint');
    assert.ok(modelCalls.every(c => c.headers.authorization === 'Bearer fake-key-123456'), JSON.stringify(modelCalls.map(c => c.headers.authorization)));
  } finally {
    await fake.close();
  }
});

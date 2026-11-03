// Contract tests for the product's wake() configuration: the probe's checks
// (scripts/agent-sdk-probe/probe.mjs), rerun against runner.mjs instead of hand-built options.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {platform} from 'node:os';
import {createHarness, message, REAL_KEY, PLUGIN_DIR} from './helpers/harness.mjs';
import {isMain, lastToolResults, steps} from './helpers/fake-model.mjs';
import {scopeFor} from '../scopes.mjs';
import {wake} from '../runner.mjs';
import {isolationFor} from '../sandbox.mjs';
import {providerFor} from '../providers.mjs';

let h;
before(async () => { h = await createHarness(); });
after(async () => { await h.close(); });

const mainCalls = () => h.fake.captured.filter(c => c.path.startsWith('/v1/messages') && !c.path.includes('count_tokens') && isMain(c.body));
const allToolResults = () => mainCalls().flatMap(c => lastToolResults(c.body));
function fresh(route, usage) { h.fake.captured.length = 0; h.fake.script(route, usage); }
const recorder = (reply = {ok: true, text: 'ok'}) => {
  const calls = [];
  const rpc = async (name, args, toolUseId) => { calls.push({name, args, toolUseId, pid: process.pid}); return typeof reply === 'function' ? reply(name, args) : reply; };
  return {calls, rpc};
};

test('一轮请求只带 owner 范围的内置工具和 weave 工具，Skill 只有 weave:weekly-review 和 weave:proactive-judgment', async () => {
  fresh(steps([{text: '你好呀'}]));
  const r = await h.wakeOnce();
  assert.equal(r.outcome, 'success');
  const body = mainCalls()[0].body, names = body.tools.map(t => t.name);
  assert.deepEqual(names.filter(n => !n.startsWith('mcp__')).sort(), ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Skill', 'WebSearch', 'Write']);
  assert.deepEqual(names.filter(n => n.startsWith('mcp__')).sort(), [
    'mcp__weave__cancel_schedule', 'mcp__weave__log_completion', 'mcp__weave__save_goal', 'mcp__weave__save_habit',
    'mcp__weave__schedule_wake', 'mcp__weave__send_message', 'mcp__weave__set_proactivity', 'mcp__weave__set_reminder',
  ]);
  const all = JSON.stringify(body);
  assert.ok(all.includes('weave:weekly-review') && all.includes('复盘一周的习惯完成情况时使用'));
  assert.ok(all.includes('weave:proactive-judgment') && all.includes('被定时或事件叫醒，要决定现在值不值得开口时使用'));
  assert.ok(!all.includes('dataviz') && !all.includes('code-review'), 'a bundled coding skill leaked in');
});

const check = (text, at = '2026-11-02T19:30:00+08:00') => ({kind: 'check', channel: 'system', direct: false, at, text});

test('后台那一轮能加载 weave:proactive-judgment，正文回到模型；不调 send_message 就没有 reply', async () => {
  fresh(steps([{tool: 'Skill', input: {skill: 'weave:proactive-judgment'}}, {text: '看过了，今天先不说'}]));
  const r = await h.wakeOnce({trigger: check('定期看看')});
  assert.equal(r.outcome, 'success');
  assert.equal(r.reply, '');
  const seen = JSON.stringify(mainCalls().at(-1).body.messages);
  assert.ok(seen.includes('大多数时候不开口是对的') && seen.includes('schedule_wake'), seen.slice(0, 400));
});

test('forkSession 只和 resume 一起设：有 sessionId 才分叉，没要分叉就没有这个键', async () => {
  const seen = [];
  const queryFn = async function* (call) {
    seen.push(call.options);
    yield {type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'fork-1', total_cost_usd: 0};
  };
  const scope = scopeFor('owner');
  const isolation = isolationFor({mode: 'local', scope, dirs: h.tenant(), pluginDir: PLUGIN_DIR, proxy: {url: h.proxyUrl}, sandbox: false});
  const run = extra => wake({scope, trigger: check('定期看看'), provider: providerFor('deepseek'), model: 'deepseek-flash', runToken: 'run-token', isolation, rpc: async () => ({ok: true, text: 'ok'}), queryFn, ...extra});
  assert.equal((await run({sessionId: 's-1', forkSession: true})).sessionId, 'fork-1', '返回的是结果消息里的 session_id，也就是分叉出来的那段');
  await run({sessionId: 's-1'});
  await run({forkSession: true});
  await run({});
  assert.deepEqual(seen.map(o => [o.resume, o.forkSession, 'forkSession' in o]), [
    ['s-1', true, true], ['s-1', undefined, false], [undefined, undefined, false], [undefined, undefined, false],
  ]);
});

test('分叉（实测）：新会话带着原来的历史、id 不一样；原会话不动，接着它的下一轮看不到后台那一轮', async () => {
  const dirs = h.tenant();
  fresh(steps([{text: '好，18:00 去走路'}, {text: '看过了'}, {text: '走了就好'}]));
  const chat = await h.wakeOnce({dirs, trigger: message('我 18:00 去走路')});
  const background = await h.wakeOnce({dirs, sessionId: chat.sessionId, forkSession: true, trigger: check('看看走路记了没有')});
  assert.equal(chat.outcome, 'success');
  assert.equal(background.outcome, 'success');
  assert.ok(chat.sessionId && background.sessionId && background.sessionId !== chat.sessionId, `${chat.sessionId} / ${background.sessionId}`);
  assert.ok(JSON.stringify(mainCalls().at(-1).body.messages).includes('我 18:00 去走路'), '分叉出来的会话带着原来的历史');

  const original = await h.wakeOnce({dirs, sessionId: chat.sessionId, trigger: message('我刚才说了什么')});
  const toOriginal = JSON.stringify(mainCalls().at(-1).body.messages);
  assert.equal(original.sessionId, chat.sessionId);
  assert.ok(toOriginal.includes('我 18:00 去走路') && !toOriginal.includes('看看走路记了没有'), '原会话里不该有后台那一轮');

  const fork = await h.wakeOnce({dirs, sessionId: background.sessionId, trigger: message('走了')});
  const toFork = JSON.stringify(mainCalls().at(-1).body.messages);
  assert.equal(fork.sessionId, background.sessionId);
  assert.ok(toFork.includes('我 18:00 去走路') && toFork.includes('看看走路记了没有'), '接着分叉出来的那段，两轮都看得到');
});

test('系统提示是自定义的：没有 You are Claude Code；SDK 前缀之后是 Weave 那句，记忆在里面，trigger 在用户消息里', async () => {
  fresh(steps([{text: 'hi'}]));
  await h.wakeOnce({memory: '周末早上更容易走路'});
  const body = mainCalls()[0].body;
  const system = (Array.isArray(body.system) ? body.system.map(b => b.text) : [body.system]).join('\n');
  assert.doesNotMatch(system, /You are Claude Code/);
  const prefix = system.indexOf('You are a Claude agent'), weave = system.indexOf('你是 Weave，帮一个人把习惯长期坚持下去的助理。');
  assert.ok(prefix >= 0 && weave > prefix, `prefix ${prefix}, weave ${weave}`);
  assert.ok(system.includes('<memory file="MEMORY.md">\n周末早上更容易走路\n</memory>'));
  assert.ok(JSON.stringify(body.messages).includes('<trigger kind=\\"message\\" channel=\\"web\\" direct=\\"true\\"'));
});

test('weave 工具在 Agent 服务进程里执行，拿到 toolUseId，失败文字回到模型', async () => {
  const {calls, rpc} = recorder({ok: false, text: '对方还没授权共享时间，请先让对方确认'});
  fresh(steps([{tool: 'mcp__weave__log_completion', input: {habit_id: 'h1', date: '2026-11-01'}}, {text: 'done'}]));
  const r = await h.wakeOnce({rpc});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'log_completion');
  assert.deepEqual(calls[0].args, {habit_id: 'h1', date: '2026-11-01'});
  assert.match(calls[0].toolUseId, /^toolu_/);
  assert.equal(calls[0].pid, process.pid);
  assert.ok(allToolResults().some(x => x.includes('对方还没授权共享时间')));
  assert.ok(r.tools.includes('mcp__weave__log_completion'));
});

test('group 范围调 log_completion、WebSearch 都得到 No such tool，rpc 没被调用', async () => {
  const {calls, rpc} = recorder();
  fresh(steps([{tool: 'mcp__weave__log_completion', input: {habit_id: 'h1', date: '2026-11-01'}}, {tool: 'WebSearch', input: {query: 'x'}}, {text: 'done'}]));
  await h.wakeOnce({scope: scopeFor('group'), rpc, trigger: {kind: 'message', channel: 'group', direct: true, at: '2026-11-02T08:00:00+08:00', text: '@Weave 记一下'}});
  const results = allToolResults();
  assert.ok(results.some(x => x.includes('No such tool available: mcp__weave__log_completion')), results.join(' | '));
  assert.ok(results.some(x => x.includes('No such tool available: WebSearch')), results.join(' | '));
  assert.equal(calls.length, 0);
});

test('有人直接找的那一轮，最后一段话是 reply；direct=false 时 reply 为空', async () => {
  fresh(steps([{text: '记好了'}]));
  assert.equal((await h.wakeOnce({trigger: message('今天走了 20 分钟')})).reply, '记好了');
  fresh(steps([{text: '内部结论，不调用 send_message 就没人看到'}]));
  const quiet = await h.wakeOnce({trigger: {kind: 'check', channel: 'system', direct: false, at: '2026-11-02T08:00:00+08:00', text: '定期检查'}});
  assert.equal(quiet.outcome, 'success');
  assert.equal(quiet.reply, '');
});

test('Skill 加载后能用 Bash 跑 stats.py，数字来自脚本', async () => {
  const dirs = h.tenant();
  let stats = '';
  fresh(steps([
    {tool: 'Write', input: {file_path: join(dirs.workspace, 'week.json'), content: JSON.stringify({today: '2026-11-02', completions: [{habit_id: 'walk', date: '2026-11-02'}, {habit_id: 'walk', date: '2026-11-01'}]})}},
    {tool: 'Skill', input: {skill: 'weave:weekly-review'}},
    b => { stats = JSON.stringify(b.messages).match(/python3 ([^\s\\"]+stats\.py)/)?.[1] || ''; return {tool: 'Bash', input: {command: `python3 ${stats} week.json`, description: 'stats'}}; },
    {text: '这周走了两次'},
  ]));
  const r = await h.wakeOnce({dirs});
  assert.ok(stats.startsWith(PLUGIN_DIR), stats);
  assert.ok(allToolResults().some(x => x.includes('"walk": {"last7": 2, "prev7": 0, "streak": 2}')), allToolResults().join(' | '));
  assert.equal(r.reply, '这周走了两次');
});

test('Agent 用 Bash 写的 .claude/settings.json Hook，下一轮不执行', async () => {
  const dirs = h.tenant(), marker = join(h.root, 'hook-ran.txt');
  const settings = JSON.stringify({hooks: {PreToolUse: [{matcher: 'Bash', hooks: [{type: 'command', command: `touch ${marker}`}]}]}});
  fresh(steps([{tool: 'Bash', input: {command: `mkdir -p .claude && cat > .claude/settings.json <<'E'\n${settings}\nE`, description: 'x'}}, {text: 'ok'}]));
  await h.wakeOnce({dirs});
  assert.ok(existsSync(join(dirs.workspace, '.claude/settings.json')), 'setup: the hook file should exist');
  fresh(steps([{tool: 'Bash', input: {command: 'echo next', description: 'x'}}, {text: 'ok'}]));
  await h.wakeOnce({dirs});
  assert.ok(!existsSync(marker));
});

test('不设轮数上限：传给 query() 的 options 里没有 maxTurns', async () => {
  let options = null;
  const queryFn = async function* (call) {
    options = call.options;
    yield {type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', total_cost_usd: 0};
  };
  const scope = scopeFor('owner');
  const isolation = isolationFor({mode: 'local', scope, dirs: h.tenant(), pluginDir: PLUGIN_DIR, proxy: {url: h.proxyUrl}, sandbox: false});
  const r = await wake({scope, trigger: message('你好'), provider: providerFor('deepseek'), model: 'deepseek-flash', runToken: 'run-token', isolation, rpc: async () => ({ok: true, text: 'ok'}), queryFn});
  assert.equal(r.outcome, 'success');
  assert.ok(options, 'query() was never called');
  assert.ok(!('maxTurns' in options), `maxTurns is in options: ${options.maxTurns}`);
  assert.equal(options.maxBudgetUsd, scopeFor('owner').circuitBreakerUsd);
});

test('连续 25 次工具调用也能跑完（以前到 20 轮就停）', {timeout: 120000}, async () => {
  const calls = Array.from({length: 25}, (_, i) => ({tool: 'Bash', input: {command: `echo ${i + 1}`, description: 'x'}}));
  fresh(steps([...calls, {text: '25 次都做完了'}]));
  const r = await h.wakeOnce();
  assert.equal(r.outcome, 'success');
  assert.equal(r.reply, '25 次都做完了');
  assert.equal(mainCalls().length, 26, 'the model should be asked 25 times for a tool call and once more for the reply');
});

test('熔断到了是 error_max_budget_usd，不重试', async () => {
  const loop = b => isMain(b) ? {tool: 'Bash', input: {command: 'echo 1', description: 'x'}} : {text: 't'};
  fresh(loop, {input: 800000, output: 100000});
  const budget = await h.wakeOnce({scope: {...scopeFor('owner'), circuitBreakerUsd: 0.01}});
  assert.equal(budget.outcome, 'error_max_budget_usd');
  assert.equal(budget.reply, '');
  assert.equal(mainCalls().length, 1);
});

test('传入上一轮的 sessionId，能接上上一轮的对话', async () => {
  const dirs = h.tenant();
  fresh(steps([{text: '记住了'}, {text: '你走了路'}]));
  const a = await h.wakeOnce({dirs, trigger: message('我今天走了路')});
  const b = await h.wakeOnce({dirs, sessionId: a.sessionId, trigger: message('我今天做了什么')});
  assert.ok(a.sessionId);
  assert.equal(b.sessionId, a.sessionId);
  assert.equal(b.reply, '你走了路');
  assert.ok(JSON.stringify(mainCalls().at(-1).body.messages).includes('我今天走了路'));
});

test('Bash 读不到 Agent 服务进程里的真 Key，只看到这一轮的运行令牌；Write 写不到工作目录外', async t => {
  const saved = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = REAL_KEY;
  t.after(() => { if (saved === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved; });
  const dirs = h.tenant(), outside = join(h.root, 'outside.txt');
  fresh(steps([
    {tool: 'Bash', input: {command: 'env', description: 'env'}},
    {tool: 'Write', input: {file_path: outside, content: 'escaped'}},
    {tool: 'Write', input: {file_path: join(dirs.workspace, 'inside.txt'), content: 'ok'}},
    {text: 'done'},
  ]));
  const r = await h.wakeOnce({dirs});
  const envDump = allToolResults()[0] || '';
  assert.ok(envDump.includes('ANTHROPIC_AUTH_TOKEN=' + r.runToken), 'the CLI env should carry the run token');
  assert.ok(!allToolResults().join('\n').includes(REAL_KEY), 'the real key leaked into a tool result');
  assert.ok(!existsSync(outside), 'Write escaped the workspace');
  assert.equal(readFileSync(join(dirs.workspace, 'inside.txt'), 'utf8'), 'ok');
  const upstream = h.fake.captured.filter(c => c.path.startsWith('/v1/messages'));
  assert.ok(upstream.length > 0 && upstream.every(c => c.headers.authorization === 'Bearer ' + REAL_KEY));
  assert.ok(upstream.every(c => !JSON.stringify(c.headers).includes(r.runToken)));
});

test('额度用完时一轮在 20 秒内结束，outcome 是 error，上游一次没被请求', async t => {
  const tight = await createHarness({limits: {perAccount: 0, total: 1e9}});
  t.after(tight.close);
  tight.fake.script(steps([{text: 'should not be reached'}]));
  const started = Date.now();
  const r = await tight.wakeOnce();
  assert.ok(Date.now() - started < 20000, `took ${Date.now() - started} ms`);
  assert.equal(r.outcome, 'error');
  assert.equal(r.reply, '');
  assert.equal(tight.fake.captured.filter(c => c.path.startsWith('/v1/messages')).length, 0);
});

test('本机 sandbox：Bash 连不了网', {skip: platform() !== 'darwin' && process.env.WEAVE_TEST_SANDBOX !== '1'}, async () => {
  fresh(steps([{tool: 'Bash', input: {command: `curl -sS -m 4 ${h.fake.baseUrl}/x -o /dev/null; echo EXIT=$?`, description: 'net'}}, {text: 'end'}]));
  await h.wakeOnce({sandbox: true});
  const net = allToolResults()[0] || '';
  assert.match(net, /EXIT=[1-9]/, net);
});


test('上游拒绝这把 Key（401）时一轮很快结束，不让 CLI 反复重试', {timeout: 240000}, async () => {
  fresh(() => ({status: 401, type: 'authentication_error'}));
  const started = Date.now();
  const r = await h.wakeOnce();
  const seconds = (Date.now() - started) / 1000;
  const attempts = h.fake.captured.filter(c => c.path.startsWith('/v1/messages') && !c.path.includes('count_tokens')).length;
  assert.equal(r.outcome, 'error');
  assert.ok(seconds < 20, `took ${seconds}s, upstream was asked ${attempts} times`);
  assert.ok(attempts <= 2, `upstream was asked ${attempts} times`);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scopeFor} from '../scopes.mjs';
import {providerFor, modelAllowed, cliEnv, canonicalModel, canSeeImages} from '../providers.mjs';
import {SAFETY_RULES, systemPromptFor, renderMessage, userMessage, IMAGE_NOTE, reminderAlarmText, WECHAT_CONNECTED_TEXT} from '../prompts.mjs';

test('owner 范围：两个工具（说话、定闹钟），记录直接用 sqlite3；有私人资料，所以没有 WebFetch 和 Agent，网络是 none；不设轮数上限和预算', () => {
  const s = scopeFor('owner');
  assert.deepEqual([...s.tools], ['send_message', 'schedule']);
  for (const t of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'WebSearch']) assert.ok(s.builtins.includes(t), t);
  for (const t of ['WebFetch', 'Agent']) { assert.ok(!s.builtins.includes(t), t); assert.ok(s.denied.includes(t), t); }
  assert.equal(s.network, 'none');
  assert.deepEqual([...s.skills], ['weave:weekly-review']);
  assert.equal('maxTurns' in s, false, '不设轮数上限（教材 p.22、p.26）');
  assert.equal('circuitBreakerUsd' in s, false, '常驻会话没有「一轮」的预算；费用上限在模型代理里');
});

test('group 范围：群消息谁都能写，所以没有 WebSearch、WebFetch、Agent；能说话、能定闹钟（她 11-16：群里也要能定闹钟）', () => {
  const s = scopeFor('group');
  assert.deepEqual([...s.tools], ['send_message', 'schedule']);
  for (const t of ['WebSearch', 'WebFetch', 'Agent']) { assert.ok(!s.builtins.includes(t), t); assert.ok(s.denied.includes(t), t); }
  assert.equal(s.network, 'none');
  assert.deepEqual([...s.skills], []);
});

test('不认识的范围和提供方直接报错，原型上的名字也骗不过去；范围表不能被改掉', () => {
  for (const name of ['research', '__proto__', 'constructor', '']) assert.throws(() => scopeFor(name), name);
  for (const name of ['openai', '__proto__', 'toString']) assert.throws(() => providerFor(name), name);
  assert.throws(() => { scopeFor('owner').builtins.push('WebFetch'); });
});

test('四家模型地址都是 Anthropic 格式（https，末尾不带 /v1），主模型和快模型都认', () => {
  assert.equal(providerFor('deepseek').baseUrl, 'https://api.deepseek.com/anthropic');
  for (const name of ['deepseek', 'kimi', 'glm', 'qwen']) {
    const p = providerFor(name);
    assert.match(p.baseUrl, /^https:\/\/.*anthropic/, name);
    assert.doesNotMatch(p.baseUrl, /\/v1\/?$/, name);
    assert.ok(modelAllowed(p, p.main) && modelAllowed(p, p.fast), name);
  }
});

test('deepseek 照官方「接入 Claude Code」文档：主模型 deepseek-flash[1m]，快模型和子 Agent 用 deepseek-flash，自动压缩窗口 786432；记忆用 SDK 自带的', () => {
  const env = cliEnv({provider: providerFor('deepseek'), model: 'deepseek-flash', runToken: 'run-1', baseUrl: 'http://127.0.0.1:4321', home: '/home/agent', configDir: '/home/agent/.claude', path: '/usr/bin'});
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/home/agent',
    CLAUDE_CONFIG_DIR: '/home/agent/.claude',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:4321',
    ANTHROPIC_AUTH_TOKEN: 'run-1',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: 'deepseek-flash[1m]',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  });
  assert.equal(canonicalModel(providerFor('deepseek'), 'deepseek-flash'), 'deepseek-flash[1m]');
  assert.equal(canSeeImages(providerFor('deepseek'), 'deepseek-flash[1m]'), true);
  assert.equal(canSeeImages(providerFor('deepseek'), 'deepseek-v4-pro'), false);
});

test('cliEnv 拒绝表外模型；modelAllowed 带不带 [1m] 都放行', () => {
  assert.throws(() => cliEnv({provider: providerFor('deepseek'), model: 'claude-opus-4', runToken: 'r', baseUrl: 'http://x', home: '/h', configDir: '/c', path: '/p'}));
  const kimi = providerFor('kimi');
  for (const m of ['kimi-k3', 'kimi-k3[1m]', 'kimi-k2.7-code']) assert.equal(modelAllowed(kimi, m), true, m);
  assert.equal(modelAllowed(kimi, 'claude-opus-4'), false);
  assert.equal(modelAllowed(providerFor('deepseek'), undefined), false);
});

test('系统提示：开头是她确认过的 Weave 那句；健康安全是 SAFETY_RULES 原文、只出现一次；记忆不拼进来（SDK 自己读）', () => {
  const p = systemPromptFor(scopeFor('owner'));
  assert.ok(p.startsWith('你是 Weave，对方的个人助理。你和对方一起朝着对方自己定的目标走，一路上用你自己的判断。'), p.slice(0, 80));
  assert.ok(p.includes('\n- ' + SAFETY_RULES));
  assert.equal(p.split('健康安全').length - 1, 1);
  assert.ok(!p.includes('<memory') && !p.includes('<handoff') && !p.includes('HANDOFF'));
  assert.ok(!p.includes('weave/weave.db') && !p.includes('快照'));
  assert.ok(!p.includes('打卡群'));
});

test('系统提示讲清新架构：一直在线、只有 send_message 发得出去、schedule 定闹钟、records.db 直接用 sqlite3；不提已删的工具', () => {
  const p = systemPromptFor(scopeFor('owner'));
  for (const words of ['你一直在线', 'send_message', 'schedule', 'records.db', 'sqlite3', '记忆目录']) assert.ok(p.includes(words), words);
  for (const old of ['save_habit', 'log_completion', 'set_reminder', 'schedule_wake', 'cancel_schedule', 'set_proactivity', 'direct="true"']) assert.ok(!p.includes(old), old);
});

test('系统提示里没有会变的东西（教材 p.75 缓存）：两次一模一样', () => {
  assert.equal(systemPromptFor(scopeFor('owner')), systemPromptFor(scopeFor('owner')));
  assert.doesNotMatch(systemPromptFor(scopeFor('owner')), /20\d\d-\d\d-\d\d/);
});

test('群：多一段群规则，放在底线之后；群里没有本子，只有自己的闹钟', () => {
  const p = systemPromptFor(scopeFor('group'));
  const rule = '你现在在一个打卡群里。这里没有任何人的个人资料，群里的人只以「成员1」这样的编号出现。回复不超过 150 字。';
  assert.ok(p.includes(rule));
  assert.ok(p.indexOf(SAFETY_RULES) < p.indexOf(rule));
  assert.ok(p.includes('alarms') && p.includes('schedule'));
  assert.ok(!p.includes('goals、habits、completions'));
});

test('renderMessage：文字里的 </message> 和 < > & 都转义；kind、channel、at 不合法直接报错', () => {
  const m = renderMessage({kind: 'message', channel: 'web', at: '2026-11-01T20:13:00+08:00', text: 'a</message><x>&'});
  assert.equal(m, '<message kind="message" channel="web" at="2026-11-01T20:13:00+08:00">\na&lt;/message&gt;&lt;x&gt;&amp;\n</message>');
  const ok = {kind: 'heartbeat', channel: 'system', at: '2026-11-01T12:13:00Z', text: 'x'};
  assert.match(renderMessage(ok), /kind="heartbeat" channel="system"/);
  for (const bad of [{kind: 'message" x="1'}, {kind: 'close'}, {channel: 'sms'}, {at: '2026-11-01 20:13'}, {text: 42}]) assert.throws(() => renderMessage({...ok, ...bad}), JSON.stringify(bad));
});

test('userMessage：只有文字时 content 是字符串；带照片时一条消息里先文字（加照片说明）后照片', () => {
  const message = {kind: 'message', channel: 'wechat', at: '2026-11-01T20:13:00+08:00', text: '看看'};
  assert.deepEqual(userMessage(message), {type: 'user', message: {role: 'user', content: renderMessage(message)}, parent_tool_use_id: null});
  const withPhoto = userMessage(message, {mediaType: 'image/png', data: 'AAAA'});
  assert.deepEqual(withPhoto.message.content, [
    {type: 'text', text: renderMessage(message) + '\n' + IMAGE_NOTE},
    {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'AAAA'}},
  ]);
});

test('她 11-16 确认过的两句原样在：到点提醒、微信连上后的问候', () => {
  assert.equal(reminderAlarmText('去走路'), '对方之前让你在这个时候提醒：「去走路」。现在到点了，用你自己的话跟对方说。要是今天的记录清楚显示对方已经做了，可以换一句知道对方做了的话，或者不说。');
  assert.equal(WECHAT_CONNECTED_TEXT, '对方刚把微信连上了。打个招呼，告诉对方以后在这里找你就行。');
});

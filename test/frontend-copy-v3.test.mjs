import {test} from 'node:test';
import assert from 'node:assert/strict';
import {COPY} from '../hosted/app/workspace/copy.mjs';
import {WECHAT_TEXT,COPY_BIND,BIND_HINT,NEW_CODE,NEW_CODE_NOTE,UNBIND_CONFIRM,bindMessage} from '../hosted/app/workspace/wechat-row.mjs';
import {isValidTimezone} from '../hosted/app/workspace/timezone.mjs';
import {NAV} from '../hosted/app/workspace/view-route.mjs';

// The wording on the v3 pages, as the v3 boards and the spec (docs/superpowers/specs/2026-11-03-frontend-v3-design.md,
// section 3 and Appendix A-4) have it. This list is a pin: changing a sentence in copy.mjs means changing it here too,
// so a reworded or invented sentence shows up in review. The plain strings first, then what the functions return.
const TEXT = {
  // navigation and page titles
  brand: 'Weave', mainNav: '主导航', chat: '聊天', todo: '待办', goals: '目标', records: '记录', settings: '设置', agentHome: '助理主页', backToChat: '返回聊天', connected: '已连接',
  openAgent: '打开 Weave 的助理主页',
  // chat
  send: '发送', placeholder: '给 Weave 发消息…', deepseek: '聊天内容会发给 DeepSeek 生成回复。', today: '今天', yesterday: '昨天', thinking: '正在想…',
  conversation: '和 Weave 的对话', messageLabel: '发消息给 Weave',
  // to-do
  todayLabel: '今天', later: '之后', missedYesterday: '昨天没做，今天做一下就不算连着错过。', addHint: '想加别的事？', addLink: '在聊天里跟 Weave 说一声',
  todoEmpty: '还没有每天要做的事。去「目标」定一个，或者在聊天里跟 Weave 说说你想养成什么。', checkFailed: '没记上，再点一次试试。', remindNote: '到时候 Weave 会提醒你',
  // goals
  tracking: '正在追踪', create: '创建一个目标', goalsEmpty: '还没有在追踪的目标。从下面选一类开始。', ungrouped: '还没归到目标的习惯', last7: '最近 7 天',
  goalPlaceholder: '比如：想睡得早一点', changeCategory: '换一个', goalLabel: '告诉 Weave 你的目标',
  // records
  recordsEmpty: '还没有记录。在待办里打勾，或者跟 Weave 说一声，这里就会有。', earliest: '更早的记录先看不了。', longest: '最长一次连续', doubleMiss: '连着错过两天',
  recent: '最近记下的', sourceWeb: '你在网页上记的', sourceAgent: 'Weave 帮你记的', done: '做到了', missed: '没做', notStarted: '还没开始',
  // settings
  connections: '连接', time: '时间', zoneLabel: '所在地时间', whenProactive: 'Weave 什么时候主动找你', goAgent: '去助理主页看', privacy: '数据与隐私',
  privacyText: '你的记录只在你的账号里，别人看不到。聊天内容会发给 DeepSeek 生成回复。', export: '导出我的数据', deleteAccount: '删除账号',
  // the assistant's home page
  remindersTab: '提醒', memoryTab: '记忆', notLive: '主动提醒还没开通。现在 Weave 只会在你交代的时间提醒你一次；开通以后，它会按下面的安排主动来找你。',
  once: '只响一次', daily: '每天', weekly: '每周', monthly: '每月', noneScheduled: '暂时没有安排。',
  memoryIntro: '这些是 Weave 自己记下的关于你的事。哪条不对，直接在聊天里跟它说。', memoryEmpty: 'Weave 还没有记下关于你的事。',
  // the first time the site is opened
  welcome: '你好，我是 Weave', firstRunIntro: '先选一件最想养成的小事。我们从小到不会失败的一步开始，慢慢来。', pickOne: '选一件想养成的事', firstRunGo: '就这样开始', firstRunChange: '想换个说法，就在下面跟我说。',
  ownHabit: '我想养成…', ownPlaceholder: '比如：每天拉伸 5 分钟', ownDone: '好了', sayIt: '也可以直接跟我说', sayItPlaceholder: '比如：我总是熬夜，想早点睡',
  // a page that did not load
  loadFailed: '没加载出来。', retry: '重试',
};

// [key, arguments, what it returns]. The sample values are the ones on the boards.
const CALLS = [
  ['proactive', ['19:30'], '19:30 · Weave 主动来问'],
  ['progress', [1, 2], '今天 1 / 2'],
  ['progress', [0, 0], '今天 0 / 0'],
  ['doneNote', [5], '记下了，这周第 5 天。'],
  ['checkLabel', ['饭后走 10 分钟'], '做到了：饭后走 10 分钟'],
  ['forGoal', ['每天动一动'], '为了「每天动一动」'],
  ['minimumStep', ['走到楼下'], '最小一步：走到楼下'],
  ['weekCount', [4], '这周 4 天'],
  ['everyDay', ['饭后走 10 分钟'], '每天：饭后走 10 分钟'],
  ['newGoal', ['健康'], '新目标 · 健康'],
  ['startedOn', ['健康', '10 月 12 日'], '健康 · 从 10 月 12 日开始'],
  ['latest', ['11 月 1 日', 'web', '饭后绕小区走了一圈，大概 12 分钟'], '最近：11 月 1 日，你在网页上记下「饭后绕小区走了一圈，大概 12 分钟」'],
  ['latest', ['10 月 31 日', 'agent', '睡前读了 5 页'], '最近：10 月 31 日，Weave 帮你记下「睡前读了 5 页」'],
  ['goalIntro', ['健康'], '好，聊聊「健康」。你想做到什么？说说现在的情况就行，我帮你拆成每天的一小步。'],
  ['goalStarter', ['健康', '想睡得早一点'], '我想定一个「健康」方面的目标：想睡得早一点'],
  ['monthDone', [10], '10 月做到'],
  ['firstRunPick', ['饭后走走'], '好，就从「饭后走走」开始。'],
  ['firstRunStep', ['吃完饭，穿上鞋走到楼下'], '第一步可以小到：吃完饭，穿上鞋走到楼下。'],
  ['firstRunStarter', ['饭后走走', '吃完饭，穿上鞋走到楼下'], '我想从「饭后走走」开始，第一步：吃完饭，穿上鞋走到楼下。'],
];

// What nobody should read on a page: test 1 of test/frontend-copy.test.mjs, plus the 「反馈：」 code word and the
// engine's name, which the spec (section 1, item 6) keeps off the screen.
const FORBIDDEN = ['YOUR LIFE, REMEMBERED', 'SMALL COMMITMENTS', 'NOTICE, ASK', 'CHANNELS', '<h2>Channels</h2>', 'Personal Agent', '>个人 Agent<', '>Agent 协作<', 'Agent 待测试', '反馈：', 'Hermes'];

// Every piece of text in COPY: the strings, the strings inside lists and objects, a function's source (which has its
// fixed words) and what it returns for some arguments.
function* texts(value, path) {
  if (typeof value === 'string') yield [path, value];
  else if (typeof value === 'function') { yield [path + ' (source)', String(value)]; yield [path + ' (result)', String(value('甲', '乙', '丙'))]; }
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) yield* texts(item, path + '.' + key);
}

test('COPY is frozen, lists and all', () => {
  assert.ok(Object.isFrozen(COPY));
  assert.throws(() => { COPY.chat = 'x'; }, TypeError);
  assert.throws(() => { COPY.extra = 'x'; }, TypeError);
  for (const list of [COPY.zones, COPY.firstRunOptions]) assert.ok(Object.isFrozen(list) && list.every(Object.isFrozen));
});

test('every plain sentence is the one on the board or in the spec, and there are no others', () => {
  const plain = Object.fromEntries(Object.entries(COPY).filter(([, value]) => typeof value === 'string'));
  assert.deepEqual(plain, TEXT);
});

test('what the functions return, with the boards\' own examples', () => {
  for (const [key, args, expected] of CALLS) assert.equal(COPY[key](...args), expected, key + '(' + args.join(', ') + ')');
  assert.deepEqual(Object.keys(COPY).filter(key => typeof COPY[key] === 'function').sort(), [...new Set(CALLS.map(([key]) => key))].sort(), 'a function without a pinned example');
});

test('the progress line and the first message of the first run, as the plan has them', () => {
  assert.equal(COPY.progress(1, 2), '今天 1 / 2');
  assert.equal(COPY.firstRunStarter('饭后走走', '吃完饭，穿上鞋走到楼下'), '我想从「饭后走走」开始，第一步：吃完饭，穿上鞋走到楼下。');
});

test('a note written by Weave and one written on the web are told apart; an old record without a source was Weave\'s', () => {
  assert.equal(COPY.latest('11 月 1 日', 'web', 'x'), '最近：11 月 1 日，你在网页上记下「x」');
  assert.equal(COPY.latest('11 月 1 日', 'agent', 'x'), '最近：11 月 1 日，Weave 帮你记下「x」');
  assert.equal(COPY.latest('11 月 1 日', undefined, 'x'), '最近：11 月 1 日，Weave 帮你记下「x」');
});

test('each tab is named as its page is', () => {
  // view-route.mjs and copy.mjs both write the five names; the tab and the page title must never drift apart.
  assert.equal(NAV.length, 5);
  for (const {id, label} of NAV) assert.equal(label, COPY[id], id);
});

test('the six zones, in order, are real time zones', () => {
  assert.deepEqual(COPY.zones, [
    {value: 'Asia/Shanghai', label: '北京时间'}, {value: 'America/Los_Angeles', label: '洛杉矶时间'}, {value: 'America/New_York', label: '纽约时间'},
    {value: 'Europe/London', label: '伦敦时间'}, {value: 'Asia/Tokyo', label: '东京时间'}, {value: 'Asia/Singapore', label: '新加坡时间'},
  ]);
  assert.ok(COPY.zones.every(zone => isValidTimezone(zone.value)));
});

test('the first run offers five small things; the fifth is the person\'s own', () => {
  assert.deepEqual(COPY.firstRunOptions, [
    {key: 'walk', label: '饭后走走', step: '吃完饭，穿上鞋走到楼下'},
    {key: 'sleep', label: '早点睡', step: '晚上 11 点把手机放到卧室外面'},
    {key: 'water', label: '多喝水', step: '起床先喝一杯水'},
    {key: 'read', label: '读几页书', step: '睡前读 1 页'},
    {key: 'own', label: '自己写一个', step: ''},
  ]);
});

test('the WeChat binding texts, and the one thing that is sent to bind', () => {
  assert.equal(COPY_BIND, '复制绑定消息');
  assert.equal(BIND_HINT, '把这句原样发给 Weave 的微信，多一个字都不算。');
  assert.equal(NEW_CODE, '换一个新码');
  assert.equal(NEW_CODE_NOTE, '换新码后，旧码就不能用了。');
  assert.equal(UNBIND_CONFIRM, '断开以后，Weave 就不能在微信里找你了；要再用，得重新绑定。确定断开吗？');
  assert.equal(bindMessage('ab12'), '绑定 ab12');
  assert.equal(bindMessage('K7Q2XM'), '绑定 K7Q2XM', 'the code goes in as it is, after one space');
  assert.deepEqual(Object.keys(WECHAT_TEXT).sort(), ['soon', 'soonNote'], 'the approved pair is untouched and alone in its object');
});

test('nothing on the pages is a code word, an old title or the engine\'s name', () => {
  const all = [...texts(COPY, 'COPY')];
  assert.ok(all.length > 80, 'the walk found the text');
  for (const [path, text] of all) {
    for (const word of FORBIDDEN) assert.ok(!text.includes(word), path + ' has ' + word);
    assert.ok(!/undefined|NaN|\[object|\{\{/.test(text), path + ' has a hole in it: ' + text);
  }
  for (const text of [COPY_BIND, BIND_HINT, NEW_CODE, NEW_CODE_NOTE, UNBIND_CONFIRM, bindMessage('x')]) for (const word of FORBIDDEN) assert.ok(!text.includes(word), text);
});

test('the approved WeChat sentences have one home: wechat-row.mjs, not here', () => {
  for (const [path, text] of texts(COPY, 'COPY')) for (const approved of Object.values(WECHAT_TEXT)) assert.ok(!text.includes(approved), path);
});

// The words on the v3 pages, in one place so each sentence can be read, confirmed and changed once.
//
// Every sentence comes from the v3 design boards or from the spec (docs/superpowers/specs/2026-11-03-frontend-v3-design.md,
// section 3 and Appendix A-4), written as it is there. A value is a string, or a function that puts the changing part
// (a count, a name, a date) into the sentence. Sentences marked 草稿文案 are the new ones the spec lists for the owner
// to confirm (A-4, and the one first message for a goal); after she has, they do not change. A few in settings, marked,
// are not on the boards: they come word for word from the settings page the v3 one replaces, with the flow they belong
// to (the Notion page picker, and the question before an account is deleted).
//
// The WeChat row has its own file, wechat-row.mjs, because it carries the wording the owner already approved.

// 「从 10 月 12 日开始」: when a goal (目标) or a habit (记录) began.
const since = date => '从 ' + date + '开始';

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(item => freeze(item)); Object.freeze(value); }
  return value;
};

export const COPY = freeze({
  // Navigation and page titles
  brand: 'Weave',
  mainNav: '主导航', // the navigation's accessible name (the boards' aria-label)
  chat: '聊天',
  todo: '待办',
  goals: '目标',
  records: '记录',
  settings: '设置',
  agentHome: '助理主页',
  backToChat: '返回聊天',
  connected: '已连接',
  openAgent: '打开 Weave 的助理主页', // the accessible name of the links to it: the chat header, the phone's top bar

  // Chat
  send: '发送', // the round send button's accessible name (the boards' aria-label)
  placeholder: '给 Weave 发消息…',
  deepseek: '聊天内容会发给 DeepSeek 生成回复。',
  today: '今天',
  yesterday: '昨天',
  proactive: time => time + ' · Weave 主动来问',
  thinking: '正在想…', // spec section 7
  conversation: '和 Weave 的对话', // the message list's accessible name (the boards' aria-label)
  messageLabel: '发消息给 Weave', // the chat box's label, read out but not shown (the boards' hidden label)

  // To-do (待办)
  todayLabel: '今天',
  later: '之后',
  progress: (done, total) => '今天 ' + done + ' / ' + total,
  // 草稿文案，待确认。(A-4: the board says 「昨天没走，今天走一下……」, which only fits walking)
  missedYesterday: '昨天没做，今天做一下就不算连着错过。',
  doneNote: n => '记下了，这周第 ' + n + ' 天。',
  // A tick box's accessible name (the boards' aria-label): 做到了：饭后走 10 分钟
  checkLabel: title => '做到了：' + title,
  // The two fixed parts of the line under a habit: 为了「目标名」 · 什么时候 · 最小一步：… (spec section 3.2, the boards)
  forGoal: title => '为了「' + title + '」',
  minimumStep: text => '最小一步：' + text,
  addHint: '想加别的事？',
  addLink: '在聊天里跟 Weave 说一声',
  // 草稿文案，待确认。(A-4)
  todoEmpty: '还没有每天要做的事。去「目标」定一个，或者在聊天里跟 Weave 说说你想养成什么。',
  // 草稿文案，待确认。(A-4)
  checkFailed: '没记上，再点一次试试。',
  // After the time of a reminder in 之后: 「明天 20:00 · 到时候 Weave 会提醒你」, as on the phone board (the wide board puts
  // 「你在聊天里说的，」 before it).
  remindNote: '到时候 Weave 会提醒你',

  // Goals (目标)
  tracking: '正在追踪',
  create: '创建一个目标',
  // 草稿文案，待确认。(A-4)
  goalsEmpty: '还没有在追踪的目标。从下面选一类开始。',
  // 草稿文案，待确认。(A-4)
  ungrouped: '还没归到目标的习惯',
  weekCount: n => '这周 ' + n + ' 天',
  // A habit on its goal's card (the boards): 每天：饭后走 10 分钟
  everyDay: name => '每天：' + name,
  last7: '最近 7 天',
  // The boards write 「从 10 月 12 日开始」, with no space before 开始.
  startedOn: (category, date) => category + ' · ' + since(date),
  // `date` is already written out ('11 月 1 日'). `source` is 'web' or 'agent'; a record with no source is from before the
  // web could record anything, so it was Weave's.
  latest: (date, source, note) => '最近：' + date + '，' + (source === 'web' ? '你在网页上记下' : 'Weave 帮你记下') + '「' + note + '」',
  goalIntro: category => '好，聊聊「' + category + '」。你想做到什么？说说现在的情况就行，我帮你拆成每天的一小步。',
  goalPlaceholder: '比如：想睡得早一点',
  // The little chat for a new goal (the boards): its title, 新目标 · 健康, and its box's label, read out but not shown
  newGoal: category => '新目标 · ' + category,
  goalLabel: '告诉 Weave 你的目标',
  // 草稿文案，待确认。New: the spec only says the category goes along with the person's words (section 3.3).
  goalStarter: (category, text) => '我想定一个「' + category + '」方面的目标：' + text,
  changeCategory: '换一个',

  // Records (记录)
  // 草稿文案，待确认。(A-4)
  recordsEmpty: '还没有记录。在待办里打勾，或者跟 Weave 说一声，这里就会有。',
  // 草稿文案，待确认。(A-4)
  earliest: '更早的记录先看不了。',
  monthDone: month => month + ' 月做到',
  longest: '最长一次连续',
  doubleMiss: '连着错过两天',
  recent: '最近记下的',
  sourceWeb: '你在网页上记的',
  sourceAgent: 'Weave 帮你记的',
  // The calendar's legend
  done: '做到了',
  missed: '没做',
  notStarted: '还没开始',
  // The line under the title: 为了「每天动一动」 · 从 10 月 12 日开始 (COPY.forGoal, then this)
  since,
  // The habit buttons' accessible name, and the month buttons' (the board's aria-labels)
  pickHabit: '选一个习惯',
  prevMonth: '上个月',
  nextMonth: '下个月',
  // The calendar: its accessible name (「10 月日历」), the weekdays over it, Monday first, and what a day says to a screen
  // reader: 「10 月 12 日：做到了」 (the board and its script)
  calendarLabel: month => month + ' 月日历',
  weekdays: ['一', '二', '三', '四', '五', '六', '日'],
  dayState: (date, state) => date + '：' + state,
  // The units of the three numbers: 16 / 20 天, 5 天, 0 次 (the board's script)
  outOf: n => '/ ' + n + ' 天',
  dayUnit: '天',
  timeUnit: '次',

  // Settings (设置)
  connections: '连接',
  time: '时间',
  zoneLabel: '所在地时间',
  zones: [
    {value: 'Asia/Shanghai', label: '北京时间'},
    {value: 'America/Los_Angeles', label: '洛杉矶时间'},
    {value: 'America/New_York', label: '纽约时间'},
    {value: 'Europe/London', label: '伦敦时间'},
    {value: 'Asia/Tokyo', label: '东京时间'},
    {value: 'Asia/Singapore', label: '新加坡时间'},
  ],
  whenProactive: 'Weave 什么时候主动找你',
  goAgent: '去助理主页看',
  privacy: '数据与隐私',
  privacyText: '你的记录只在你的账号里，别人看不到。聊天内容会发给 DeepSeek 生成回复。',
  export: '导出我的数据',
  deleteAccount: '删除账号',
  privacyLink: '隐私说明',
  // The Notion row (the board): 「把计划和记录存进你自己的 Notion。」, or connected, 「已连接 · 用到的页面：习惯日记」
  notion: 'Notion',
  notionIntro: '把计划和记录存进你自己的 Notion。',
  notionPage: title => '用到的页面：' + title,
  connectNotion: '连接 Notion',
  disconnect: '断开',
  // The WeChat row: its name on the board, and its button (spec section 3.5 calls it 「连接」)
  wechat: '微信群',
  connect: '连接',
  // Not on the boards: the Notion page picker of the settings page this one replaces (#18, the one-click Notion
  // connection, which spec section 3.5 keeps), word for word ...
  changePage: '更换页面',
  pickPage: '选择用于 Weave 长期记忆的页面',
  choosePage: '选择此页面',
  // ... and its question before an account is deleted, word for word.
  deleteConfirm: '确定要永久删除账号吗？你的聊天、计划和日程都会被删除，无法恢复。',

  // The assistant's home page (助理主页)
  agentTabs: '助理主页的栏目', // the two tabs' accessible name (the board's aria-label)
  remindersTab: '提醒',
  memoryTab: '记忆',
  // 草稿文案，待确认。(A-4: the board's first sentence no longer holds now that Weave can remind once)
  notLive: '主动提醒还没开通。现在 Weave 只会在你交代的时间提醒你一次；开通以后，它会按下面的安排主动来找你。',
  once: '只响一次',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  noneScheduled: '暂时没有安排。',
  // A reminder's delete button's accessible name (the board's script): 删除：给妈妈打个电话
  removeReminder: text => '删除：' + text,
  // 草稿文案，待确认。(A-4)
  memoryIntro: '这些是 Weave 自己记下的关于你的事。哪条不对，直接在聊天里跟它说。',
  // 草稿文案，待确认。(A-4)
  memoryEmpty: 'Weave 还没有记下关于你的事。',

  // The first time the site is opened
  welcome: '你好，我是 Weave',
  firstRunIntro: '先选一件最想养成的小事。我们从小到不会失败的一步开始，慢慢来。',
  pickOne: '选一件想养成的事', // the five choices' accessible name (the board's aria-label)
  // The five choices and the first step of each (the board's own list). The last is the person's own: no step.
  firstRunOptions: [
    {key: 'walk', label: '饭后走走', step: '吃完饭，穿上鞋走到楼下'},
    {key: 'sleep', label: '早点睡', step: '晚上 11 点把手机放到卧室外面'},
    {key: 'water', label: '多喝水', step: '起床先喝一杯水'},
    {key: 'read', label: '读几页书', step: '睡前读 1 页'},
    {key: 'own', label: '自己写一个', step: ''},
  ],
  firstRunPick: name => '好，就从「' + name + '」开始。',
  firstRunStep: step => '第一步可以小到：' + step + '。',
  firstRunGo: '就这样开始',
  firstRunChange: '想换个说法，就在下面跟我说。',
  ownHabit: '我想养成…',
  ownPlaceholder: '比如：每天拉伸 5 分钟',
  ownDone: '好了',
  sayIt: '也可以直接跟我说',
  sayItPlaceholder: '比如：我总是熬夜，想早点睡',
  // 草稿文案，待确认。(A-4: what 「就这样开始」 sends to Weave on the person's behalf)
  firstRunStarter: (pick, step) => '我想从「' + pick + '」开始，第一步：' + step + '。',

  // A page that did not load
  // 草稿文案，待确认。(A-4: the sentence, and the button next to it)
  loadFailed: '没加载出来。',
  retry: '重试',
});

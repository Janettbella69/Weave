// 第 0 步（docs/ARCHITECTURE.md 第 15 节）：用真 Key 把第 2 节的配置跑一次，看真实接口收不收。
// 和探针不同，这个会花钱：DeepSeek flash 估计 $0.005–0.02。不经过模型代理，Key 直接给 CLI，
// CLI 的 HOME 和配置目录都在临时文件夹，跑完删掉。
//
//   cd hosted/agent-service && npm ci && cd ../.. && node scripts/agent-sdk-probe/real-smoke.mjs
//
// Key 依次读 DEEPSEEK_API_KEY、AGENT_PROVIDER_API_KEY，都没有就在终端里隐藏输入。
// SMOKE_PROVIDER 选 deepseek / kimi / glm / qwen；--websearch 多试一次 WebSearch。
import {mkdirSync, mkdtempSync, writeFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';
import {scopeFor} from '../../hosted/agent-service/scopes.mjs';
import {providerFor, cliEnv} from '../../hosted/agent-service/providers.mjs';
import {systemPromptFor} from '../../hosted/agent-service/prompts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const NM = process.env.SDK_NODE_MODULES || join(here, '../../hosted/agent-service/node_modules');
const load = path => import(pathToFileURL(join(NM, path)).href);
const {query, tool, createSdkMcpServer} = await load('@anthropic-ai/claude-agent-sdk/sdk.mjs');
const {z} = await load('zod/index.js');

// 只有 DeepSeek 内置了价目表，用来估这次花了多少钱（官方价区间，每百万 token）。
const PRICES = {deepseek: {input: [0.15, 0.30], output: [0.60, 1.20]}};
const providerName = process.env.SMOKE_PROVIDER || 'deepseek';
let provider;
try { provider = providerFor(providerName); } catch { provider = null; }
const keyEnvs = provider ? [provider.keyEnv, ...(providerName === 'deepseek' ? ['AGENT_PROVIDER_API_KEY'] : [])] : [];
if (!provider) { console.error(`不认识的 SMOKE_PROVIDER：${providerName}`); process.exit(2); }

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(Error(`没有找到 Key：请设置 ${keyEnvs[0]}，或在终端里直接运行以便输入`));
    const rl = createInterface({input: process.stdin, output: process.stdout, terminal: true});
    rl._writeToOutput = text => { if (text.includes(prompt)) process.stdout.write(prompt); };
    rl.question(prompt, answer => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()); });
  });
}
const key = keyEnvs.map(name => process.env[name]).find(Boolean) || await askHidden(`${providerName} API Key（输入时不显示）：`);
const baseUrl = process.env.SMOKE_BASE_URL || provider.baseUrl;

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'weave-smoke-')));
const PLUGIN = join(ROOT, 'plugin'), WORK = join(ROOT, 'work');
for (const dir of ['home', 'config', 'work', 'plugin/.claude-plugin', 'plugin/skills/weekly-review/scripts']) mkdirSync(join(ROOT, dir), {recursive: true});
writeFileSync(join(PLUGIN, '.claude-plugin/plugin.json'), JSON.stringify({name: 'weave', version: '0.0.1', description: 'smoke'}));
// docs/ARCHITECTURE.md 第 5 节的 weekly-review 原文；参考代码在这里只输出一个固定值。
writeFileSync(join(PLUGIN, 'skills/weekly-review/SKILL.md'), `---
name: weekly-review
description: 复盘一周的习惯完成情况时使用。
---
1. 用 mcp__weave__query_completions 取最近 7 天和前 7 天的记录，存成 JSON。
2. 运行 python3 \${CLAUDE_SKILL_DIR}/scripts/stats.py <文件> 得到完成次数和连续天数。
   数字以脚本为准，不要自己心算。
3. 讲法：先说做到的，再说一个最容易改的地方。断了不算失败，
   重点是不要连续错过两次。缺少记录不等于没做。
`);
writeFileSync(join(PLUGIN, 'skills/weekly-review/scripts/stats.py'), 'print("streak=3")\n');

let logged = 0;
const weave = createSdkMcpServer({name: 'weave', version: '0.0.1', alwaysLoad: true, tools: [
  tool('log_completion', '记录用户完成了一次习惯。只记用户明确说做了的，猜测不要记。',
    {habit_id: z.string(), date: z.string().describe('用户当地日期，YYYY-MM-DD'), note: z.string().max(500).optional()},
    async () => { logged++; return {content: [{type: 'text', text: '已记录'}]}; }),
  // weekly-review 第一步要用它，所以给一个空结果，让真模型能照 Skill 走完。
  tool('query_completions', '查这个人在一段日期内的完成记录，返回 JSON。',
    {from: z.string(), to: z.string(), habit_id: z.string().optional()},
    async () => ({content: [{type: 'text', text: JSON.stringify({today: '2026-11-02', completions: [{habit_id: 'walk', date: '2026-11-01'}]})}]})),
]});

const scope = scopeFor('owner');
const options = {
  systemPrompt: systemPromptFor(scope, ''),
  tools: [...scope.builtins],
  allowedTools: [...scope.builtins, 'mcp__weave__*'],
  disallowedTools: [...scope.denied],
  permissionMode: 'dontAsk',
  mcpServers: {weave},
  plugins: [{type: 'local', path: PLUGIN}],
  skills: [...scope.skills],
  settingSources: [],
  strictMcpConfig: true,
  settings: {attribution: false},
  cwd: WORK,
  // 第 0 步还没有模型代理，真 Key 直接放在 ANTHROPIC_AUTH_TOKEN 这个位置。
  env: cliEnv({provider, model: provider.main, runToken: key, baseUrl, home: join(ROOT, 'home'), configDir: join(ROOT, 'config'), path: process.env.PATH}),
  maxTurns: 8,
  maxBudgetUsd: 2,
  thinking: {type: 'disabled'},
};

const usage = {input: 0, output: 0};
async function ask(prompt, extra = {}) {
  const toolUses = [], toolResults = [];
  let result = null, error = null;
  try {
    for await (const m of query({prompt, options: {...options, ...extra}})) {
      if (m.type === 'assistant') for (const b of m.message.content || []) if (b.type === 'tool_use') toolUses.push(b);
      if (m.type === 'user' && Array.isArray(m.message.content)) {
        for (const b of m.message.content) if (b.type === 'tool_result') toolResults.push(typeof b.content === 'string' ? b.content : (b.content || []).map(x => x.text || '').join(''));
      }
      if (m.type === 'result') result = m;
    }
  } catch (e) { error = String(e.message || e); }
  if (result?.usage) {
    usage.input += (result.usage.input_tokens || 0) + (result.usage.cache_creation_input_tokens || 0) + (result.usage.cache_read_input_tokens || 0);
    usage.output += result.usage.output_tokens || 0;
  }
  return {result, error, toolUses, toolResults};
}

const rows = [];
const check = (claim, pass, detail = '') => { rows.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${claim}${detail ? `  (${detail})` : ''}`); };
const info = (label, value) => console.log(`INFO  ${label}：${value}`);
console.log(`Weave 第 0 步冒烟：${providerName}（${provider.main}） @ ${baseUrl}\n`);

const first = await ask('请依次做三件事：调用 log_completion 记一次散步；用 weave:weekly-review 这个 Skill；用 Bash 算 6*7。最后回复『完成』。');
const accepted = first.result?.subtype === 'success' && !first.result.is_error;
check('接口接受这份配置', accepted, accepted ? '' : (first.error || first.result?.result || '没有 result').slice(0, 500));
check('调到了 weave 工具', logged > 0, `log_completion ${logged} 次`);
check('Skill 加载了，参考代码跑出了 streak=3', first.toolUses.some(t => t.name === 'Skill') && first.toolResults.some(x => x.includes('streak=3')));
check('Bash 跑出了 42', first.toolResults.some(x => /(^|\n)42(\n|$)/.test(x)));
info('这一轮调用的工具', first.toolUses.map(t => t.name).join(' → ') || '无');

if (first.result?.session_id) {
  const who = await ask('你是谁？', {resume: first.result.session_id});
  info('问「你是谁？」的回答（看它是否自称 Weave）', (who.result?.result || who.error || '无').replace(/\s+/g, ' ').slice(0, 300));
}
if (process.argv.includes('--websearch')) {
  const web = await ask('用 WebSearch 查一下「Claude Agent SDK」，只说第一条结果的标题。');
  const used = web.toolUses.some(t => t.name === 'WebSearch');
  info('WebSearch', `${used ? '调用了' : '没调用'}；结果：${(web.toolResults.join(' | ') || web.result?.result || web.error || '无').replace(/\s+/g, ' ').slice(0, 300)}`);
}

const price = PRICES[providerName];
const cost = price ? `；按 ${provider.main} 官方价约 $${(usage.input * price.input[0] / 1e6 + usage.output * price.output[0] / 1e6).toFixed(4)}–$${(usage.input * price.input[1] / 1e6 + usage.output * price.output[1] / 1e6).toFixed(4)}` : '；这家没有内置价目表';
info('token', `输入 ${usage.input}，输出 ${usage.output}${cost}`);

const failed = rows.filter(pass => !pass).length;
if (failed) console.log(`\n${failed} 项没通过。临时文件留在 ${ROOT}`);
else rmSync(ROOT, {recursive: true, force: true});
process.exit(failed ? 1 : 0);

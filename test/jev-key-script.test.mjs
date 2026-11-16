// deploy/tencent/set-jev-key.sh：在临时目录里真的跑一遍（WEAVE_SKIP_DEPLOY=1，不部署、不联网）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const script = join(root, 'deploy/tencent/set-jev-key.sh');
const KEY = 'sk-or-v1-' + 'a1'.repeat(32);
const mode = path => statSync(path).mode & 0o777;

function sandbox(webEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'weave-jev-key-'));
  if (webEnv !== undefined) writeFileSync(join(dir, 'web.env'), webEnv);
  const backupDir = join(dir, 'home/weave-data/env-backups');
  return {
    dir,
    run: (input, args = []) => spawnSync('bash', [script, ...args], {input, encoding: 'utf8', env: {...process.env, HOME: join(dir, 'home'), WEAVE_DEPLOY_DIR: dir, WEAVE_SKIP_DEPLOY: '1'}}),
    env: () => readFileSync(join(dir, 'web.env'), 'utf8'),
    backups: () => readdirSync(backupDir).map(name => readFileSync(join(backupDir, name), 'utf8')),
    done: () => rmSync(dir, {recursive: true, force: true}),
  };
}

test('默认当成 OpenRouter 的 Key：写 TYPESAFE_API_KEY 和 TYPESAFE_BASE_URL，换掉旧的，别的行一行不动；权限 600，先备份，输出里没有 Key', () => {
  const original = '# 注释\nA=1\nTYPESAFE_API_KEY=old-key-123456\nB=has = and spaces\nTYPESAFE_BASE_URL=https://api.typesafe.ai\nTYPESAFE_API_KEY=duplicate-123456\nlast=no newline';
  const box = sandbox(original);
  try {
    const r = box.run(KEY + '\n');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(box.env(), `# 注释\nA=1\nB=has = and spaces\nlast=no newline\nTYPESAFE_API_KEY=${KEY}\nTYPESAFE_BASE_URL=https://openrouter.ai/api\n`);
    assert.equal(mode(join(box.dir, 'web.env')), 0o600);
    assert.deepEqual(box.backups(), [original]);
    assert.ok(!(r.stdout + r.stderr).includes(KEY), '不把 Key 打出来');
    assert.match(r.stdout, /经 OpenRouter 调 Jev/);
  } finally { box.done(); }
});

test('--typesafe：只写 TYPESAFE_API_KEY，删掉 TYPESAFE_BASE_URL（直连 TypeSafe）；Windows 换行也认', () => {
  const box = sandbox('A=1\nTYPESAFE_BASE_URL=https://openrouter.ai/api\n');
  try {
    const typesafeKey = 'ts_' + 'k'.repeat(30);
    const r = box.run(typesafeKey + '\r\n', ['--typesafe']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(box.env(), `A=1\nTYPESAFE_API_KEY=${typesafeKey}\n`);
    assert.match(r.stdout, /直连 TypeSafe/);
  } finally { box.done(); }
});

test('空行 = 关掉 Jev：两行都删掉，别的（包括 JEV_THRESHOLD）不动', () => {
  const box = sandbox(`A=1\nTYPESAFE_API_KEY=${KEY}\nTYPESAFE_BASE_URL=https://openrouter.ai/api\nJEV_THRESHOLD=0.6\n`);
  try {
    const r = box.run('\n');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(box.env(), 'A=1\nJEV_THRESHOLD=0.6\n');
    assert.match(r.stdout, /Jev 关闭/);
  } finally { box.done(); }
});

test('Key 格式不对、参数不认识：什么都不改，退出码 1；找不到 web.env 也一样', () => {
  const original = 'A=1\nTYPESAFE_API_KEY=keep-me-123456\n';
  for (const [input, args] of [['has space 123456789\n', []], ['short\n', []], ['bad;rm -rf /\n', []], [KEY + '\n', ['--nope']]]) {
    const box = sandbox(original);
    try {
      const r = box.run(input, args);
      assert.equal(r.status, 1, JSON.stringify([input, args]));
      assert.equal(box.env(), original);
      assert.ok(!(r.stdout + r.stderr).includes(KEY));
    } finally { box.done(); }
  }
  const box = sandbox();
  try {
    const r = box.run(KEY + '\n');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /找不到/);
  } finally { box.done(); }
});

test('经 OpenRouter 时 web.env 里另写了不带 typesafe/ 前缀的 JEV_MODEL：照样写入，但提醒一句', () => {
  const box = sandbox('JEV_MODEL=jev-1.14.0\n');
  try {
    const r = box.run(KEY + '\n');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /JEV_MODEL 没有 typesafe\/ 前缀/);
  } finally { box.done(); }
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// wrangler 默认把每一条调试消息另外写进 ~/.config/.wrangler/logs 的文件里。网站容器里没人读这些文件，
// 没打调试代理补丁时里面有每一次 D1 查询的回答（用户数据，2026-11-03 线上约 20 MB），docker restart 也不清。
// 网站镜像用 WRANGLER_WRITE_LOGS=false 关掉文件；控制台（docker logs）照旧。
const root = fileURLToPath(new URL('..', import.meta.url));
const dockerfile = readFileSync(root + 'hosted/Dockerfile.vps', 'utf8');
const cli = root + 'hosted/node_modules/wrangler/wrangler-dist/cli.js';

test('网站镜像的运行阶段关掉 wrangler 的调试日志文件（WRANGLER_WRITE_LOGS=false）', () => {
  const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  const env = runtime.split('\n').filter(line => /^ENV\s/.test(line)).join(' ');
  assert.match(env, /(^|\s)WRANGLER_WRITE_LOGS=false(\s|$)/, '要写在最后一个 FROM 之后（运行阶段），构建阶段的 ENV 不会带进运行的容器');
});

// 根目录的测试在 CI 里比 hosted/ 装依赖早跑，那时没有 wrangler，跳过；本机装过依赖时核对开关的写法没变。
test('装着的 wrangler 只认 WRANGLER_WRITE_LOGS 等于 false 或 0，而且它只管文件、不管控制台', {skip: !existsSync(cli) && '没装 hosted/ 的依赖'}, () => {
  const source = readFileSync(cli, 'utf8');
  assert.match(source, /const setting = process\.env\.WRANGLER_WRITE_LOGS\?\.toLowerCase\(\);\s*return setting !== "false" && setting !== "0";/);
  assert.match(source, /if \(shouldLogToDisk\(\)\) \{\s*void appendToDebugLogFile\(messageLevel, message\);\s*\}\s*if \(LOGGER_LEVELS\[this\.loggerLevel\] >= LOGGER_LEVELS\[messageLevel\]\) \{/);
});

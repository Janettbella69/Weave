// 给 wrangler 4.92.0 的两个开发服务器文件打补丁。服务器上用 `wrangler dev` 当正式服务（见 Dockerfile.vps），这两处在本机开发时无所谓，在服务器上会出事：
//   一、开发代理（ProxyWorker.js）：转发给网站程序的 GET/HEAD 失败时马上重试，不再挂起来等下一个请求。
//   二、调试代理（InspectorProxyWorker.js）：没有人打开 DevTools 时，不让网站程序送网络事件，免得内存一直涨。
//
// 一、为什么要打：请求先到代理（workerd A），再经一条本机 HTTP 长连接转给网站程序（workerd B）。
// 这条连接闲了大约 5 秒就会被关；浏览器每 5 秒轮询一次 /api/status，正好撞在关闭的瞬间时，转发立刻失败（"Network connection lost."）。
// wrangler 4.92.0 把这个失败当成「Worker 重启了」（拿完整地址和只有源的地址比较，路径不是 / 就永远不相等），
// 把 GET 放进重试队列，只有下一个请求到达时才重试。Chrome 的 HTTP 缓存层又把同一地址的后续轮询扣在浏览器里 20 秒
// （实测：请求加上 cache: 'no-store' 就不扣），所以下一个请求要 20 秒后才到：5 + 20 = 25 秒，日志里就是反复出现的 25,0xx ms。
// wrangler 上游在 4.129.1（PR #15252）修了同一个问题，但不能直接升级：那一版同时把 miniflare 换成了 5.x 的 alpha/beta，
// 而且实测 4.129.1 和 4.156.1 都拒绝现在构建出来的 dist/server/wrangler.json（里面有它不再支持的 legacy_env），
// 要连 @cloudflare/vite-plugin 一起升级并重新验证。所以只把上游的做法搬到当前版本：
//   1. 同一个网站程序上 GET/HEAD 失败：马上重试，最多再试两次（0 毫秒、250 毫秒），失败的那条连接已被丢掉，重试走新连接；
//   2. 用「源」比较，而不是完整地址；
//   3. 重试用完仍失败：只回这一个请求一个 503，不再把错误报给 wrangler 主进程（路径是 / 时它会让整个 wrangler 退出）；
//   4. 网站程序真的换了（重新加载）：保持原来的做法，GET/HEAD 等重新就绪后重放，其余回 503。
//
// 二、为什么要打：调试代理和开发代理住在同一个 workerd 进程里（服务器上监听 4317 的那个，就是一直涨、被内核杀掉的那个）。
// wrangler 一启动就让它连上网站程序的调试接口，不管有没有人打开 DevTools，都发 Network.enable。之后网站程序每发一个子请求——
// 每一次 D1 查询都是一个（http://d1/query、http://d1/execute）——workerd 就送来 4 条网络事件，其中 Network.loadingFinished
// 带着 base64 的整个回答（cfResponse.body）。Store.load() 每次都读出整个 world，所以桥接、闹钟、页面的每个请求都在这里留下
// 一份比 world 还大的副本。这些消息全进 runtimeMessageBuffer，只有 DevTools 连上时才清空；线上没人连，就一直涨，
// 到容器 768 MB 上限时被内核杀掉（2026-11-03 一天好几次）。每条消息还会写进 wrangler 的调试日志文件（~/.config/.wrangler/logs）。
// 上游在 4.100.0（PR #14243，issue #14191）修了：没有 DevTools 时不发 Network.enable，DevTools 断开时补发 Network.disable。这里原样搬过来。
// 缓冲区本身上游没改：没有 DevTools 时它仍会存下网站程序的 console 输出和每 10 秒一次保活的回答，量很小，也不随请求涨。
// 不要用「连一个 DevTools 把缓冲区接走」代替这个补丁：实测接走攒了 20 分钟的缓冲区时，这个 workerd 一下子从 148 MB 涨到 963 MB。
//
// 上游修复进了你用的 wrangler 以后（调试代理 4.100.0 起，开发代理 4.129.1 起），这个脚本会发现并什么都不做，可以删掉它和调用它的地方。
//
// 用法（在 hosted/ 里）：
//   node scripts/patch-wrangler-proxy.mjs           打补丁（已经打过或已是上游修复就不动）
//   node scripts/patch-wrangler-proxy.mjs --check   只检查：任何一个没打补丁就退出 1（容器启动时用，免得悄悄带着旧问题上线）
//   node scripts/patch-wrangler-proxy.mjs --print   把打过补丁的内容打印出来，不改文件
import {createHash} from 'node:crypto';
import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const PROXY_WORKER = new URL('../node_modules/wrangler/wrangler-dist/ProxyWorker.js', import.meta.url);
export const INSPECTOR_PROXY_WORKER = new URL('../node_modules/wrangler/wrangler-dist/InspectorProxyWorker.js', import.meta.url);
// wrangler 4.92.0 的原文件。内容不是它、也不是已经打过补丁的，就不动，让人来看。
export const ORIGINAL_SHA256 = '48d0fa9fc066b765b2cde5fa622333c8b91eb4357e4c0cb9efb8512e8318529c';
export const INSPECTOR_ORIGINAL_SHA256 = '17077283a771d0575bb5def67e91c0c74dec9e505d29bd63f8a71c1294c81f8f';
export const PATCH_MARKER = '[weave patch]';
const UPSTREAM_FIX_MARKER = 'dropped connection to the UserWorker';
const INSPECTOR_UPSTREAM_FIX_MARKER = 'method: "Network.disable"';

const sha256 = text => createHash('sha256').update(text).digest('hex');
export const isPatched = source => source.includes(PATCH_MARKER);
export const isUpstreamFixed = source => source.includes(UPSTREAM_FIX_MARKER);
export const isInspectorUpstreamFixed = source => source.includes(INSPECTOR_UPSTREAM_FIX_MARKER);

// 每一处替换都必须在原文里正好出现一次，否则宁可失败也不要打出一个半截的补丁。
function replaceOnce(source, from, to) {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + 1) >= 0) throw new Error(`补丁位置对不上：${from.split('\n')[0].trim()}`);
  return source.slice(0, first) + to + source.slice(first + from.length);
}

export function patchSource(source) {
  let out = source;
  out = replaceOnce(out,
`      void fetch(userWorkerUrl, new Request(request, { headers })).then(async (res) => {
`,
`      const attemptUserWorkerFetch = (attempt = 0) => void fetch(userWorkerUrl, new Request(request, { headers })).then(async (res) => {
        if (attempt > 0) {
          console.warn(\`${PATCH_MARKER} \${request.method} \${outerUrl.pathname} recovered on attempt \${attempt + 1} after a dropped connection to the user worker\`);
        }
`);
  out = replaceOnce(out,
`        deferredResponse.resolve(res);
      }).catch((error) => {
        const newUserWorkerUrl = this.proxyData && urlFromParts(this.proxyData.userWorkerUrl);
        if (userWorkerUrl.href === newUserWorkerUrl?.href) {
          void sendMessageToProxyController(this.env, {
            type: "error",
            error: {
              name: error.name,
              message: error.message,
              stack: error.stack,
              cause: error.cause
            }
          });
          deferredResponse.reject(error);
        } else if (request.method === "GET" || request.method === "HEAD") {
          this.requestRetryQueue.set(request, deferredResponse);
        } else {
          deferredResponse.resolve(
            new Response(
              "Your worker restarted mid-request. Please try sending the request again. Only GET or HEAD requests are retried automatically.",
              {
                status: 503,
                headers: { "Retry-After": "0" }
              }
            )
          );
        }
      });
`,
`        deferredResponse.resolve(res);
      }, (error) => {
        const current = this.proxyData && urlFromParts(this.proxyData.userWorkerUrl);
        if (userWorkerUrl.origin === current?.origin && (request.method === "GET" || request.method === "HEAD") && attempt < 2) {
          setTimeout(() => attemptUserWorkerFetch(attempt + 1), attempt === 0 ? 0 : 250);
          return;
        }
        throw error;
      }).catch((error) => {
        const newUserWorkerUrl = this.proxyData && urlFromParts(this.proxyData.userWorkerUrl);
        const sameWorker = userWorkerUrl.origin === newUserWorkerUrl?.origin;
        if (!sameWorker && (request.method === "GET" || request.method === "HEAD")) {
          this.requestRetryQueue.set(request, deferredResponse);
        } else {
          if (sameWorker) {
            console.warn(\`${PATCH_MARKER} \${request.method} \${outerUrl.pathname} failed: \${error && error.message}\`);
          }
          deferredResponse.resolve(
            new Response(
              sameWorker ? "Lost the connection to the worker before it answered. Please try sending the request again." : "Your worker restarted mid-request. Please try sending the request again. Only GET or HEAD requests are retried automatically.",
              {
                status: 503,
                headers: { "Retry-After": "0" }
              }
            )
          );
        }
      });
      attemptUserWorkerFetch();
`);
  return `// ${PATCH_MARKER} patched by hosted/scripts/patch-wrangler-proxy.mjs (retry GET/HEAD dropped by an idle connection)\n` + out;
}

// 和上游 4.100.0 一模一样的两处改动：Network.enable 只在 DevTools 连着时发；DevTools 断开时补发 Network.disable
// （DevTools 自己会发 Network.enable，调试代理原样转给网站程序，断开后不关掉就又会一直存下去）。
export function patchInspectorSource(source) {
  let out = source;
  out = replaceOnce(out,
`    this.sendRuntimeMessage(
      { method: "Network.enable", id: this.nextCounter() },
      runtime
    );
`,
`    if (this.websockets.devtools !== void 0) {
      this.sendRuntimeMessage(
        { method: "Network.enable", id: this.nextCounter() },
        runtime
      );
    }
`);
  out = replaceOnce(out,
`              method: "Debugger.disable"
            });
`,
`              method: "Debugger.disable"
            });
            this.sendRuntimeMessage({
              id: this.nextCounter(),
              method: "Network.disable"
            });
`);
  return `// ${PATCH_MARKER} patched by hosted/scripts/patch-wrangler-proxy.mjs (Network.enable only while DevTools is attached, as in wrangler 4.100.0)\n` + out;
}

export const TARGETS = [
  {label: 'wrangler 开发代理（ProxyWorker.js）', file: PROXY_WORKER, sha256: ORIGINAL_SHA256, upstreamFixed: isUpstreamFixed, patch: patchSource},
  {label: 'wrangler 调试代理（InspectorProxyWorker.js）', file: INSPECTOR_PROXY_WORKER, sha256: INSPECTOR_ORIGINAL_SHA256, upstreamFixed: isInspectorUpstreamFixed, patch: patchInspectorSource},
];

// 一个文件：mode 是 ''（打补丁）、'--check'（只检查）或 '--print'（打印打过补丁的内容）。返回 {ok, message, output?}。
export function processTarget(target, mode = '') {
  const source = readFileSync(target.file, 'utf8');
  if (isPatched(source)) return {ok: true, message: `${target.label}：已经打过补丁。`};
  if (target.upstreamFixed(source)) return {ok: true, message: `${target.label}：上游已修复，不需要这个补丁。`};
  if (sha256(source) !== target.sha256) {
    return {ok: false, message: `${target.label} 不是 4.92.0 的原文件，也没有上游修复：补丁没有打。升级 wrangler 以后请重新评估这个补丁。`};
  }
  if (mode === '--check') return {ok: false, message: `${target.label} 还没有打补丁：先跑 node scripts/patch-wrangler-proxy.mjs。`};
  const patched = target.patch(source);
  if (mode === '--print') return {ok: true, message: '', output: patched};
  writeFileSync(target.file, patched);
  return {ok: true, message: `${target.label}：补丁已打上。`};
}

function main() {
  const mode = process.argv[2] || '';
  let failed = 0;
  for (const target of TARGETS) {
    const result = processTarget(target, mode);
    if (result.output) process.stdout.write(result.output);
    if (result.message) (result.ok ? console.log : console.error)(result.message);
    if (!result.ok) failed++;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) process.exit(main());

// 给 wrangler 4.92.0 的开发代理（ProxyWorker）打一个补丁：转发给网站程序的 GET/HEAD 失败时马上重试，不再挂起来等下一个请求。
//
// 为什么要打：服务器上用 `wrangler dev` 当正式服务。请求先到代理（workerd A），再经一条本机 HTTP 长连接转给网站程序（workerd B）。
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
// 上游修复进了你用的 wrangler 以后（4.129.1 起），这个脚本会发现并什么都不做，可以删掉它和调用它的地方。
//
// 用法（在 hosted/ 里）：
//   node scripts/patch-wrangler-proxy.mjs           打补丁（已经打过或已是上游修复就不动）
//   node scripts/patch-wrangler-proxy.mjs --check   只检查：没打补丁就退出 1（容器启动时用，免得悄悄带着旧问题上线）
//   node scripts/patch-wrangler-proxy.mjs --print   把打过补丁的内容打印出来，不改文件
import {createHash} from 'node:crypto';
import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const PROXY_WORKER = new URL('../node_modules/wrangler/wrangler-dist/ProxyWorker.js', import.meta.url);
// wrangler 4.92.0 的原文件。内容不是它、也不是已经打过补丁的，就不动，让人来看。
export const ORIGINAL_SHA256 = '48d0fa9fc066b765b2cde5fa622333c8b91eb4357e4c0cb9efb8512e8318529c';
export const PATCH_MARKER = '[weave patch]';
const UPSTREAM_FIX_MARKER = 'dropped connection to the UserWorker';

const sha256 = text => createHash('sha256').update(text).digest('hex');
export const isPatched = source => source.includes(PATCH_MARKER);
export const isUpstreamFixed = source => source.includes(UPSTREAM_FIX_MARKER);

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

function main() {
  const mode = process.argv[2] || '';
  const source = readFileSync(PROXY_WORKER, 'utf8');
  if (isPatched(source)) { console.log('wrangler 开发代理：已经打过补丁。'); return 0; }
  if (isUpstreamFixed(source)) { console.log('wrangler 开发代理：上游已修复，不需要补丁（可以删掉 scripts/patch-wrangler-proxy.mjs）。'); return 0; }
  if (sha256(source) !== ORIGINAL_SHA256) {
    console.error('wrangler 开发代理（ProxyWorker.js）不是 4.92.0 的原文件，也没有修复：补丁没有打。升级 wrangler 以后请重新评估这个补丁。');
    return 1;
  }
  if (mode === '--check') { console.error('wrangler 开发代理还没有打补丁：先跑 node scripts/patch-wrangler-proxy.mjs。'); return 1; }
  const patched = patchSource(source);
  if (mode === '--print') { process.stdout.write(patched); return 0; }
  writeFileSync(PROXY_WORKER, patched);
  console.log('wrangler 开发代理：补丁已打上。');
  return 0;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) process.exit(main());

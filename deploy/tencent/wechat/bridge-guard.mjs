// Starts the WeChat bridge (hosted/wechat-bridge/bridge.mjs, unchanged) inside the wx container's network
// (compose: network_mode: service:wx) and adds the two things that setup needs and the bridge does not do itself:
//
//  1. Leave when wx stops answering. wx gets a new network every time it restarts (an out-of-memory kill, a restart by
//     Docker); this container stays in the old one, where nothing answers on 127.0.0.1 and nothing reaches the
//     outside. After 30 s without an answer the guard exits; Docker's restart policy starts the container again, and a
//     container that starts joins wx's current network.
//  2. Say once when the bridge first got through to wx, and once when it first got through to Weave (a 2xx answer),
//     so login.sh can tell the bridge really works before it revokes the old key. Only these fixed sentences are
//     logged: never a URL, a header or a body.
//
// Knobs for tests only: WECHAT_BRIDGE_MODULE (default /app/bridge.mjs), WECHAT_GUARD_EVERY_MS (5000),
// WECHAT_GUARD_LIMIT_MS (30000).
import {connect} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const SAID_WX = '桥接已连上 wx 守护进程。';
export const SAID_WEAVE = '桥接已连上 Weave。';

export function daemonAddress(baseUrl = 'http://127.0.0.1:6174/v1') {
  const url = new URL(baseUrl);
  return {host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80)};
}

// One TCP connection attempt: true when something accepts it within timeoutMs. Says nothing to the daemon.
export function canConnect({host, port, timeoutMs = 3000}) {
  return new Promise(done => {
    const socket = connect({host, port});
    const end = ok => { socket.destroy(); done(ok); };
    socket.setTimeout(timeoutMs, () => end(false));
    socket.once('connect', () => end(true));
    socket.once('error', () => end(false));
  });
}

// Calls exit(1) once probe() has failed for limitMs in a row. A success starts the count again.
export function watchDaemon({probe, exit, log = (...args) => console.error(...args), everyMs = 5000, limitMs = 30000, now = Date.now, schedule = setInterval}) {
  let failingSince = null, busy = false, done = false, timer;
  const stop = () => { done = true; clearInterval(timer); };
  const check = async () => {
    if (busy || done) return;
    busy = true;
    try {
      if (await probe()) { failingSince = null; return; }
      failingSince ??= now();
      if (now() - failingSince >= limitMs) {
        stop();
        log(`wx 守护进程 ${Math.round(limitMs / 1000)} 秒没有回应（多半是它重启了，换了网络）。桥接退出，由 Docker 重新启动，加入 wx 现在的网络。`);
        exit(1);
      }
    } finally { busy = false; }
  };
  timer = schedule(check, everyMs);
  timer?.unref?.();
  return {check, stop};
}

// Wraps fetch and says SAID_WX / SAID_WEAVE the first time a call to each one comes back 2xx.
export function announceFirstContact({fetcher, wxBase, weaveOrigin, log = (...args) => console.log(...args)}) {
  const said = new Set();
  const say = (key, text) => { if (!said.has(key)) { said.add(key); log(text); } };
  return async (url, options) => {
    const response = await fetcher(url, options);
    if (response?.ok) {
      const href = String(url instanceof URL ? url.href : url?.url ?? url);
      if (wxBase && href.startsWith(wxBase)) say('wx', SAID_WX);
      else if (weaveOrigin && href.startsWith(weaveOrigin)) say('weave', SAID_WEAVE);
    }
    return response;
  };
}

const positive = (value, fallback) => { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback; };

export async function run(env = process.env) {
  const wxBase = (env.WX_BASE_URL || 'http://127.0.0.1:6174/v1').replace(/\/$/, '');
  const weaveOrigin = (env.WEAVE_ORIGIN || '').replace(/\/$/, '');
  // bridge.mjs takes the global fetch when it builds its clients, so it has to be wrapped before main() runs.
  globalThis.fetch = announceFirstContact({fetcher: globalThis.fetch.bind(globalThis), wxBase, weaveOrigin});
  const {host, port} = daemonAddress(wxBase);
  watchDaemon({
    probe: () => canConnect({host, port}),
    exit: code => process.exit(code),
    everyMs: positive(env.WECHAT_GUARD_EVERY_MS, 5000),
    limitMs: positive(env.WECHAT_GUARD_LIMIT_MS, 30000),
  });
  const bridge = await import(pathToFileURL(env.WECHAT_BRIDGE_MODULE || '/app/bridge.mjs').href);
  await bridge.main(env);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}

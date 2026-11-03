// Runs real wake() rounds against the fake model, through the real model proxy, in local
// isolation. No key, no cost. Each tenant gets its own workspace/config/home under one temp root.
import http from 'node:http';
import {mkdirSync, mkdtempSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createLedger} from '../../ledger.mjs';
import {createModelProxy} from '../../model-proxy.mjs';
import {isolationFor} from '../../sandbox.mjs';
import {wake} from '../../runner.mjs';
import {scopeFor} from '../../scopes.mjs';
import {providerFor} from '../../providers.mjs';
import {startFakeModel} from './fake-model.mjs';

export const REAL_KEY = 'sk-real-key-never-in-the-cli';
export const PLUGIN_DIR = fileURLToPath(new URL('../../plugin', import.meta.url));
export const message = (text, direct = true) => ({kind: 'message', channel: 'web', direct, at: '2026-11-02T08:00:00+08:00', text});

export async function createHarness({limits = {perAccount: 1e9, total: 1e10}} = {}) {
  const fake = await startFakeModel();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'weave-run-')));
  const ledger = createLedger({file: join(root, 'usage.json')});
  const proxy = createModelProxy({keys: {deepseek: REAL_KEY}, upstreams: {deepseek: fake.baseUrl}, ledger, limits});
  const server = http.createServer(proxy.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${server.address().port}`;
  let tenants = 0;
  const tenant = () => {
    const dir = join(root, 't' + (++tenants));
    const dirs = {workspace: join(dir, 'workspace'), config: join(dir, 'claude'), home: join(dir, 'home')};
    for (const d of Object.values(dirs)) mkdirSync(d, {recursive: true});
    return dirs;
  };
  async function wakeOnce({scope = scopeFor('owner'), trigger = message('你好'), memory = '', dirs = tenant(), rpc = async () => ({ok: true, text: 'ok'}), sessionId, sandbox = false, account = 'u:test', image} = {}) {
    const run = proxy.openRun({account, provider: 'deepseek', model: 'deepseek-flash'});
    try {
      const isolation = isolationFor({mode: 'local', scope, dirs, pluginDir: PLUGIN_DIR, proxy: {url: proxyUrl}, sandbox});
      const result = await wake({scope, trigger, memory, provider: providerFor('deepseek'), model: 'deepseek-flash', runToken: run.token, isolation, rpc, sessionId, image});
      return {...result, dirs, runToken: run.token};
    } finally {
      run.close();
    }
  }
  const close = async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await fake.close(); };
  return {fake, ledger, root, proxyUrl, tenant, wakeOnce, close};
}

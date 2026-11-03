// 给 status.sh 用。翻 wx 守护进程的事件日志，打印最近一条 account.connection 事件：几个固定字段（状态、来源、服务码……）和时间，
// 不碰消息内容（字段的挑选和过滤和桥接写日志用的是同一个函数）。事件日志是守护进程记下「为什么掉线」的唯一地方，daemon.log 里没有。
// 用法：node last-connection-event.mjs <wx 程序> <守护进程地址> <令牌文件> <账号别名或 id>
// 一条都没有就什么都不打印；读不到（守护进程不在、事件太旧被清掉）就以非 0 退出。
import {execFileSync} from 'node:child_process';
import {eventFacts} from '../../hosted/wechat-bridge/bridge.mjs';

const [wx, server, tokenFile, account] = process.argv.slice(2);
// 每页最多 200 条（守护进程只收 1 到 200），从头翻，翻到没有新的为止；最多 50 页（1 万条）。
const page = after => JSON.parse(execFileSync(wx, ['--json', '--server', server, '--token-file', tokenFile, '--account', account, 'events', 'list', '--after', after, '--limit', '200'], {encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore']}));

let after = '0', latest = null;
for (let pages = 0; pages < 50; pages++) {
  const {items = [], nextCursor} = page(after);
  for (const event of items) if (event.kind === 'account.connection') latest = event;
  if (!items.length || nextCursor === after) break;
  after = nextCursor;
}
if (latest) console.log(`account.connection ${eventFacts(latest) ?? '（没有可显示的字段）'}（${latest.createdAt ?? '时间不详'}，事件号 ${latest.cursor}）`);

// 网站的定时任务（docs/ARCHITECTURE.md「主动性」）。代码只做基础设施的事，什么时候想、说不说都是 Weave 自己定：
//   1. 清掉过期的照片暂存；
//   2. wechatInbound：把排着的微信消息交给 Weave（不等它做完，wechat.mjs 的 processInboundSdk）；
//   3. proactive：把要看的人和群交给 Agent 服务的 /tick（每人这一分钟的通行证、模型、时区），由它把到点的闹钟、
//      该来的心跳推进各自的那段会话（hosted/agent-service/server.mjs）。闹钟是 Weave 自己用 schedule 定的。
// 以前代码自己做的都删了：到点原样发「提醒你：……」、按档位算「定期看看」、被忽略就不看、换日收尾、叫醒前先问 Jev。
import {Store} from './store.mjs';
import {processInboundSdk, wechatConfig} from './wechat.mjs';
import {agentServiceConfig, capabilityFor, modelOf} from './dispatcher.mjs';
import {GROUP_TIMEZONE} from './proactivity.mjs';
import {sweepPhotos} from './wechat-photos.mjs';

// 交给 Agent 服务的那份名单：用过 Weave 的人（聊过天或连了微信），和开着的打卡群。
export async function tickEntries(world, {secret, now = Date.now()}) {
  const entries = [];
  for (const [id, person] of Object.entries(world.people || {})) {
    if (!(person.messages?.length || person.settings?.wechatWxidHash)) continue;
    const channel = person.settings?.wechatWxidHash ? 'wechat' : 'web';
    entries.push({
      scope: 'owner', id, timezone: person.profile?.timezone || GROUP_TIMEZONE, heartbeat: true,
      capability: await capabilityFor(secret, {ownerId: id, channel, runId: crypto.randomUUID(), now}),
      ...(await modelOf(person, id, secret)),
    });
  }
  for (const [key, group] of Object.entries(world.runtime || {})) {
    if (!key.startsWith('wechat-group:') || !group?.ownerId || !world.people?.[group.ownerId]) continue;
    const groupId = key.slice('wechat-group:'.length);
    entries.push({
      scope: 'group', id: groupId, timezone: GROUP_TIMEZONE, heartbeat: false,
      capability: await capabilityFor(secret, {ownerId: group.ownerId, scope: 'group', groupId, channel: 'wechat', runId: crypto.randomUUID(), now}),
      ...(await modelOf(world.people[group.ownerId], group.ownerId, secret)),
    });
  }
  return entries;
}

export async function runScheduled({db, secret, env = {}, agentServiceUrl, agentServiceToken, fetcher = fetch, now = Date.now(), proactive = false, wechatInbound = true}) {
  if (!db) throw Error('Weave database is unavailable');
  // 微信看图暂存的照片，到期没用掉的删掉（最多 10 分钟）。开关关了以后也照样清，表不存在时什么都不做。
  await sweepPhotos(db, now);
  const service = agentServiceConfig(agentServiceUrl, agentServiceToken);
  let handed = 0, entries = 0;
  if (wechatInbound && wechatConfig(env).token && secret) {
    if (service) handed = await processInboundSdk({db, secret, service, fetcher, now});
    else console.error('Agent 服务没有配置好，微信消息先留在队列里。');
  }
  if (proactive && service && secret) {
    const list = await tickEntries(await new Store(db).load(), {secret, now});
    entries = list.length;
    if (list.length) {
      const response = await fetcher(service.url + '/tick', {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + service.token},
        body: JSON.stringify({entries: list}),
      });
      response.body?.cancel().catch(() => {});
      if (response.status !== 202) console.error('Agent 服务的 /tick 返回 ' + response.status);
    }
  }
  return {handed, entries};
}

// 本人在网页上看 Agent 自己记下的 MEMORY.md（docs/ARCHITECTURE.md 第 10 节：本人可看）。
// MEMORY.md 在 Agent 服务的工作目录里，Weave 服务只是转一次请求，不存副本。
import {fail} from './domain.mjs';

// 草稿文案，待确认。
const UNAVAILABLE = '暂时读不到 Agent 的记忆，请稍后再试';

export async function readAgentMemory({service, ownerId, fetcher = fetch}) {
  let out;
  try {
    const response = await fetcher(service.url + '/memory', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + service.token},
      body: JSON.stringify({scope: 'owner', id: ownerId}),
    });
    if (response.status === 200) out = await response.json();
  } catch {
    out = null;
  }
  if (typeof out?.text !== 'string') fail(UNAVAILABLE, 503);
  return out.text;
}

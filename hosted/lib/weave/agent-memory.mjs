// 本人在网页上看 Weave 自己记下的记忆（SDK 自带的记忆目录：MEMORY.md 索引加一件事一个文件）。
// 她 11-03：按文件显示，文件名 + 原文，只读。文件在 Agent 服务那边，网站只是转一次请求，不存副本。
import {fail} from './domain.mjs';

// 草稿文案，待确认。
const UNAVAILABLE = '暂时读不到 Weave 的记忆，请稍后再试';

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
  if (!Array.isArray(out?.files)) fail(UNAVAILABLE, 503);
  const files = out.files.filter(f => typeof f?.name === 'string' && typeof f.text === 'string');
  // text：给还按一整段显示的页面用（每个文件一段，文件名作标题）。
  return {files, text: files.map(f => `# ${f.name}\n\n${f.text}`).join('\n\n')};
}

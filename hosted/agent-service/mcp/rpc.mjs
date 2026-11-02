// 工具后端的调用方（docs/ARCHITECTURE.md 第 4 节规则 1、4）：MCP 工具只把参数转给 Weave 服务，
// 规则、授权和数据都在那边。通行证是 Weave 服务为这一轮签发的，这里只是带上。
// 草稿文案，待确认。
export const UNCERTAIN = '这一步的结果不确定（可能没有执行，也可能已经执行），不要重复调用，如实告诉对方。';

export function toolBackend({weaveUrl, capability, fetcher = fetch, timeoutMs = 15000}) {
  const base = weaveUrl.replace(/\/+$/, '');
  return async (name, args, toolUseId) => {
    try {
      const response = await fetcher(`${base}/api/internal/agent/tools/${encodeURIComponent(name)}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + capability},
        body: JSON.stringify({args, toolUseId}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) return {ok: false, text: UNCERTAIN};
      const out = await response.json();
      if (typeof out?.ok !== 'boolean' || typeof out.text !== 'string') return {ok: false, text: UNCERTAIN};
      return {ok: out.ok, text: out.text};
    } catch {
      // 超时或连不上时，后端可能已经执行了，所以不能说「没有执行」。
      return {ok: false, text: UNCERTAIN};
    }
  };
}

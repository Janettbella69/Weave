// 访问密码。单用户部署（WEAVE_VPS_MODE）里，谁打开网站都会被当成本人，所以在最前面加一道 Basic 认证。
// WEAVE_BASIC_AUTH 写成「用户名:密码」，不设就不拦。
// 只有自带验证的三个内部接口不拦（Agent 服务的通行证、微信桥接和后台判断的令牌），其余地址一律要密码。
const encoder = new TextEncoder();
const SELF_AUTHENTICATED = ['/api/internal/agent/tools/', '/api/internal/hermes/', '/api/internal/wechat/'];
const digest = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));

// 比较摘要，耗时和内容无关。
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function credentialsOf(request) {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return '';
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(header.slice(6).trim()), c => c.charCodeAt(0)));
  } catch {
    return '';
  }
}

export async function basicAuthGate(request, setting) {
  if (!setting) return null;
  const path = new URL(request.url).pathname;
  if (SELF_AUTHENTICATED.some(prefix => path.startsWith(prefix))) return null;
  const given = credentialsOf(request);
  if (given && sameBytes(await digest(given), await digest(setting))) return null;
  // 草稿文案，待确认。
  return new Response('需要输入 Weave 的访问密码。', {
    status: 401,
    headers: {'WWW-Authenticate': 'Basic realm="Weave", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'},
  });
}

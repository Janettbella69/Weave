// 在任何代码回答之前，先把请求体整个读进内存。
//
// 服务器上用 `wrangler dev` 当正式服务：请求先到 wrangler 的代理（ProxyWorker），再经复用的本机 HTTP 连接转给 Worker。
// Worker 没读完请求体就回了响应（访问密码的 401、接口的 413/415 等），这条连接上就留着没读的字节，代理那一次
// 或下一次转发会失败（本机实测约两到三成）。wrangler 4.92 再把失败报错：路径不是 / 的 POST 收到误导性的
// 503「Your worker restarted mid-request」，路径是 / 时 wrangler 整个进程退出。丢弃（cancel）请求体没有用，只有读完才行。
// 公网请求先过 nginx（client_max_body_size 1m），内部调用都是小 JSON，全读进内存没有问题。
export async function withBufferedBody(request) {
  if (!request.body) return request;
  return new Request(request, {body: await request.arrayBuffer()});
}

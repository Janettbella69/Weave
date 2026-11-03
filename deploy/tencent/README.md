# 把 Weave 部署到 43.162.107.53

这台机器同时跑着 Azora。Weave 用自己的 compose 项目 `weave`，里面两个服务：网站 `web` 和 Agent 服务 `agent`。Azora 的 nginx 把 `weave.azorashopping.site` 转发过来。

下面的命令都在你自己的 Terminal 里跑，按顺序来。凡是要在服务器上跑的，开头都带 `ssh`。

## 0. 改 DNS（只做一次）

在 DNSPod 里把 `weave` 这条 A 记录改成 `43.162.107.53`。生效后，下面这条应该打印出 `43.162.107.53`：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'getent hosts weave.azorashopping.site'
```

（在自己的 Mac 上查可能不准，因为本机的代理会改写 DNS 结果。）

## 1. 拿代码（只做一次）

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'git clone https://github.com/Janettbella69/Weave.git ~/weave && cd ~/weave && git checkout feat/deploy-tencent'
```

合进 main 以后，把最后的 `feat/deploy-tencent` 换成 `main`。

## 2. 生成配置（只做一次）

```
ssh -t -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/setup-env.sh'
```

它会问你的邮箱、名字和 DeepSeek Key，Key 输入时不显示。最后会打印网站的访问账号和密码，记下来。

配置写在 `~/weave/deploy/tencent/` 里的 `.env`、`web.env`、`agent.env`，权限 600，不会进 git。**`web.env` 要备份**：里面的 `WEAVE_ENCRYPTION_KEY` 丢了，之前存进去的钥匙就都解不开了。

## 3. 部署

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/deploy.sh'
```

第一次要几分钟：先下载约 300 MB 的 CLI，再在镜像里构建网站。最后看到下面两行就对了：

```
网站：HTTP 401（401 = 正常，正在要访问密码）
Agent 服务：{"ok":true}
```

## 4. 证书（只做一次，等第 0 步的 DNS 生效以后）

给 Weave 单独签一张证书。Azora 和 codememory 已有的证书都不碰：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'cd ~/AIAzora-v3 && docker compose -f docker-compose.prod.yml run --rm --entrypoint certbot certbot certonly --webroot -w /var/www/certbot -d weave.azorashopping.site --cert-name weave.azorashopping.site --non-interactive --agree-tos --register-unsafely-without-email'
```

看到 `Successfully received certificate` 就好了。之后 Azora 的 certbot 容器会自动给它续期。

## 5. 接入 Azora 的 nginx（只做一次）

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'cd ~/weave && git pull --ff-only && bash deploy/tencent/nginx-add-weave.sh'
```

看到「已加上 weave，nginx 已重载」就好了。这个脚本做的事：

- 只在 `~/AIAzora-v3/nginx.conf` 末尾追加 `weave.nginx.conf` 里的两个 server 块，Azora 和 codememory 原有的配置一行不动；
- 改之前先备份到 `~/weave-data/nginx-backups/`；
- 用正在跑的 nginx 检查新配置，通过才重载（不中断访问）；不通过就恢复原文件、不重载，Azora 不受影响。

**为什么不走 Azora 的部署流程：** 服务器上的 `nginx.conf` 有一处没进 git 的改动（当初 AML 编程版加的 codememory 配置），Azora 部署时的 `git checkout` 会因此失败。Azora 仓库的 PR #5 里有同样的两个 server 块，等以后把服务器上的那处改动理顺，再合并它。

**要撤掉 nginx 里的 weave：** 用最近一次备份恢复，再检查、重载：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'b=$(ls -t ~/weave-data/nginx-backups/* | head -1) && cat "$b" > ~/AIAzora-v3/nginx.conf && cd ~/AIAzora-v3 && docker compose -f docker-compose.prod.yml exec -T nginx nginx -t && docker compose -f docker-compose.prod.yml exec -T nginx nginx -s reload'
```

## 6. 打开网站

打开 https://weave.azorashopping.site ，浏览器会弹出账号密码框，填第 2 步打印的那组。

## 接入微信（可选，试点）

微信通道的两个程序（wx 守护进程和桥接）跑在你自己的 Mac 上，只向外连接这个网站；服务器这边只多一个 `WECHAT_BRIDGE_TOKEN`。整套步骤（装、配令牌、扫码、验证、回退、该警惕的征兆）在 [`deploy/wechat-mac/README.md`](../wechat-mac/README.md)。

服务器这边只涉及一件事：`web.env` 里的 `WECHAT_BRIDGE_TOKEN` 和 `WEAVE_AGENT_RUNTIME=sdk`。Mac 上的 `set-token.sh` 会经 ssh 调用本目录的 `set-wechat-token.sh`，替你写好令牌并重新部署，不用手动改。要关掉微信通道：Mac 上跑 `bash deploy/wechat-mac/set-token.sh --remove`。

## 以后更新

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'cd ~/weave && git pull && bash deploy/tencent/deploy.sh'
```

## 停掉或回退

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'cd ~/weave/deploy/tencent && docker compose down'
```

这条只停 `weave` 项目里的两个容器，数据都留着，Azora 不受影响。**不要加 `-v`**，加了会把网站的数据库一起删掉。

想退回旧的聊天方式，把 `web.env` 里的 `WEAVE_AGENT_RUNTIME=sdk` 删掉，再跑一次 `deploy.sh`。

## 东西都在哪

| 什么 | 在哪 |
| --- | --- |
| 网站的数据库 | docker 卷 `weave_web-state` |
| Agent 的工作目录、MEMORY.md、额度账本 | `~/weave-data/agent` |
| 配置和钥匙 | `~/weave/deploy/tencent/.env`、`web.env`、`agent.env` |

## 内存

这台可用内存约 2.2 GB，Azora 也要用。所以 Weave 同时只跑 1 轮，网站最多 768 MB，Agent 服务最多 384 MB，每轮的一次性容器最多 768 MB。

## 页面偶尔卡 5～25 秒

现象：网站日志里偶尔有 `GET /api/status 200 OK (25008ms)` 这样的一行，页面这时发不出消息。原因：页面每 5 秒拉一次状态，而网站里 wrangler 的代理和网站程序之间有一条闲了约 5 秒就被关掉的连接，
拉取正好撞上时转发会失败；wrangler 4.92.0 把这个 GET 挂起来，等下一个请求才放出去，Chrome 又把同一地址的后续拉取扣在浏览器里 20 秒，于是最常见的是 5 + 20 = 25 秒。
镜像构建时已经打上补丁（`hosted/scripts/patch-wrangler-proxy.mjs`），被掐断的 GET 会马上重试。要确认补丁在起作用（都是只读命令）：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'docker logs weave-web-1 2>&1 | grep -c "weave patch"'
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'docker logs weave-web-1 2>&1 | grep -E "\([0-9]{5,}ms\)" | tail'
```

第一条是补丁救回来的次数（不是 0 就说明它在工作，每一次原来都会卡 5 秒以上）；第二条列出超过 10 秒的请求，修好以后不应该再有新的。

## 网站一直 502

现象：网站一直 502，`weave-web-1` 却显示在运行。原因：wrangler 底下的 workerd 进程内存越用越多，容器到了 768 MB 上限时被内核杀掉，而 wrangler 不会跟着退出，Docker 以为容器没事，不会重启它（2026-11-03 出过一次，持续约一个半小时；内存为什么涨还没查清楚）。

现在容器里有个看门狗（`hosted/scripts/web-watchdog.sh`）：每 10 秒请求一次本机的网站，网站第一次回答以后开始盯着；之后连续 3 次没有正常回答，就让 wrangler 退出，Docker 会自动把容器重新拉起来。它还每 5 分钟在日志里记一行内存。看它做过什么、内存怎么涨（都是只读命令）：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'docker logs -t weave-web-1 2>&1 | grep "weave watchdog"; docker inspect -f "自动重启过 {{.RestartCount}} 次" weave-web-1'
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'docker logs -t weave-web-1 2>&1 | grep "weave memory" | tail -30'
```

第二条每行带时间：`容器` 是整个网站容器占的内存（含文件缓存，比 `docker stats` 的数字高一些），`workerd` 是所有 workerd 进程加起来占的内存，有两个时括号里分开列（11-03 那两次，被杀的 workerd 都涨到了四百 MB 上下）。

网站 502 超过五分钟还没好，就手动重启网站容器，数据不会丢：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'docker restart weave-web-1'
```

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

把 Azora 现有的证书扩成也包含 `weave.azorashopping.site`：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'cd ~/AIAzora-v3 && docker compose -f docker-compose.prod.yml run --rm --entrypoint certbot certbot certonly --webroot -w /var/www/certbot --cert-name azorashopping.site -d azorashopping.site -d www.azorashopping.site -d weave.azorashopping.site --expand --non-interactive'
```

看到 `Successfully received certificate` 就好了。万一失败，原来的证书原样不动，Azora 不受影响。

## 5. Azora 的 nginx（只做一次）

1. **先测新配置。** Azora 的部署在 nginx 重载失败时会重启 nginx，配置有错 Azora 就会挂，所以一定先测。下面这条用一个一次性的 nginx 容器检查，不碰正在跑的 nginx：

   ```
   ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'cd ~/AIAzora-v3 && git fetch -q origin feat/weave-subdomain && git show origin/feat/weave-subdomain:nginx.conf > /tmp/nginx-weave-test.conf && docker run --rm --network aiazora-v3_web --add-host host.docker.internal:host-gateway -v ~/AIAzora-v3/certbot/conf:/etc/letsencrypt:ro -v ~/AIAzora-v3/certbot/www:/var/www/certbot:ro -v /tmp/nginx-weave-test.conf:/etc/nginx/nginx.conf:ro nginx:alpine nginx -t'
   ```

   最后看到 `syntax is ok` 和 `test is successful` 才往下走。
2. 合并 Azora 仓库里加 Weave 转发的那个 PR（AIAzora-v3 #5）。它只加了 `weave.azorashopping.site` 的两个 server 块，Azora 原有的配置一行不动。
3. 部署 Azora：GitHub 上打开 AIAzora-v3 → Actions → deploy → Run workflow，`deploy_ref` 选 `feat/ai-styling`。部署时会重建 Azora 的后端，**Azora 会断一两分钟**，挑人少的时候。部署最后会自动重载 nginx。

## 6. 打开网站

打开 https://weave.azorashopping.site ，浏览器会弹出账号密码框，填第 2 步打印的那组。

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

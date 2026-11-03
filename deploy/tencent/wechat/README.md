# 把微信客户端和桥接搬到服务器上（试点）

这个目录让微信通道的两个程序——wx 守护进程（agent-wechat 1.3.3）和 Weave 的微信桥接——跑在服务器 43.162.107.53 上，不再跑在你的 Mac 上：

```text
微信 ⇄ wx 守护进程（容器 wechat-wx-1，在自己的网络里，只听那里的 127.0.0.1:6179）⇄ 微信桥接（容器 wechat-bridge-1，用 wx 的网络）⇄ https://weave.azorashopping.site（同一台服务器）
```

**合并这个 PR 不会启动任何东西。** 第 1 节的命令要你自己一步一步跑；跑之前，Mac 上的那一套照常工作。试点中出现第 2 节的任何一个信号，就停掉服务器这边、退回 Mac。

## 0. 先说清楚：这改变了什么

**为什么搬：** 你的原话：「总不能用户所有的图片和数据都存在我的 mac 上吧 这很离谱啊」。现在小号收到的东西都存在你 Mac 的 `~/.weave-wechat` 里；搬过去以后，你的 Mac 就不在这条链路上了，Mac 睡着、关机也不影响助理。

**代价，直说：别人的微信消息和图片以后存在这台服务器上，这台服务器同时跑着 Azora。** 具体是：

- wx 和电脑版微信一样，保存小号收到和发出的**所有**消息（包括你和助理的私聊、助理的回复）、联系人、群和群成员名单，可能还有头像和昵称，**包括没开打卡群的群**。Weave 自己会把没开启的群的消息直接丢掉，但 wx 这一层不会。
- 语音和图片、视频的缩略图**总是**下载；**50 MB 以内**的图片、视频和文件默认也会自动下载（agent-wechat 文档：Settings → Automatic downloads）。
- wx 自己的事件记录也在同一个卷里；登录用的二维码图片登录时暂存在那里，login.sh 登录完就删；容器的运行日志在 Docker 的日志文件里（每个容器最多 30 MB）。
- **不会自动删除**：agent-wechat 没有保留期。`stop.sh` 只是停，数据都还在；只有 `stop.sh --delete-data` 才删（第 2 节最后一步）。
- 存在 docker 卷 `wechat_wx-data` 里。**谁读得到：** 这台服务器的 root，和任何能用这台服务器上 Docker 的人或程序——包括 ubuntu 这个账号，和 Weave 的 Agent 服务容器 `weave-agent-1`（它挂着 `/var/run/docker.sock`，能用 Docker 就能读任何卷）。Azora 的容器有没有挂 docker.sock，我没查。
- 这台服务器按 IP 查在美国加州（腾讯云），和 Azora 共用。

**隐私说明要补一段。** 我没有改页面，等你定了措辞，再改 `hosted/app/privacy/page.tsx` 的「微信和打卡群」一节和 `docs/WECHAT.md`：

> 新文字（请确认）：微信小号的客户端运行在我们的一台服务器上（腾讯云，位于美国加州；这台服务器同时运行着我们的另一个项目 Azora）。和电脑版微信一样，它会保存小号收到和发出的所有消息——包括你和助理的私聊、助理的回复，以及小号所在的群里的消息（没有开启打卡群的群也一样）——还有联系人和群成员名单，可能还有头像和昵称。语音和图片、视频的缩略图总是会下载保存，50 MB 以内的图片、视频和文件也会自动下载保存。它自己的事件记录和运行日志也在这台服务器上，登录用的二维码图片在登录时暂存在那里。这些不会自动删除：客户端停掉以后仍然保留，直到我们执行删除。这台服务器的管理员，以及任何能使用它上面 Docker 的人或程序，都能读取这些数据。上面说的「直接丢弃，不留任何记录」指的是 Weave 本身，不包括这个客户端。

现在跑在你 Mac 上时，这些东西也都存着，隐私说明里也没写；搬到服务器上以后更该写清楚。

## 1. 试点：一步一步

**前提：** 这个 PR 已经合并进 `feat/deploy-tencent`；网站已经在这台服务器上跑着（`deploy/tencent/README.md` 第 0 到 6 步）；网站的 `web.env` 里有 `WECHAT_BRIDGE_TOKEN`（你在 Mac 上跑过 `set-token.sh` 就有）。挑一个没人找助理的时间。

**第 0 步：在腾讯云控制台看一眼安全组。** 找到这台服务器（43.162.107.53）→ 安全组（轻量应用服务器叫「防火墙」）→ 入站规则：不能有放行 8050 到 8100 的规则，也不能有「全部端口、所有来源」的规则。有的话先删掉。原因见第 8 节：遇到「同一局域网」检查时，wx 会临时开这段里的一个端口。现在 wx 在自己的网络里，外面本来就连不到它；查安全组是多一道保险。

下面的命令都在你 Mac 的终端（Terminal）里跑。

**第 1 步：更新服务器上的代码。**（Mac 照常工作）

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'cd ~/weave && git pull --ff-only'
```

**第 2 步：在服务器上把 wx 起来，还不登录。**（Mac 照常工作；第一次要下载约 260 MB，一两分钟。桥接用的镜像也在这一步下载好）

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/up.sh'
```

最后看到这一行就对了：

```
wx 守护进程正常：版本 1.3.3，只听它自己网络里的 127.0.0.1:6179（外网和服务器上别的程序都连不到），内存上限 256 MB。
```

**第 2 步之后再看两眼**（只读，各跑一次就行；这时 Mac 还照常工作）：

(a) 启动桥接时不会动 wx。这条只演练、不真的做（`--dry-run`），用的是 login.sh 启动桥接的同一组参数：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'cd ~/weave/deploy/tencent/wechat && docker compose -p wechat up -d --force-recreate --no-deps --dry-run bridge'
```

每行开头是 `DRY-RUN MODE`；里面只应该有 `wechat-bridge-1`，不应该有 `wechat-wx-1` 的 Recreate、Stop 或 Remove。出现了就先别往下做，把输出发给 Claude。要是说不认识 `--dry-run`，是 docker compose 太旧（2.20 以后才有），把 `docker compose version` 的结果发给 Claude。

(b) wx 的网络和服务器所在的私有网络（VPC）不重叠：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'docker network inspect wechat_default --format "{{range .IPAM.Config}}{{.Subnet}} {{end}}"; ip -4 -o addr show scope global'
```

第一行是 wx 网络的网段（比如 `172.18.0.0/16`），下面几行是服务器自己的地址，`eth0` 那行是它在私有网络里的地址（比如 `10.206.0.12/20`）。再到腾讯云控制台看这台服务器所在私有网络的网段（私有网络 → 这个 VPC → IPv4 CIDR）。wx 网络的网段不能和私有网络的网段、`eth0` 的地址有重叠（比如私有网络是 `172.16.0.0/12`，它就包含 `172.18.0.0/16`，算重叠）。重叠了就先别往下做，告诉 Claude。

**第 3 步：停掉 Mac 上的那一套。从这一步开始，助理不在线。**

```
bash ~/weave-wechat/deploy/wechat-mac/stop.sh
```

**不要加 `--logout`**：万一服务器登录不上，Mac 多半还能用原来的登录直接接着跑，不用重新扫码（第 2 节）。两边同时跑会抢着收发同一个小号的消息，所以一定先停 Mac，再做第 4 步。

**第 4 步：在服务器上扫码登录，启动桥接。**

```
ssh -t -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/login.sh'
```

一定要带 `-t`。它先问你：

```
开始之前确认一件事：你的 Mac 上已经跑过 bash ~/weave-wechat/deploy/wechat-mac/stop.sh 了吗？
停了就输入「已停」再回车，别的输入都算没停：
```

第 3 步做完了，就输入 `已停` 再回车（输入别的，它什么都不做就退出）。服务器看不到你的 Mac，所以要你亲口确认。然后它从 wx 的网络里试一下连不连得上 Weave、Weave 认不认网站的桥接令牌（不通过就什么都不做），接着出现：

```
======================================================
  用小号扫这个二维码
======================================================
```

下面紧跟着二维码。拿**小号**的手机：微信右上角「+」→「扫一扫」→ 扫屏幕上的二维码 → 手机上会出现确认登录的页面，点「登录」（页面上写的设备名是什么，没见过）。手机用平时的网络就行。二维码 5 分钟内有效，过期了会自动换新的。服务器登录成功以后，Mac 上原来那次登录多半会被微信顶下线：没关系，Mac 那边已经停了（但这也意味着之后要退回 Mac，多半得在 Mac 上重新扫码）。

终端里的二维码扫不出来：按 Ctrl-C，改用图片（也带 `-t`，这样按 Ctrl-C 时脚本能替你取消服务器上的这次登录，见第 8 节）：

```
ssh -t -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/login.sh --png'
```

它会打印一条 `scp` 命令；在 Mac 上另开一个终端窗口跑那条，图会存到桌面并打开，用小号扫。登录完把桌面上的那张图删掉。

**第 5 步：成功是什么样子。** 脚本最后几段是：

```
小号登录成功。（Mac 上原来那次登录多半会被微信顶下线，没关系，Mac 那边已经停了。）
……
桥接连上了 wx 和 Weave。再看它 10 秒……
桥接已启动，连上了 wx 和 Weave。
旧的桥接密钥作废了 0 把，新的那把留着。
```

接着打印状态：两个容器都是「运行中」，`桥接这次启动以来：wx 连上了，Weave 连上了`，小号一行是 `weave：已登录，连接：在线`。

桥接没连上 wx 或 Weave、或者连上以后又停了，脚本会停下来、打印桥接的日志，**不作废旧密钥**，并告诉你怎么办：修好后重跑 login.sh，或者照第 2 节退回 Mac。

**第 6 步：发一句试试。** 用你的**主号**给小号发「你好」，一两分钟内应该有回复；Weave 网页的聊天记录里也能看到这一来一回。**不用重新绑定**：Weave 记的是你主号的微信号（存的是哈希），和小号在哪台机器上登录无关（读代码得出：`hosted/lib/weave/wechat.mjs` 第 71 行；没实测）。

**第 7 步：看 24 小时。** 每天跑一次第 4 节的 status.sh，第一个小时按第 5 节量内存。**别反复重新扫码。**

## 2. 停的信号，马上退回 Mac

出现任何一个，就停下来，不要再扫码：

- 手机上要你做**身份验证**（人脸、短信、好友辅助验证之类）；
- 手机上弹出「**设备网络环境异常**」「安全保护中」「扫码登录其他设备功能受限」（agent-wechat 的 [issue #168](https://github.com/thisnick/agent-wechat/issues/168) 里有人在 Linux 服务器上遇到过）；
- 终端里出现 `WeChat requires a local network check`，或者手机上点了登录以后**一直转圈**、批准一直不到：这是「同一局域网」检查。agent-wechat 的文档说，有的批准需要手机连到守护进程（端口 8050 到 8100），服务器和你的手机不在一个网络里，过不了；
- 脚本说「微信拒绝了这次登录」「同一局域网检查」或「微信要你在手机上多做一步」；
- 登录以后几个小时内小号又掉线（status.sh 里写「没登录」）。

**马上退回 Mac（都在你 Mac 的终端里跑）：**

1. 如果第 4 步还停在二维码那里，先按 Ctrl-C。然后停掉服务器这边，并让小号在服务器上退出登录：

   ```
   ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/stop.sh --logout'
   ```

2. 在小号的手机微信里：「我」→「设置」→「账号与安全」→「登录设备管理」，看到服务器那台就删掉（认不出是哪台就先不动）。
3. 在 Mac 上重新开（原来没用 `--keep-awake` 就去掉它）：

   ```
   cd ~/weave-wechat && bash deploy/wechat-mac/install.sh --keep-awake && bash deploy/wechat-mac/login.sh
   ```

   如果服务器那边从来没登录成功，Mac 多半会直接说「小号已经登录着，跳过扫码」；服务器登录成功过的话，Mac 上原来的登录多半已经被顶掉，要你扫码，就照 `deploy/wechat-mac/README.md` 第 2.3 节扫（手机和 Mac 连同一个 Wi-Fi）。
4. 24 小时内别再试服务器。
5. **只有决定不搬了，才做这一步。** 删掉服务器上的微信数据：小号在服务器上的登录、聊天记录、联系人、图片，桥接的配置。只删这个项目的，网站和 Azora 的不碰。

   ⚠ **删了不能恢复。** 以后再想搬到服务器，要从第 2 步重来、重新扫码。

   ```
   ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/stop.sh --delete-data'
   ```

## 3. 停机多久，停机时的消息

从第 3 步（停 Mac）到第 4 步结束，助理不在线：一般 5 到 15 分钟（我的估计，没实测；镜像在第 2 步已经下载好了）。

这段时间别人发给小号的消息，手机上都看得到，但服务器上的助理**很可能收不到**：微信不会把旧消息发给新登录的设备（agent-wechat 文档：新登录只从新消息开始）。做完可以请朋友再发一次。

**位置标记（cursor）从头开始：** 服务器上的桥接是新的，只处理服务器登录以后收到的消息；Mac 上的 `~/.weave-wechat/state/cursor.json` 不用搬。

## 4. 每天看一眼

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/status.sh'
```

它显示：两个容器在不在跑、自动重启过几次、有没有因为内存超了被杀；桥接这次启动以来连没连上 wx 和 Weave；小号登没登录；四个容器（wx、桥接、网站、Agent 服务）现在各用多少内存；wx 和桥接启动以来最多用过多少；整台机器还剩多少；最近的日志。只读，不显示任何令牌。

发送上限和 Mac 那套一样（`deploy/wechat-mac/README.md` 第 4 节）。要改：在服务器的 `~/weave/deploy/tencent/wechat/bridge.env` 里取消注释那几行、改数字，再重跑第 4 步的 login.sh（已经登录就不会再扫码；它每次都会问你「已停」）。

桥接的日志（每行带时间，不含令牌和消息内容）：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'docker logs --tail 50 wechat-bridge-1'
```

**服务器重启以后：** 两个容器都设了自动重启，但桥接要等 wx 先起来（它用 wx 的网络），Docker 不一定按这个顺序拉起它们（没验证）。重启后跑一次 status.sh；桥接是「停着」，就跑：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'docker start wechat-bridge-1'
```

## 5. 内存：第一个小时怎么量，怎么加

这台机器总共约 3.6 GB，Azora 也在用。每个容器有**自己的**上限：

| 容器 | 上限 |
| --- | --- |
| `weave-web-1`（网站） | 768 MiB |
| `weave-agent-1`（Agent 服务） | 384 MiB |
| 每轮的一次性 Agent 容器（同时最多 1 个） | 768 MiB |
| `wechat-wx-1`（新） | 256 MiB，可以调 |
| `wechat-bridge-1`（新） | 128 MiB |

wx 登录以后占多少内存，没人量过（Mac 上没登录时约 18 MB），256 MiB 是先给的。

一个容器到了自己的上限，只有它自己被杀，别的容器不受影响。例：11-03 13:33（UTC）左右，网站容器又到了 768 MiB 的上限（一个 workerd 占了 439 MiB），看门狗约 2 分钟内把它重启了。这段时间桥接连不上网站，会过一会儿再试：收到的消息没送到就不往下读，送出去的消息留在队列里，都不会丢。wx 和桥接的上限和网站的分开算，不会因为网站被杀而被杀。整台机器的内存用光时，内核先杀 `oom_score_adj` 高的（Weave 的容器和这两个都是 500），Azora 排在后面。网站自己的内存记录见 `deploy/tencent/README.md`「网站一直 502」。wx 被杀、Docker 把它重启以后，桥接会在 30 秒内自己跟着重启（第 8 节）。

**第一个小时：** 登录后每隔 10 到 15 分钟跑一次 status.sh；或者开着下面这条看实时数字（按 Ctrl-C 退出）：

```
ssh -t -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'docker stats wechat-wx-1 wechat-bridge-1 weave-web-1 weave-agent-1'
```

看三样：

- `wechat-wx-1` 那一行的 `MEM %`（现在用了上限的多少），和 status.sh 里「wx 守护进程 启动以来最多用过」；
- status.sh 里「因为内存超了被杀」是不是变成了「被杀过」，「自动重启过」的次数是不是在涨；
- status.sh 里「整台机器 还能用」是不是一直往下掉。

**什么时候加：** wx 最多用过的超过上限的八成（约 200 MiB），或者被杀过，就加到 384 MiB（小号不用重新登录；wx 会换一个新容器，正在跑的桥接跟着重建）：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/up.sh --wx-mem 384m'
```

可以填 128m 到 1024m。整台机器「还能用」只剩几百 MB 时先别加，告诉 Claude。（「八成」和「几百 MB」是我定的，不是测出来的。）

## 6. 稳定很久以后，再清掉 Mac 上的数据

服务器这边连续两周以上（我的建议）没出现第 2 节的信号，再清 Mac。**在那之前，除了第 2 节的回退，别在 Mac 上跑 `install.sh`**：Mac 上的守护进程会拿旧的登录去连微信，可能把服务器那边挤下线。也别再用 Mac 上的 `set-token.sh`：它会换掉网站的桥接令牌，服务器的桥接就连不上了。

只清两样：小号在 Mac 上的数据，和 launchd 配置。**`~/weave-wechat` 这份代码留着**：退回 Mac 要用里面的脚本。

在 Mac 上：

```
bash ~/weave-wechat/deploy/wechat-mac/stop.sh --uninstall
```

确认 launchd 里没有它了，下面两条都应该什么都不打印：

```
launchctl list | grep com.weave.wechat
ls ~/Library/LaunchAgents | grep com.weave.wechat
```

然后删掉本机的数据（小号的旧登录、聊天记录、图片、日志）：

```
rm -rf ~/.weave-wechat
```

**清完以后再想退回 Mac**，就是从头装一遍、重新扫码：`cd ~/weave-wechat && bash deploy/wechat-mac/install.sh --keep-awake && bash deploy/wechat-mac/login.sh`（手机和 Mac 连同一个 Wi-Fi），还要先把服务器这边停掉（第 2 节第 1 步）。

不用加 `--logout`：它要 Mac 的守护进程开着才起作用，而服务器登录的时候已经顶替了 Mac 的登录。在小号手机的「登录设备管理」里能认出 Mac 那台就删掉，认不出就不动（别删了服务器那台）。

**时间机器（Time Machine）：** 如果开着，旧的备份里可能还有 `~/.weave-wechat`（别人的消息和图片）；删了本机的，不会删备份里的。先看有没有备份盘：

```
tmutil destinationinfo
```

打印 `No destinations configured` 就是没有，不用管。有的话，备份里那份要不要删、怎么删，另外问 Claude（新版 macOS 能不能只删一个文件夹的备份，我没核实）。

## 7. 东西都在哪，常用命令

| 什么 | 在哪 |
| --- | --- |
| 小号的登录、聊天记录、联系人、收到的图片和文件，wx 的事件记录和主令牌 | docker 卷 `wechat_wx-data`（容器里的 `/var/lib/agent-wechat`） |
| wx 的临时快照 | docker 卷 `wechat_wx-scratch` |
| 桥接读到哪儿了 | docker 卷 `wechat_bridge-state` |
| 桥接的配置和令牌 | `~/weave/deploy/tencent/wechat/bridge.env`（权限 600，不进 git） |
| wx 的内存上限（改过才有） | `~/weave/deploy/tencent/wechat/.env` |
| 日志 | `docker logs wechat-wx-1`、`docker logs wechat-bridge-1`（每个最多留 3 个 10 MB 的文件） |

**wx 的主令牌**是守护进程第一次启动时自己生成的（agent-wechat 文档：API tokens），在卷里，权限 600，只有容器里的用户读得到。脚本都用 `docker exec` 在容器里调 wx，令牌不离开容器。桥接用的是另一把只能读和发的密钥，由 login.sh 建，写在 `bridge.env` 里。

**桥接外面那层 `bridge-guard.mjs`：** 桥接本身（`hosted/wechat-bridge/bridge.mjs`）一行没改，容器里先跑的是这一层，它做两件事：wx 30 秒连不上就退出，让 Docker 把桥接重新拉起来、加入 wx 现在的网络（第 8 节）；桥接第一次连上 wx、第一次连上 Weave 时各打一行日志，login.sh 和 status.sh 靠这两行判断它是不是真的通了。

**为什么服务器上的桥接还设 `WEAVE_TICK=1`：** PR #35 以后，Agent 服务每分钟会敲一次网站的 `/api/internal/tick`（服务器自己的闹钟），但那一下只管到点的提醒和后台主动找你，**故意不处理微信消息**（`hosted/lib/weave/api.mjs` 里是 `wechatInbound:false`，注释写明留给桥接）。回复微信靠的还是桥接每分钟调一次的 `/api/internal/wechat/tick`，以及消息一到就叫醒 Agent 的快路，这两样都要 `WEAVE_TICK=1`。所以服务器上的桥接照样设它（login.sh 会写好）；去掉的话，消息收得到，但永远不会有回复。两个闹钟都会送到点的提醒，但一条提醒只会送一次：标记「已送出」是在一次事务里做的，撞上了就重读再来（`domain.mjs` 的 `deliverReminders`、`store.mjs` 的 `withWorld`；读代码得出，没实测）。

**手动给 wx 下命令：**

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/wx.sh --json accounts list'
```

**少存一点别人的东西（可选）：** 把自动下载调成 0，以后只自动存缩略图和语音（只对新收到的附件起作用，已经存下的不删）：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'bash ~/weave/deploy/tencent/wechat/wx.sh --json --account weave account settings --auto-download-max-mb 0'
```

**看图（PR #33，默认关）：** 它只读守护进程已经存好的副本：先找标准图，没有才用缩略图（`bridge.mjs`）。自动下载调成 0 以后标准图不会自动存，所以多半只剩缩略图（没在真机上试过）。照片只在桥接的内存里放 60 秒，不写磁盘（实际上限约 1 MB，见 `docs/WECHAT.md`）。Mac 那套的 `images.sh` 在服务器上不用，改成这样：

- 打开（先开桥接，再开网站）：在 `bridge.env` 里加一行 `WEAVE_WECHAT_IMAGES=1`，重跑 login.sh（会换一把带 media 权限的密钥）；再在网站的 `web.env` 里加 `WEAVE_WECHAT_IMAGES=1`，重新部署。
- 关掉（先关网站，再关桥接）：删掉 `web.env` 里那一行、重新部署；再删掉 `bridge.env` 里那一行，重跑 login.sh（换回只能读和发的密钥）。

要先确认的新文字和打开以后的真机检查，照 `docs/WECHAT.md`「看图（默认关闭）」。不打开就什么都不变。

**换网站的桥接令牌：** 在服务器上生成新的（不显示，网站会重新部署），再重跑 login.sh：

```
ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'openssl rand -hex 32 | bash ~/weave/deploy/tencent/set-wechat-token.sh'
```

**更新桥接的代码：** 第 1 步的 `git pull` 以后，桥接要重建才用上新代码：重跑 login.sh。

**升级 agent-wechat：** 改 `compose.yml` 里 wx 的 `image`（tag 和 digest）、本目录 `lib.sh` 的 `WX_VERSION` 和 `WX_IMAGE_DIGEST`、`deploy/wechat-mac/lib.sh` 的 `WX_VERSION`（测试会核对它们一致），先在模拟微信上跑一遍 [`scripts/agent-wechat-e2e`](../../../scripts/agent-wechat-e2e/README.md)，再跑 up.sh。桥接的 Node 镜像也钉了 digest（`compose.yml` 和 `lib.sh` 的 `BRIDGE_IMAGE`），升级时两处一起改。

## 8. 网络：为什么这样连

**wx 在自己的网络里。** wx 用 compose 给这个项目建的网络 `wechat_default`，没有对外的端口：它能往外连微信，外面连不进来。服务器上**只绑在 127.0.0.1** 的服务，它碰不到。但绑在 0.0.0.0、或者绑在 docker0 / 网关地址上的服务，它照样能经过宿主连到：比如 Azora 对外发布的端口，和 Weave 网站的 4317（绑在 docker0 的地址上，就是 `~/weave/deploy/tencent/.env` 里的 `WEAVE_BIND_IP`）。连到以后能做什么，看那些服务自己的密码和令牌（Weave 网站要访问密码，内部接口要令牌；Azora 的我没查）。wx 自己只听这个网络里的 127.0.0.1:6179（agent-wechat 只肯听 127.0.0.1：源码里写死了 `--listen must be loopback`），服务器上别的程序也连不到。

**桥接用 wx 的网络**（`network_mode: service:wx`）：它在那里的 127.0.0.1:6179 找到 wx，往外连 Weave 也走那里。

**wx 重启以后桥接怎么办。** wx 每次重启（比如内存超了被杀、Docker 把它拉起来）都会换一个新的网络，正在跑的桥接还留在旧的里面：连不上 wx，也连不上 Weave。所以桥接外面包了一层 `bridge-guard.mjs`：每 5 秒试一下能不能连上 127.0.0.1:6179，连续 30 秒连不上就退出；桥接也设了自动重启，Docker 重新拉起它时，它会加入 wx 现在的网络。也就是说，wx 重启以后，桥接最多晚 30 多秒自己恢复，收发不会丢（没送到的消息会重来）。另外两种情况由脚本处理：wx 因为配置改了被换成新容器（比如 `up.sh --wx-mem`），up.sh 会把正在跑的桥接一起重建；login.sh 每次都重建桥接。

**Weave 的连法。** 桥接经公网地址 `https://weave.azorashopping.site` 连回同一台服务器上的 Weave（bridge.mjs 只认 HTTPS）。login.sh 在扫码前，先用桥接的镜像在 wx 的网络里起一个用完就删的小容器试一下这条路通不通。

**云服务器的元数据地址。** 从这个网络往外连，大概率也能连到腾讯云的实例元数据服务（`http://metadata.tencentyun.com`，我记得 IP 是 169.254.0.23，没在这台上核实）。如果这台实例绑了 CAM 角色，那里能拿到这个角色的临时密钥；没绑就只有实例信息（这台绑没绑，我没查）。**这个 PR 挡不住它**：compose 里的 `extra_hosts` 只能改名字解析，挡不住直接用 IP；改路由要给容器网络管理的特权；把网络设成 `internal` 会连微信和 Weave 一起断掉。要挡只能在服务器上加防火墙规则（Docker 的 `DOCKER-USER` 链），这个 PR 没加。之前用宿主网络时也一样连得到；wx 和桥接都不访问它。

**「同一局域网」检查开的端口。** 遇到这个检查时，wx 会在这次登录期间开 8050 到 8100 里的一个端口（agent-wechat 源码 `lan_login.rs`），监听它所在网络的所有地址。现在 wx 在自己的网络里，又没有对外的端口，外面连不到它；第 1 节第 0 步再让安全组也挡住，多一道保险。

**`--png` 时按 Ctrl-C。** 容器里的这次登录是用不带 `-t` 的 `docker exec` 跑的，Ctrl-C 传不进容器。所以：

- 带了 `ssh -t`：login.sh 自己收到 Ctrl-C，会替你重启 wx，取消服务器上的这次登录（小号还没登录上，重启不丢东西）。
- 没带 `-t`：Ctrl-C 只断开你的 ssh，服务器上的这次登录（连同上面那个端口）会一直等到二维码过期才结束，最多二十来分钟（二维码 5 分钟一换，最多换 3 次；没实测）。要马上停，就跑：

  ```
  ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'docker restart wechat-wx-1'
  ```

  要退回 Mac 的话，直接跑第 2 节第 1 步的 `stop.sh --logout` 也行（它把 wx 整个停掉）。

## 9. 还没验证的事

- 服务器上登录真实微信：没试过。会不会出现同一局域网检查、机房 IP 会不会招来风控，都没有数据。
- wx 登录以后占多少内存：没量过。
- 新登录会不会补收最近几条消息：文档说不会；要是会，助理可能把停机前已经回过的消息再回一次。
- 绑定不用重做：读代码得出，没实测。
- 手机上确认登录的页面写的是什么设备：没见过。
- wx 重启以后桥接自己恢复：`bridge-guard.mjs` 用本机的假服务测过（连不上就退出），真的在 Docker 里重启 wx 没试过。服务器重启以后桥接能不能自己起来，也没试过（第 4 节有补救的命令）。
- 从 wx 的网络连回同一台服务器的公网地址（绕出去再回来）：没试过；login.sh 扫码前会先试，不通就停。
- 这些脚本没在服务器上跑过；测试用的是假的 docker 和 wx，`docker compose config` 和 shellcheck 在 CI 上跑。
- 两个镜像的 digest 都是 2026-11-03 查的：wx 从 ghcr.io（镜像里写的版本是 1.3.3、源码提交 7d4da1cb，就是上游 v1.3.3 这个 tag），Node 从 Docker Hub（`node:22-alpine`，Node 22.23.4）。

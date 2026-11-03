# 把 Weave 的微信接上：跑在你自己的 Mac 上，最后只差用小号扫码

微信通道由两个程序组成，都跑在你的 Mac 上，只向外连接：

```text
微信 ⇄ wx 守护进程（agent-wechat，只听 127.0.0.1:6179）⇄ 微信桥接（hosted/wechat-bridge）⇄ https://weave.azorashopping.site（Agent 服务在服务器上）
```

## 0. 先看这几条

**风险。** [agent-wechat](https://github.com/thisnick/agent-wechat) 是第三方开源软件，不是腾讯官方接口。它用一个真实的微信号登录，可能违反微信的使用规则，账号可能被限制甚至封掉，而且没有可靠的封号数据（作者只在一个测试号上验证过，也没有发送限速）。**只用新的小号，不用主号，小号里不放重要的东西。**

**为什么跑在你的 Mac 上，不跑在服务器上。** 这是我的推荐，不是已经验证过的结论：

1. 微信的登录风控。agent-wechat 的文档写明，有的登录批准需要手机和守护进程在同一个局域网里（[Connect your account](https://thisnick.github.io/agent-wechat/setup/connect/)、[Troubleshooting](https://thisnick.github.io/agent-wechat/reference/troubleshooting/) 的「Phone approval stalls」），它们的验证清单把这一步标成「实验性、实机验证未完成」（[FEATURES.md](https://github.com/thisnick/agent-wechat/blob/v1.3.3/packages/native-client-rust/FEATURES.md)）。服务器过不了这一步，Mac 和手机连同一个 Wi-Fi 就能过。另外 agent-wechat 的 [issue #168](https://github.com/thisnick/agent-wechat/issues/168) 里，有人在 Linux 服务器上登录几小时后，手机弹出「安全保护中：扫码登录其他设备功能受限，原因：使用行为或设备网络环境异常」（只有这一个案例，发生在旧架构上，作者没有回复）。美国的 IP 会不会让风控更严，**没有验证**。
2. 服务器内存紧：空闲约 2.2 GB，Azora 也要用。
3. 出问题好撤：停掉 Mac 上的两个任务，再在手机上把这台设备踢掉就行。

**代价：** Mac 睡着或关机时助理不在线。开机后，6 小时内的私聊会补回复，更早的忽略；群里更早的消息只当上下文。

**现状，别跳过：**

- 微信消息走 Agent SDK 那条路，需要网站的 `WEAVE_AGENT_RUNTIME=sdk`（`setup-env.sh` 已经写进服务器的 `web.env`，下面第 1 步会检查）。私聊叫醒的是「本人范围」，群里 @ 叫醒的是「群范围」，看不到任何人的个人资料。
- 群里助理读群上下文，靠另一个分支（`fix/harness-textbook`）里的「调用前快照」。它合并之前，助理在群里只看得到 @ 它的那一句话。**所以先试私聊，群等那个分支合并以后再试。**
- 这套东西从来没有连过真实的微信：模拟微信的端到端测试通过了，真实账号没有试过。agent-wechat 作者自己的真实账号验证都在 Linux x64 上做的，macOS 的真实账号验收在他们的清单里还是「待做」（[PLATFORM-ACCEPTANCE.md](https://github.com/thisnick/agent-wechat/blob/v1.3.3/PLATFORM-ACCEPTANCE.md)）。所以这是一次**试点**。

## 1. 准备（只做一次）

- 一个**小号**：新注册的、不重要的微信号，登录在一部手机上，能正常收发。别刚注册就挂上来，先正常用几天（这条是我的建议，没有验证）。
- 手机和这台 Mac 连**同一个 Wi-Fi**。路由器如果开了「AP 隔离」或「客户端隔离」，关掉。
- **把代理软件彻底退出**（菜单栏图标 → 退出；只关「系统代理」开关不够）。这台 Mac 的代理开着「虚拟 IP」模式（TUN）：连不看系统代理的程序（curl、Node、wx）也被它接管。2026-11-02 实测：下载 wx 时连上的地址是 `198.18.0.100`（代理分配的虚拟地址），速度约 60 KB/s。agent-wechat 不支持给它设代理，被接管时微信看到的是代理的出口 IP，和手机所在的家里网络对不上。退出后用这条确认，打印出来的地址不应该以 `198.18` 开头：

  ```
  curl -s -o /dev/null -w '%{remote_ip}\n' https://weixin.qq.com
  ```

  `login.sh` 开头也会自己查一次，发现代理还在接管就停下来问你。**小号在线的整个期间都别再开代理**：开着代理软件时新建的连接会换出口，守护进程里已有的微信连接会被掐断重连，微信看到的就是「换了地方」。一定要开的话，把 `long.weixin.qq.com`、`short.weixin.qq.com`、`weixin.qq.com`、`qq.com` 设成直连。桥接（Node）连 `https://weave.azorashopping.site` 两种情况都能通：代理退出时直连，代理开着时被它接管，它自己不看系统代理。
- Mac 插着电。
- Node 22 以上：

  ```
  node -v
  ```

- 服务器上的网站已经部署好（`deploy/tencent/README.md` 的第 0 到 6 步），而且 `web.env` 里有 `WEAVE_AGENT_RUNTIME=sdk`。这条命令应该打印出那一行：

  ```
  ssh -i ~/.ssh/id_ed25519_43_162_99_246 ubuntu@43.162.107.53 'grep -c "^WEAVE_AGENT_RUNTIME=sdk$" ~/weave/deploy/tencent/web.env'
  ```

  打印 `1` 就对了；打印 `0`，先在服务器的 `web.env` 里加上这一行，再重新部署。
- 代码：给这件事单独拉一份干净的，不碰你平时改的那份：

  ```
  git clone https://github.com/Janettbella69/Weave.git ~/weave-wechat && cd ~/weave-wechat && git checkout feat/deploy-tencent
  ```

  （以前这里写的是 `chore/wechat-pilot-prep`，那个分支已经合并进 `feat/deploy-tencent`，而且落后很多提交，别再用。）之后更新用 `git -C ~/weave-wechat pull`。**这个文件夹别删、别挪**：桥接是从它里面启动的；也别放进「文稿」「桌面」这类受 macOS 保护的文件夹，后台任务读不了那里。

## 2. 三条命令，最后一步只剩扫码

在 `~/weave-wechat` 里，按顺序跑：

### 2.1 安装

```
cd ~/weave-wechat && bash deploy/wechat-mac/install.sh --keep-awake
```

它做的事：下载 wx 1.3.3（约 29 MB；直连几十秒，经代理软件实测约 8 分钟，进度条在走就不是卡住，中断了重跑会接着下），核对 SHA-256，不对就不装；写两个 launchd 任务（wx 守护进程、微信桥接）；启动守护进程。`--keep-awake` 是可选的：另外装一个任务，插着电时不让 Mac 睡着（屏幕仍然可以熄；合上笔记本盖子还是会睡）。不想要就去掉这个参数。

看到下面三行就对了：

```
校验通过，已装到 /Users/你/.weave-wechat/bin/wx
wx 版本：1.3.3（目标 aarch64-apple-darwin）
守护进程正常（只听 127.0.0.1:6179，外面连不到）。
```

macOS 可能弹出「已添加后台项目」的通知，是正常的（系统设置 → 通用 → 登录项与扩展 里能看到）。

### 2.2 生成令牌，配好两边，重新部署网站

```
cd ~/weave-wechat && bash deploy/wechat-mac/set-token.sh
```

它做的事：生成一个新的 `WECHAT_BRIDGE_TOKEN`，经 ssh 写进服务器 `web.env`（其他行不动，改之前备份到服务器的 `~/weave-data/env-backups/`），重新部署网站，再写进这台 Mac 的桥接配置，最后从这台 Mac 检查服务器认不认它。令牌从头到尾不显示。要几十秒到几分钟。

看到下面两行就对了：

```
没带令牌：HTTP 401（对，要求令牌）
带令牌：HTTP 200（对，服务器认这个令牌）
```

出了问题（ssh 连不上、部署失败、检查不通过）直接重跑，每次都会换一个新令牌。提示 HTTP 000 多半是网络或代理的问题。

### 2.3 登录小号

```
cd ~/weave-wechat && bash deploy/wechat-mac/login.sh
```

屏幕上会出现：

```
======================================================
  用小号扫这个二维码
======================================================
```

下面紧跟着一个二维码。**这时你只剩一件事：** 拿小号的手机，微信右上角「+」→「扫一扫」→ 扫屏幕上的二维码 → 在手机上点「登录」。二维码 5 分钟内有效，会自动刷新 3 次；错过了就重跑这条命令。

- 二维码约 20 行高，**先把终端窗口拉高到至少 30 行**再跑，否则上面几行会被滚出去。
- 二维码过期时会换新的，**新的画在旧的下面，扫最下面那个**。
- 终端里扫不上：二维码下面一行会印出 `QR PNG: 某某.png`，用 `open` 打开那个文件，对着屏幕扫（路径以屏幕上印的为准，源码里是 `~/.config/agent-wechat/qr/`）。
- macOS 可能弹「是否允许 wx 接受传入的网络连接」，点「允许」：手机有时要连到这台 Mac 做本地网络校验（端口 8050 到 8100，只在登录那几分钟开着）。

扫成功后，脚本会自己建一把只能读和发的密钥写进桥接配置（不显示），启动桥接，最后打印当前状态。

## 3. 扫码之后：确认它活了

**3.1 看状态**

```
bash ~/weave-wechat/deploy/wechat-mac/status.sh
```

两个进程都应该是「运行中」，小号一行应该写「已登录」。

**3.2 在 Weave 里连接。** 打开 https://weave.azorashopping.site → 设置 → 渠道 → 微信。「连接」按钮能点（灰着说明服务器上还没有令牌，回到 2.2）。点「连接」，页面会显示「在微信中发送：绑定 ……」。

**3.3 用你的主号给小号发一句话。** 先在主号里把小号加为好友，到小号手机上通过（agent-wechat 不能替小号通过好友申请）。然后把页面上那句 `绑定 ……` 发给小号。几十秒内小号会回「微信已连接到你的 Weave 空间……」，网页上微信变成「已连接」。

**3.4 聊一句。** 给小号发「你好」。一到两分钟内助理会回复（桥接每分钟触发一次网站的定时任务，再加上 Agent 运行的时间）。回到 Weave 网页的聊天记录里，也能看到这一来一回。

**3.5 试提醒。** 在 Weave 里设一个一分钟后的提醒，微信会收到「提醒你：……」。

**3.6 看日志。** 想看桥接在干什么：

```
tail -f ~/.weave-wechat/logs/bridge.log
```

每行都带时间。正常时几乎没有输出；登录掉了会看到「事件连接中断」，间隔会越拉越长（最长 60 秒）。

**3.7 群（等快照分支合并后再试）。** 把小号拉进群，群里发 `@助理 开启打卡群`（只有已经绑定的成员能开启），助理会先说明它会读这个群的消息。关闭：`@助理 关闭打卡群`，任何成员都能关，群的记录和 Agent 里这个群的工作目录一起删除。

## 4. 每天看一眼，和该警惕的征兆

```
bash ~/weave-wechat/deploy/wechat-mac/status.sh
```

**出现下面任何一个，先停（`bash ~/weave-wechat/deploy/wechat-mac/stop.sh`），不要反复重新扫码：**

- 小号手机上弹出「安全保护中」「账号存在风险」「扫码登录其他设备功能受限」之类的提示（issue #168 里的样子）；
- 小号被踢下线：`status.sh` 写「没登录」，桥接日志里有 `auth_required`；重新登录后几个小时内又掉；
- 手机收到你没做过的「新设备登录」「异地登录」安全通知；
- 发出去的消息在手机上看不到，或日志里反复出现「结果不确定」（微信没有确认收到）；
- 朋友说收到「发送失败」或被限制添加好友。

遇到了：停掉，**24 小时内别再登录**，先想想是不是代理或 VPN 换了出口 IP、是不是短时间发得太多。这些征兆都来自别人的零星报告，不是微信公布的规则。

**发送限速（桥接自己加的，agent-wechat 没有）。** 默认：每个聊天每分钟最多 6 条，所有聊天一共每分钟 12 条，每天 200 条，两条之间至少隔 1.5 秒。这些数字是保守的猜测，没有微信风控的数据支持。超出的消息不会丢：它留在队列里，过一会儿再发；压了超过 10 分钟还没发出去的，放弃（不会隔了几小时再发出去）。要改，编辑 `~/.weave-wechat/bridge.env` 里被注释掉的 `WECHAT_SEND_*` 几行，然后重启桥接：

```
launchctl kickstart -k gui/$(id -u)/com.weave.wechat.bridge
```

## 5. 停掉、退回、卸载

| 想做什么 | 命令 |
| --- | --- |
| 暂时停掉（小号仍是登录状态，数据都留着） | `bash ~/weave-wechat/deploy/wechat-mac/stop.sh` |
| 停掉，并让小号退出登录 | `bash ~/weave-wechat/deploy/wechat-mac/stop.sh --logout` |
| 重新开 | `bash ~/weave-wechat/deploy/wechat-mac/install.sh`，再 `bash ~/weave-wechat/deploy/wechat-mac/login.sh` |
| 连 Weave 那边一起关（服务器上的令牌清空并重新部署，桥接停掉） | `bash ~/weave-wechat/deploy/wechat-mac/set-token.sh --remove` |
| 删掉 launchd 配置 | `bash ~/weave-wechat/deploy/wechat-mac/stop.sh --uninstall` |
| 彻底清掉本机的东西 | 先 `stop.sh --logout --uninstall`，再 `rm -rf ~/.weave-wechat`（wx 客户端另外在 `~/.config/agent-wechat/` 放了设置和登录二维码，里面没有微信数据；没有别的用途就一并删） |

**`stop.sh` 只停到下次登录这台 Mac 为止。** launchd 配置还在，重启或注销再登录以后，两个任务会自己起来，小号会自动重连。要一直停着，加 `--uninstall`。

**保险做法：** 不管用哪一种，都再到小号的手机微信里确认一遍：「我」→「设置」→「账号与安全」→「登录设备管理」，看到这台 Mac 就点掉。这一步不依赖 Mac。

## 6. 常见问题

**手机上一直转圈，登录不上。** agent-wechat 的文档说，有的批准需要手机连到守护进程（本机端口 8050 到 8100）。按顺序查：手机和 Mac 是不是同一个 Wi-Fi；路由器有没有开「AP 隔离」；Mac 如果弹出「是否允许 wx 接受传入的网络连接」，点「允许」；系统设置 → 隐私与安全性 → 本地网络 里有没有把终端打开。然后重跑 `login.sh`。

**二维码过期了。** 重跑 `login.sh`。

**`install.sh` 说校验没通过。** 文件已删除、什么都没装。把输出发给 Claude，别手动绕过。

**Mac 睡了又醒。** 守护进程用保存的登录信息自己重连，不会自己重新扫码；睡着期间的消息补收，6 小时内的补回复。如果醒来后「没登录」，重跑 `login.sh`。

**升级 agent-wechat。** 改 `deploy/wechat-mac/lib.sh` 里的 `WX_VERSION` 和 `WX_SHA256_DARWIN_ARM64`（校验值在对应版本的 release 里的 `wx-v版本-checksums.json`），先跑一遍 [`scripts/agent-wechat-e2e`](../../scripts/agent-wechat-e2e/README.md)，再重跑 `install.sh`。

**东西都在哪。**

| 什么 | 在哪 |
| --- | --- |
| wx 程序 | `~/.weave-wechat/bin/wx` |
| 微信账号数据、守护进程的令牌 | `~/.weave-wechat/data/`（权限 700；里面的 `accounts/` 是小号的聊天记录） |
| 桥接配置和密钥 | `~/.weave-wechat/bridge.env`（权限 600，别发给任何人） |
| 桥接的位置标记 | `~/.weave-wechat/state/cursor.json` |
| 日志 | `~/.weave-wechat/logs/` |
| launchd 配置 | `~/Library/LaunchAgents/com.weave.wechat.*.plist` |
| 手动给 wx 下命令 | `bash ~/weave-wechat/deploy/wechat-mac/wx.sh --json accounts list` |

守护进程空闲时约占 18 MB 内存（macOS 上实测，没登录微信时）；登录以后会多一些，没有量过。

## 7. 还没验证的事

- 真实微信：从来没有连过。
- macOS 上登录真实账号：agent-wechat 作者没有验收过（他们的真实账号验证在 Linux x64）。
- 美国 IP、家用网络对风控的影响：不知道。
- 小号掉线的频率、被限制多久：没有数据。
- 发送限速的数字：猜的。
- 手机和 Mac 同一局域网这一步是不是必须：文档说「有的批准需要」，具体什么时候触发，不知道。

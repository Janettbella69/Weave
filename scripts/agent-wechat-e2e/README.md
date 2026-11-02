# agent-wechat 端到端测试

用 agent-wechat 真实的 hub 和发件流程，加上模拟的微信上游，跑通「微信 ⇄ hub ⇄ 桥接 ⇄ Weave」。Weave 走 Agent SDK 那条路（`WEAVE_AGENT_RUNTIME=sdk`）：私聊叫醒本人范围、群里 @ 叫醒群范围，Agent 服务是假的（只记录 `/wake` 和 `/forget` 请求、回一句固定的话），不连接真实微信，也不调用任何模型。升级 agent-wechat 前先跑一遍。

官方模拟器只能注入私聊。`simulator.patch` 给它的 `inbound` 加了 `source` 参数并允许群号，这样群消息和 @ 能走 hub 真实的解析。补丁只改模拟器，不改解析代码。

需要 Rust（版本见 agent-wechat 的 `rust-toolchain.toml`）和 Node 24 以上。

```sh
git clone --depth 1 --branch v1.3.3 https://github.com/thisnick/agent-wechat.git
cd agent-wechat
git apply /path/to/Weave/scripts/agent-wechat-e2e/simulator.patch
cargo build --profile test --locked --manifest-path packages/native-client-rust/Cargo.toml -p wechat-simulator --bin wx-dev
AGENT_WECHAT_SRC="$PWD" WX_DEV_BINARY="$PWD/packages/native-client-rust/target/debug/wx-dev" node --no-warnings /path/to/Weave/scripts/agent-wechat-e2e/e2e.mjs
```

没覆盖的：真实微信的协议和风控、真实的模型回复。

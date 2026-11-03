import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "隐私说明 · Weave",
  description: "Weave 保存什么、发给谁、怎么导出和删除。",
};

export const dynamic = "force-dynamic";

// 微信看图（服务器的 WEAVE_WECHAT_IMAGES=1，并且走 Agent SDK 路线）打开时才多一条说明；关着时这一页一字不变。
async function photosOn(): Promise<boolean> {
  try {
    const { env } = await import("cloudflare:workers");
    const config = env as unknown as Record<string, string | undefined>;
    return config.WEAVE_WECHAT_IMAGES === "1" && config.WEAVE_AGENT_RUNTIME === "sdk";
  } catch {
    return false;
  }
}

export default async function PrivacyPage() {
  const photos = await photosOn();
  return (
    <main className="landing-page">
      <div className="landing-container landing-top-row">
        <Link className="landing-brand" href="/" aria-label="Weave 首页">
          <span className="landing-mark">w</span>
          <span className="landing-name">Weave</span>
        </Link>
      </div>
      <div className="landing-container">
        <section className="landing-block">
          <h1>隐私说明</h1>
          <p className="muted">
            这里用大白话写清楚 Weave 实际怎么处理你的数据。Weave 还在早期阶段，这不是正式的法律文件。
          </p>
        </section>

        <section className="landing-block">
          <h2 className="landing-section-title">我们保存什么</h2>
          <ul>
            <li>你填写的名字、目标、偏好、时区和可用时间。</li>
            <li>你和 Agent 的聊天、反馈、计划、提醒和日程。</li>
            <li>你连接的模型 Key、Notion Token 和微信号。这三样加密保存。</li>
          </ul>
          <p>
            除了上面说明加密的内容，其他资料都以未加密的形式存在我们服务器的数据库里。不注册的访客也一样，数据不只存在你的浏览器里，Cookie 只用来认出你。
          </p>
        </section>

        <section className="landing-block">
          <h2 className="landing-section-title">发给谁</h2>
          <ul>
            <li>
              <strong>DeepSeek：</strong>你的消息和相关资料（目标、偏好、最近的聊天和反馈）会发给它来生成回复。开启后台主动判断后，这些资料也会定期发送。
            </li>
            <li>
              <strong>Notion：</strong>只有你连接后才会读取你选择的页面，页面文字会一起发给 DeepSeek。只有你确认过的计划才会写回去。
            </li>
            <li>
              <strong>朋友：</strong>只有你每次单独授权时，才会共享这次活动的可用时间和活动偏好。你的聊天和反馈不会给朋友。
            </li>
          </ul>
          <p>Weave 不包含广告，也不出售你的数据。</p>
        </section>

        <section className="landing-block">
          <h2 className="landing-section-title">微信和打卡群</h2>
          <ul>
            <li>微信通过第三方开源客户端接入，不是腾讯官方接口。</li>
            <li>没有开启的群，消息到达后直接丢弃，不留任何记录。</li>
            <li>开启时助理会先在群里说明。任何成员都可以 @助理 说「关闭打卡群」，之后停止读取，并删除这个群的记录。</li>
            <li>开启后，群消息加密保存，最多 50 条、14 天。消息开头写「别记」的不保存。</li>
            <li>回复时，模型只看到这个群的记录和「成员1」这样的代号，看不到微信号，也不会读取任何人的个人资料。</li>
            {/* 草稿文案，待确认。只在看图打开时显示。 */}
            {photos ? (
              <li>
                打开看图后：有人 @助理（私聊里是发一句话）时，同一个人在同一个聊天里、这之前 60 秒内或之后 10 秒内发的一张照片，会和这句话一起发给 DeepSeek 看。照片加密暂存，最长 10 分钟，这一轮开始时就删除，不进聊天记录、群记录或 Agent 的记忆。没有配上 @ 的照片不会离开运行微信的那台电脑。
              </li>
            ) : null}
          </ul>
        </section>

        <section className="landing-block">
          <h2 className="landing-section-title">健康相关的内容</h2>
          <p>
            你可能会聊到睡眠、饮食和运动。Weave 的建议不是医疗意见。如果身体不适或情绪很差，请联系医生或你信任的人；遇到紧急情况，请拨打当地急救电话。
          </p>
        </section>

        <section className="landing-block">
          <h2 className="landing-section-title">保留多久，怎么导出和删除</h2>
          <ul>
            <li>你的资料会一直保留，直到你删除账号。</li>
            <li>在「设置」里可以导出全部数据，也可以永久删除账号。删除后无法恢复。</li>
            <li>
              删除账号会同时取消你和朋友的共同安排，并关闭你开启的打卡群。已经发给 DeepSeek 或写进你 Notion 的内容，要到对方那里处理。
            </li>
            <li>访客退出后找不回原来的空间，所以需要删除的话，请先删除再退出。</li>
          </ul>
        </section>

        <section className="landing-block">
          <h2 className="landing-section-title">联系我们</h2>
          <p>
            有问题请到{" "}
            <a className="inline-link" href="https://github.com/Janettbella69/Weave/issues">
              GitHub Issues
            </a>{" "}
            留言。
          </p>
        </section>
      </div>
      <footer className="landing-container landing-foot">
        <p>
          <Link className="inline-link" href="/">
            返回首页
          </Link>
        </p>
      </footer>
    </main>
  );
}

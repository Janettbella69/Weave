import Link from "next/link";

type Props = {
  signInHref: string;
};

export default function LandingMarketing({ signInHref }: Props) {
  return (
    <main className="landing-page">
      <div className="landing-container landing-top-row">
        <Link className="landing-brand" href="/" aria-label="Weave 首页">
          <span className="landing-mark">w</span>
          <span className="landing-name">Weave</span>
        </Link>
        <a className="button landing-nav-cta" href={signInHref} target="_top">
          登录
        </a>
      </div>

      <div className="landing-hero-band">
        <div className="landing-container landing-hero">
          <p className="eyebrow">产品宣传 · 个人 Agent 工作台</p>
          <h1>
            找到自己的节奏，
            <br />
            也让 Agent 帮你们一起行动。
          </h1>
          <p className="landing-lede">
            Weave 把<strong> 个人习惯 Agent</strong>、<strong> 朋友协作</strong>
            与<strong> 长期记忆</strong>
            放在同一空间：你授权什么，Agent 就记住什么；约见前 Agent 先商量，最后仍由你确认。
          </p>
          <div className="landing-hero-actions">
            <a
              className="button primary landing-hero-cta"
              href={signInHref}
              target="_top"
            >
              用 ChatGPT 登录，开启我的空间
            </a>
            <p className="muted landing-hero-note">
              沿用现有登录流程 · 支持好友邀请链接（join）自动回跳 ·
              连接 Agent / 微信 / Notion 均可选
            </p>
          </div>
        </div>
      </div>

      <div className="landing-container">
        <section className="landing-block" aria-labelledby="landing-values">
          <h2 id="landing-values" className="landing-section-title">
            核心价值
          </h2>
          <div className="landing-values">
            <article className="landing-value">
              <h3>个人 Agent</h3>
              <p>
                用自然语言描述今天的状态，Agent 团队协调运动、睡眠与饮食，输出可执行的小步计划；「反馈：…」会进入你的长期记忆。
              </p>
            </article>
            <article className="landing-value">
              <h3>Agent 协作</h3>
              <p>
                邀请真实朋友，一次性链接建立关系。每次活动单独授权时间与偏好，Agent 提案与反提案，双方本人确认后才写入共同日程。
              </p>
            </article>
            <article className="landing-value">
              <h3>记忆与日程</h3>
              <p>
                目标、偏好、反馈与确认后的安排保存在你的空间；导出 .ics，或按需同步 Notion 做归档，不强制绑定任何通道。
              </p>
            </article>
          </div>
        </section>

        <section className="landing-block" aria-labelledby="landing-features">
          <h2 id="landing-features" className="landing-section-title">
            产品能力
          </h2>
          <ul className="landing-features">
            <li>
              <span className="landing-feature-title">聊天式习惯调整</span>
              <span className="landing-feature-desc">
                像和教练说话一样更新计划，而不是填表。
              </span>
            </li>
            <li>
              <span className="landing-feature-title">授权式协作</span>
              <span className="landing-feature-desc">
                不公开账号目录；每次协商重新授权共享范围。
              </span>
            </li>
            <li>
              <span className="landing-feature-title">提案与确认分离</span>
              <span className="landing-feature-desc">
                Agent 处理冲突与反提案，关键节点回到本人按钮。
              </span>
            </li>
            <li>
              <span className="landing-feature-title">多通道可选</span>
              <span className="landing-feature-desc">
                网页、微信提醒、Notion——按需连接，随时断开。
              </span>
            </li>
          </ul>
        </section>

        <section className="landing-block landing-how" aria-labelledby="landing-how">
          <h2 id="landing-how" className="landing-section-title">
            三步上手
          </h2>
          <ol className="landing-steps">
            <li>
              <span className="landing-step-num" aria-hidden="true">
                1
              </span>
              <div>
                <strong>ChatGPT 登录</strong>
                <p>进入个人空间，在 Channels 连接 Personal Agent。</p>
              </div>
            </li>
            <li>
              <span className="landing-step-num" aria-hidden="true">
                2
              </span>
              <div>
                <strong>填写目标与空闲时间</strong>
                <p>Agent 据此给建议，并记住你的偏好与反馈。</p>
              </div>
            </li>
            <li>
              <span className="landing-step-num" aria-hidden="true">
                3
              </span>
              <div>
                <strong>聊天 · 协作 · 确认</strong>
                <p>与个人 Agent 对话，与朋友 Agent 协商，确认后写入日程。</p>
              </div>
            </li>
          </ol>
        </section>
      </div>

      <div className="landing-cta-band">
        <div className="landing-container landing-cta-strip">
          <h2>今天就开始你的 Agent 工作台</h2>
          <p>免费使用核心聊天与协作；高级通道连接由你决定。</p>
          <a className="button primary" href={signInHref} target="_top">
            登录，开启我的空间
          </a>
        </div>
      </div>

      <footer className="landing-container landing-foot">
        <p>Weave · 由你授权，由你决定。</p>
        <p className="muted">个人 Agent · Agent 协作 · 记忆与日程</p>
      </footer>
    </main>
  );
}

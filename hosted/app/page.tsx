import { getChatGPTUser, chatGPTSignInPath } from "./chatgpt-auth";
import Workspace from "./workspace/Workspace";
import Link from "next/link";
import { ErrorBoundary } from "../components/ErrorBoundary";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ join?: string }>;
}) {
  const user = await getChatGPTUser();
  if (user) {
    return (
      <ErrorBoundary>
        <Workspace />
      </ErrorBoundary>
    );
  }

  const { join } = await searchParams;
  const returnTo =
    join && /^[a-f0-9]{48}$/.test(join) ? "/?join=" + join : "/";
  const signIn = chatGPTSignInPath(returnTo);

  return (
    <main className="landing-page">
      <header className="landing-top">
        <Link className="landing-brand" href="/" aria-label="Weave 首页">
          <span className="landing-mark">w</span>
          <span className="landing-name">Weave</span>
        </Link>
        <a className="button landing-nav-cta" href={signIn} target="_top">
          登录
        </a>
      </header>

      <section className="landing-hero" aria-labelledby="landing-hero-title">
        <p className="eyebrow">个人 Agent · 协作 · 长期记忆</p>
        <h1 id="landing-hero-title">
          日常有节奏，
          <br />
          约见有把握。
        </h1>
        <p className="landing-lede">
          Weave 是你的 Personal Agent 工作台：帮你调整习惯、记住反馈，并在你授权时与朋友的
          Agent 商量散步、运动或见面——双方确认后再写入日程。
        </p>
        <div className="landing-hero-actions">
          <a className="button primary landing-hero-cta" href={signIn} target="_top">
            用 ChatGPT 登录，开启我的空间
          </a>
          <p className="muted landing-hero-note">
            使用 ChatGPT 账号登录 · 数据独立保存 · 连接 Agent、微信与 Notion 均由你授权
          </p>
        </div>
      </section>

      <section className="landing-block" aria-labelledby="landing-story-title">
        <h2 id="landing-story-title" className="landing-section-title">
          产品故事
        </h2>
        <div className="landing-story-grid">
          <article className="landing-story-card">
            <p className="landing-kicker">个人 Agent</p>
            <h3>懂今天的你，而不只是目标清单</h3>
            <p>
              说说睡眠、训练或饮食状态，Agent 团队一起协调，把计划拆成今天能开始的小步。输入「反馈：…」还会记住什么对你真正有用。
            </p>
          </article>
          <article className="landing-story-card">
            <p className="landing-kicker">Agent 协作</p>
            <h3>邀请朋友，Agent 先商量，你来拍板</h3>
            <p>
              生成一次性邀请链接，双方授权本次时间与偏好。Agent 提案、处理冲突、给出反提案——只有你们本人确认后，共同安排才生效。
            </p>
          </article>
          <article className="landing-story-card">
            <p className="landing-kicker">记忆与日程</p>
            <h3>约好了，就留在生活里</h3>
            <p>
              确认后的安排进入日程，可导出日历。目标、偏好与日常反馈保存在你的空间；可选同步 Notion 做长期归档。
            </p>
          </article>
        </div>
      </section>

      <section className="landing-block" aria-labelledby="landing-benefits-title">
        <h2 id="landing-benefits-title" className="landing-section-title">
          为什么选择 Weave
        </h2>
        <ul className="landing-benefits">
          <li className="landing-benefit">
            <strong>你授权，才共享</strong>
            <span>每次协作单独授权时间与偏好，不公开账号目录。</span>
          </li>
          <li className="landing-benefit">
            <strong>Agent 先谈，你来确认</strong>
            <span>提案与冲突在 Agent 层处理，关键决定回到本人。</span>
          </li>
          <li className="landing-benefit">
            <strong>习惯与社交同一空间</strong>
            <span>个人节奏与朋友约见共用一套记忆，减少来回切换。</span>
          </li>
          <li className="landing-benefit">
            <strong>通道你选</strong>
            <span>网页、微信提醒、Notion 归档——按需连接，随时断开。</span>
          </li>
        </ul>
      </section>

      <section className="landing-block landing-how" aria-labelledby="landing-how-title">
        <h2 id="landing-how-title" className="landing-section-title">
          如何开始
        </h2>
        <ol className="landing-steps">
          <li>
            <span className="landing-step-num">1</span>
            <div>
              <strong>登录并连接 Personal Agent</strong>
              <p>用 ChatGPT 账号进入空间，在 Channels 中一键连接 Agent。</p>
            </div>
          </li>
          <li>
            <span className="landing-step-num">2</span>
            <div>
              <strong>设定目标与可用时间</strong>
              <p>填写习惯目标、偏好与未来空闲时段，Agent 据此给出建议。</p>
            </div>
          </li>
          <li>
            <span className="landing-step-num">3</span>
            <div>
              <strong>聊天、协作、确认安排</strong>
              <p>与个人 Agent 对话；邀请朋友协商；双方确认后写入日程。</p>
            </div>
          </li>
        </ol>
      </section>

      <section className="landing-cta-strip" aria-labelledby="landing-cta-title">
        <h2 id="landing-cta-title">准备好试试了吗？</h2>
        <p>登录即可使用聊天与协作；连接通道完全可选。</p>
        <a className="button primary" href={signIn} target="_top">
          登录，开启我的空间
        </a>
      </section>

      <footer className="landing-foot">
        <p>Weave · 由你授权，由你决定。</p>
        <p className="muted">© {new Date().getFullYear()} Weave</p>
      </footer>
    </main>
  );
}

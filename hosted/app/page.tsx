import {getChatGPTUser,chatGPTSignInPath} from './chatgpt-auth';
import Workspace from './workspace/Workspace';
import Link from 'next/link';
import {ErrorBoundary} from '../components/ErrorBoundary';
export const dynamic='force-dynamic';
 export default async function Home({searchParams}:{searchParams:Promise<{join?:string}>}){
  const user=await getChatGPTUser();
  if(user)return <ErrorBoundary><Workspace/></ErrorBoundary>;
  const {join}=await searchParams;
  const returnTo=join&&/^[a-f0-9]{48}$/.test(join)?'/?join='+join:'/';
  return <main className="landing"><Link className="wordmark" href="/">w <span>Weave</span></Link><div className="landing-copy"><p className="eyebrow">MY AGENT. YOUR AGENT. OUR NEXT STEP.</p><h1>找到自己的节奏。<br/>也让彼此，<em>一起行动。</em></h1><p className="lede">一个了解你日常的 Personal Agent，<br/>和朋友的 Agent 商量下一次散步、运动或见面。</p><a className="button primary" href={chatGPTSignInPath(returnTo)} target="_top">登录，开启我的空间 ↗</a><p className="muted">使用 ChatGPT 账号登录 · 独立保存你的目标与安排</p></div><div className="landing-notes"><article><span>01 · 向内</span><h2>计划适应今天的你</h2><p>运动、睡眠、饮食 Agent 一起协调，让目标变成容易开始的小行动。</p></article><article><span>02 · 向外</span><h2>让我们的 Agent 商量</h2><p>邀请真正的朋友，按双方授权的时间与偏好提案，处理冲突，再交给你们确认。</p></article><article><span>03 · 行动</span><h2>约好了，就记下来</h2><p>双方确认后加入日程，导入你的日历。记录反馈，让下一次安排更适合自己。</p></article></div><footer>Weave · 由你授权，由你决定。<br/><small>登录后从 Channels 一键连接 Agent、微信与 Notion。</small></footer></main>;
}

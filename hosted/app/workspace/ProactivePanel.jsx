'use client';
import {useEffect,useState} from 'react';
const statusLabels={awaiting_response:'等待你的回应',accepted:'已接受，持续跟进',snoozed:'稍后跟进',done:'已完成',dismissed:'不再跟进',expired:'已过期',stopped:'已停止'};
const outcomes={quiet:'保持安静',suggested:'提出建议',follow_up:'跟进进展',error:'调用失败',stale:'略过过时判断'};
export default function ProactivePanel({request,act,profile,onInvite,hasModel}){
  const [data,setData]=useState(null),[draft,setDraft]=useState(null),[consent,setConsent]=useState(false),[error,setError]=useState('');
  const load=async()=>{const next=await request('proactivity');setData(next);setDraft(old=>old||next.policy);return next;};
  useEffect(()=>{let cancelled=false;const initial=setTimeout(()=>{if(!cancelled)load().catch(e=>{if(!cancelled)setError(e.message);});},0);const timer=setInterval(()=>{if(!cancelled&&!document.hidden)load().catch(()=>{});},15000);return()=>{cancelled=true;clearTimeout(initial);clearInterval(timer);};},[]);
  const run=(task,message='')=>act(async()=>{await task();await load();},message);
  const format=value=>new Intl.DateTimeFormat('zh-CN',{timeZone:profile?.timezone||'Asia/Shanghai',dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
  if(!data||!draft)return <p role="status">{error||'正在读取主动判断设置…'}</p>;
  const save=e=>{e.preventDefault();run(async()=>{await request('proactivity/configure',{...draft,consent});setConsent(false);},'主动判断设置已保存');};
  const feedback=(s,action,minutes)=>run(()=>request('proactivity/action',{id:s.id,action,minutes}),({accept:'已接受，之后会按时跟进',snooze:'已延后跟进',complete:'已记录完成，结束本次跟进',dismiss:'已停止跟进这条建议'})[action]);
  return <>
    <h1>该出现时出现，该安静时安静。</h1>
    <p className="muted">根据近期的生活线索判断下一步，先给出建议，由你决定是否行动。接受后才继续跟进。</p>
    <div className="banner"><span>{data.runtime.connected?'● 后台服务在线':'○ 后台服务未连接'} · {data.policy.enabled?'后台判断已开启':'后台判断已暂停'}</span>{data.runtime.lastSeenAt&&<small>最近连接：{format(data.runtime.lastSeenAt)}</small>}</div>
    {!hasModel&&<p className="banner">请先在个人设置中连接 Agent，后台判断才会开始。</p>}
    {data.policy.lastError&&<p className="banner error" role="alert">{data.policy.lastError}</p>}
    <form className="card" onSubmit={save}>
      <h2>让 Agent 帮你留意什么？</h2>
      <label>工作方式<select value={draft.mode} onChange={e=>setDraft({...draft,mode:e.target.value})}><option value="discover">主动发现：从近期上下文提出低风险建议</option><option value="goal">持续目标：帮我留意一个明确目标的下一步</option></select></label>
      <label>{draft.mode==='goal'?'持续目标':'关注方向（可选）'}<textarea maxLength="1000" required={draft.mode==='goal'} value={draft.goal} onChange={e=>setDraft({...draft,goal:e.target.value})} placeholder="例如：找到容易坚持的活动节奏，不要每天催我"/></label>
      <div className="form-grid"><label>检查间隔（分钟）<input type="number" min="15" max="1440" required value={draft.intervalMinutes} onChange={e=>setDraft({...draft,intervalMinutes:Number(e.target.value)})}/></label><label>每日最多主动消息<select value={draft.maxDailyMessages} onChange={e=>setDraft({...draft,maxDailyMessages:Number(e.target.value)})}>{[1,2,3].map(n=><option key={n} value={n}>{n} 次</option>)}</select></label></div>
      <div className="form-grid"><label>允许打扰的开始时间<input type="time" required value={draft.activeStart} onChange={e=>setDraft({...draft,activeStart:e.target.value})}/></label><label>允许打扰的结束时间<input type="time" required value={draft.activeEnd} onChange={e=>setDraft({...draft,activeEnd:e.target.value})}/></label></div>
      <p className="muted">时间按 {profile.timezone} 计算。安静时段不发主动消息；没有新线索时保持安静。每天最多6次后台判断。</p>
      <label className="checkbox"><input type="checkbox" checked={draft.enabled} disabled={!data.runtime.connected||!hasModel} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/>开启后台主动判断与持续跟进</label>
      {draft.enabled&&<label className="checkbox"><input type="checkbox" required checked={consent} onChange={e=>setConsent(e.target.checked)}/>我授权 Weave 在后台读取本人的目标、偏好、近期聊天与反馈、可用时间和已确认日程，并发给 DeepSeek 判断是否需要提醒。涉及朋友的邀请仍需我另行授权并由双方确认。</label>}
      <div className="actions"><button type="submit" className="primary">保存主动判断设置</button>{data.policy.enabled&&<button type="button" onClick={()=>run(async()=>{await request('proactivity/configure',{...data.policy,enabled:false,consent:false});setDraft({...data.policy,enabled:false});},'已暂停，新判断与消息不会继续执行')}>暂停后台判断</button>}<button type="button" onClick={()=>run(async()=>{await request('proactivity/stop',{});setDraft({...data.policy,enabled:false});},'已停止，并结束当前跟进')}>停止并结束全部跟进</button></div>
      <p className="muted">判断和跟进由独立执行器运行，网页关闭后可继续。执行器离线时暂停，恢复后从数据库续接。它不会自动给朋友发消息或代你确认安排。</p>
    </form>
    <h2>等待决定与正在跟进</h2>
    {!data.suggestions.length&&<p className="empty">目前没有建议。开启后，只有出现足够明确、值得介入的线索，我才会主动出现。</p>}
    {data.suggestions.slice().reverse().map(s=>{
      const open=['awaiting_response','accepted','snoozed'].includes(s.status);
      const evidence=[...new Set(s.evidenceIds.map(id=>id.startsWith('feedback:')?'近期反馈':id.startsWith('message:')?'最近聊天':id.startsWith('slot:')?'未来空闲':id.startsWith('event:')?'已确认日程':id.startsWith('suggestion:')?'之前的决定':'个人目标与偏好'))];
      return <article className="card proactive-suggestion" key={s.id}>
        <div className="row between"><h3>{s.message}</h3><span className="chip">{statusLabels[s.status]||s.status}</span></div>
        <p><b>为什么现在提起：</b>{s.whyNow}</p><p className="muted">参考：{evidence.join('、')} · {format(s.createdAt)}</p>
        {s.lastFollowUp&&<div className="banner">{s.lastFollowUp}</div>}
        {open&&<div className="actions">
          {s.status!=='accepted'&&<button className="primary" onClick={()=>feedback(s,'accept')}>接受，明天跟进</button>}
          {s.proposal.kind==='invite'&&s.status==='accepted'&&<button className="primary" onClick={()=>onInvite(s)}>去授权并发起邀请 →</button>}
          <button onClick={()=>feedback(s,'snooze',60)}>1小时后再说</button><button onClick={()=>feedback(s,'complete')}>我已完成 ✓</button><button onClick={()=>feedback(s,'dismiss')}>不用跟进</button>
        </div>}
        {open&&s.followUpAt&&<small>最早跟进时间：{format(s.followUpAt)}。是否发消息还会检查证据、安静时段和每日上限。</small>}
      </article>;
    })}
    <details><summary>最近的判断记录</summary>{data.policy.lastCheckedAt&&<p className="muted">最近检查：{format(data.policy.lastCheckedAt)}</p>}{data.policy.assessments.slice().reverse().map((a,i)=><article key={i}><p><b>{outcomes[a.outcome]||a.outcome}</b> · {format(a.at)}</p><p className="muted">{a.detail}</p></article>)}{!data.policy.assessments.length&&<p className="muted">还没有后台判断记录。</p>}</details>
  </>;
}

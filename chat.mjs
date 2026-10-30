export function sleepHours(text) {
 const match=text.match(/(?:睡(?:了|眠|觉)?\s*|睡眠时间\s*)(\d+(?:\.\d+)?)\s*(?:个)?小时/);
 const standalone=text.match(/^\s*(\d+(?:\.\d+)?)\s*(?:个)?小时\s*[。！!]?$/);
 const value=match?.[1]??standalone?.[1];
 if(value===undefined)return null;
 const n=Number(value);if(n<0||n>16)throw new Error('睡眠时间应在 0–16 小时之间');return n;
}
export function chatIntent(text,pending='') {
 if(typeof text!=='string'||!text.trim()||text.length>4000)throw new Error('请输入 1–4000 字消息');
 const clean=text.trim();
 if(/^(记录反馈|反馈|打卡)[：:]/.test(clean)){const feedback=clean.replace(/^(记录反馈|反馈|打卡)[：:]\s*/,'');if(!feedback||feedback.length>2000)throw new Error('反馈需要 1–2000 字');return {kind:'feedback',text:feedback};}
 if(/^(你好|嗨|hi|hello)[！!。\s]*$/i.test(clean))return {kind:'reply',text:'你好，我是你的个人习惯 Agent。今天想从什么开始？可以聊聊精力、计划和昨晚睡了多久，我会和运动、睡眠、饮食 Agent 一起帮你调整。'};
 const sleep=sleepHours(clean);const combined=pending?pending+'\n补充：'+clean:clean;
 if(sleep===null)return {kind:'clarify',pending:combined.slice(-6000),text:'我先记住这些安排。为了让计划更适合你，昨晚大约睡了几个小时？例如“睡了 6 小时”。'};
 return {kind:'plan',context:{text:combined.slice(-4000),sleep}};
}

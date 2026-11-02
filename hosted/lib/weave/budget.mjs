// Daily ceilings for model calls paid for by the deployment's own key. Someone using
// their own key is never counted. Counters live on each person's document and the
// total is summed from them: a shared counter document would make every concurrent
// chat conflict at commit time, after the model call has already been paid for.
import {fail} from './domain.mjs';

const DEFAULT_PER_ACCOUNT=60,DEFAULT_TOTAL=1000;
const count=(value,fallback)=>{const parsed=Number(value);return value!==undefined&&value!==''&&Number.isInteger(parsed)&&parsed>=0?parsed:fallback;};
export function modelBudgetConfig(env){return {perAccount:count(env?.AGENT_DAILY_CALLS_PER_ACCOUNT,DEFAULT_PER_ACCOUNT),total:count(env?.AGENT_DAILY_CALLS_TOTAL,DEFAULT_TOTAL)};}

const dayOf=now=>new Date(now).toISOString().slice(0,10);
const usedBy=(person,day)=>person.usage?.day===day?person.usage.calls:0;
export function spendManagedCall(world,owner,limits,now){
  const {perAccount,total}={...modelBudgetConfig(),...limits},day=dayOf(now),person=world.people[owner];
  if(usedBy(person,day)>=perAccount)fail('你今天的免费额度用完了，明天再来，或连接你自己的模型 Key。',429);
  if(Object.values(world.people).reduce((sum,p)=>sum+usedBy(p,day),0)>=total)fail('今天的免费额度已经用完，请明天再来。',429);
  person.usage={day,calls:usedBy(person,day)+1};
}

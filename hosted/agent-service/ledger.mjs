// 每个账号每天用了多少模型 token（按 UTC 日期）。存成一个小 JSON 文件，服务重启后额度不会清零。
// 只记托管 Key 的用量；用户自己的 Key 不经过这里（docs/ARCHITECTURE.md 第 12 节）。
import {readFileSync, writeFileSync, renameSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

export function createLedger({file, now = () => Date.now()}) {
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const empty = () => ({day: today(), accounts: Object.create(null)});
  let state;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    state = saved && typeof saved.day === 'string' && saved.accounts && typeof saved.accounts === 'object'
      ? {day: saved.day, accounts: Object.assign(Object.create(null), saved.accounts)}
      : empty();
  } catch {
    state = empty();
  }
  const current = () => { if (state.day !== today()) state = empty(); return state; };
  const persist = () => {
    mkdirSync(dirname(file), {recursive: true});
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, file);
  };
  return {
    used: account => current().accounts[account] || 0,
    total: () => Object.values(current().accounts).reduce((sum, tokens) => sum + tokens, 0),
    add(account, tokens) {
      if (!Number.isFinite(tokens) || tokens <= 0) return;
      const s = current();
      s.accounts[account] = (s.accounts[account] || 0) + Math.round(tokens);
      persist();
    },
  };
}

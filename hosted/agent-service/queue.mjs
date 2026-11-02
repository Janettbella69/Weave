// 每人串行，全局限并发（docs/ARCHITECTURE.md 第 2、12 节）：同一个人同一时间只跑一轮，
// 后到的排队；不同的人并行，但总数不超过 maxConcurrent（4 GB 的机器大约 3 轮）。
export function createRunQueue({maxConcurrent = 3, maxPerKey = 5} = {}) {
  let active = 0;
  const waiting = [];
  const chains = new Map();
  const acquire = () => new Promise(resolve => {
    if (active < maxConcurrent) { active++; resolve(); } else waiting.push(resolve);
  });
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

  function run(key, fn) {
    const chain = chains.get(key) ?? {tail: Promise.resolve(), size: 0};
    if (chain.size >= maxPerKey) return Promise.reject(Object.assign(Error('这个人还有好几轮在排队'), {status: 429}));
    chain.size++;
    chains.set(key, chain);
    const result = chain.tail.then(async () => {
      await acquire();
      try { return await fn(); } finally { release(); }
    });
    chain.tail = result.then(() => {}, () => {}).then(() => {
      chain.size--;
      if (chain.size === 0 && chains.get(key) === chain) chains.delete(key);
    });
    return result;
  }

  return {run};
}

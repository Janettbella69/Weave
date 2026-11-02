// 模型接入（docs/ARCHITECTURE.md 第 9 节）。每家都是 Anthropic 格式，地址后面不加 /v1。
// CLI 只连模型代理；真 Key 由代理按 keyEnv 读取，从不放进 CLI 的环境。
const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};

export const PROVIDERS = deepFreeze({
  deepseek: {name: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic', models: ['deepseek-flash', 'deepseek-v4-pro'], main: 'deepseek-flash', fast: 'deepseek-flash', keyEnv: 'DEEPSEEK_API_KEY'},
  kimi: {name: 'kimi', baseUrl: 'https://api.moonshot.cn/anthropic', models: ['kimi-k3[1m]', 'kimi-k2.7-code'], main: 'kimi-k3[1m]', fast: 'kimi-k2.7-code', keyEnv: 'KIMI_API_KEY'},
  glm: {name: 'glm', baseUrl: 'https://open.bigmodel.cn/api/anthropic', models: ['glm-5.2[1m]', 'glm-4.7'], main: 'glm-5.2[1m]', fast: 'glm-4.7', keyEnv: 'GLM_API_KEY'},
  // 同一份文档还给了按工作空间的地址，先用 dashscope 这个。
  qwen: {name: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', models: ['qwen3.7-max', 'qwen3.6-flash'], main: 'qwen3.7-max', fast: 'qwen3.6-flash', keyEnv: 'QWEN_API_KEY'},
});

export function providerFor(name) {
  if (typeof name !== 'string' || !Object.hasOwn(PROVIDERS, name)) throw Error(`不支持的模型提供方：${name}`);
  return PROVIDERS[name];
}

// CLI 发请求时可能带也可能不带 [1m] 后缀，比较时去掉。
const bare = model => model.replace(/\[1m\]$/, '');
export function modelAllowed(provider, model) {
  return typeof model === 'string' && provider.models.some(m => bare(m) === bare(model));
}

export function cliEnv({provider, model, runToken, baseUrl, home, configDir, path}) {
  if (!modelAllowed(provider, model)) throw Error(`${provider.name} 不支持模型 ${model}`);
  return {
    PATH: path,
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: runToken,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: provider.fast,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  };
}

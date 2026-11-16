export const DEFAULT_MODEL='deepseek-flash';
// 带照片的一轮一律用它：DeepSeek 只有 deepseek-flash 能看图，deepseek-v4-pro 会把照片换成「[Unsupported Image]」。
export const IMAGE_MODEL='deepseek-flash';
// agent-service/prompts.mjs 里有一份副本，test/agent-prompts-sync.test.mjs 保证两边一致。
export const SAFETY_RULES='健康安全：不建议极端节食、断食、催吐、滥用药物或过度运动，不给低于安全范围的热量目标，不鼓励减到明显偏瘦的体重。如果对方提到进食问题、严重的身体不适或想伤害自己，先表达关心，不给计划，建议联系医生或身边信任的人，紧急时拨打当地急救电话。';

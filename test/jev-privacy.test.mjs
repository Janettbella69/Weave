// 隐私页的 Jev 说明：2026-11-16 确认过的原句，一字不改；只在 Jev 配上了（jevConfig 认）才显示。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const page = readFileSync(new URL('../hosted/app/privacy/page.tsx', import.meta.url), 'utf8');
const CONFIRMED = 'Weave 主动找你之前，会把一份整理过的情况经 OpenRouter 发给 TypeSafe 的判断模型 Jev：你在追踪的目标名，每个习惯的名字、触发时机、最小一步、今天做没做、最近 7 天做了几天，它给自己写的跟进备忘，还有今天主动说了几句、你多久没说话。只用来判断现在该不该打扰你，不发聊天内容。';

test('隐私页用确认过的 Jev 原句；Jev 没配上就不显示，直连 TypeSafe 时只去掉「经 OpenRouter 」', () => {
  assert.ok(page.includes(CONFIRMED), '原句一字不改');
  assert.match(page, /const config = jevConfig\(/, '显不显示由 jevConfig 决定');
  assert.match(page, /if \(!config\) return null;/, '没配上就不显示');
  assert.ok(page.includes('JEV_PRIVACY.replace("经 OpenRouter ", "")'), '直连时只去掉「经 OpenRouter 」');
  assert.match(page, /\{jev \? \(/, '只在有这句话时才渲染那一条');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SAFETY_RULES as workerRules} from '../hosted/lib/weave/model.mjs';
import {SAFETY_RULES as agentRules, systemPromptFor, memorySection} from '../hosted/agent-service/prompts.mjs';

// The Agent service is deployed on its own, so it carries a copy; this keeps the two from drifting.
test('agent-service 的 SAFETY_RULES 和 model.mjs 一字不差', () => {
  assert.equal(agentRules, workerRules);
});

// The system prompt is read and approved in docs/ARCHITECTURE.md section 5; prompts.mjs is a copy of it.
// The doc writes the health rule as a placeholder, so that line is filled in before comparing.
test('系统提示和 docs/ARCHITECTURE.md 第 5 节的原文一字不差', () => {
  const doc = readFileSync(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8');
  const section = doc.indexOf('**系统提示（待确认的文案）：**');
  assert.ok(section > 0, 'section 5 heading');
  const open = doc.indexOf('```text\n', section) + '```text\n'.length, close = doc.indexOf('\n```', open);
  const written = doc.slice(open, close).replace('健康安全：（现有 SAFETY_RULES 原文）', agentRules);
  const prompt = systemPromptFor({kind: 'owner'}, '');
  assert.ok(prompt.endsWith(memorySection('')));
  assert.equal(prompt.slice(0, -memorySection('').length), written);
});

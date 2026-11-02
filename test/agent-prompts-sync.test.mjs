import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SAFETY_RULES as workerRules} from '../hosted/lib/weave/model.mjs';
import {SAFETY_RULES as agentRules} from '../hosted/agent-service/prompts.mjs';

// The Agent service is deployed on its own, so it carries a copy; this keeps the two from drifting.
test('agent-service 的 SAFETY_RULES 和 model.mjs 一字不差', () => {
  assert.equal(agentRules, workerRules);
});

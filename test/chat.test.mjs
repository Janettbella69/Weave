import {test} from 'node:test';import assert from 'node:assert/strict';import {chatIntent,sleepHours} from '../chat.mjs';
test('asks for missing sleep instead of assuming a value',()=>{const r=chatIntent('今天加班，想运动');assert.equal(r.kind,'clarify');assert.equal(r.pending,'今天加班，想运动');});
test('follow-up retains original context and parses hours',()=>{const r=chatIntent('5 小时','今晚朋友聚餐，有点累');assert.equal(r.kind,'plan');assert.equal(r.context.sleep,5);assert.match(r.context.text,/聚餐/);});
test('decimal sleep input and explicit feedback are distinguished',()=>{assert.equal(sleepHours('昨晚睡了 6.5 小时'),6.5);assert.equal(chatIntent('反馈：午饭后散步更容易坚持').kind,'feedback');assert.equal(chatIntent('你好').kind,'reply');});
test('rejects empty feedback and out of range sleep',()=>{assert.throws(()=>chatIntent('反馈：'));assert.throws(()=>chatIntent('睡了 20 小时'));assert.throws(()=>chatIntent(''));});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLedger} from '../ledger.mjs';

const fileIn = () => join(mkdtempSync(join(tmpdir(), 'weave-ledger-')), 'usage.json');

test('新实例读同一个文件，用量还在（服务重启不会把额度清零）', () => {
  const file = fileIn(), now = () => Date.parse('2026-11-02T08:00:00Z');
  const a = createLedger({file, now});
  a.add('u:alice', 100);
  a.add('u:alice', 50);
  a.add('u:bob', 7);
  const b = createLedger({file, now});
  assert.equal(b.used('u:alice'), 150);
  assert.equal(b.used('u:bob'), 7);
  assert.equal(b.used('u:nobody'), 0);
  assert.equal(b.total(), 157);
});

test('换了 UTC 日期从零开始', () => {
  const file = fileIn();
  let clock = Date.parse('2026-11-02T23:59:00Z');
  const ledger = createLedger({file, now: () => clock});
  ledger.add('u:alice', 400);
  clock = Date.parse('2026-11-03T00:01:00Z');
  assert.equal(ledger.used('u:alice'), 0);
  assert.equal(ledger.total(), 0);
  ledger.add('u:alice', 5);
  assert.equal(createLedger({file, now: () => clock}).used('u:alice'), 5);
});

test('文件坏了当作空账本，不让服务起不来', () => {
  const file = fileIn();
  writeFileSync(file, '{not json');
  const ledger = createLedger({file, now: () => Date.parse('2026-11-02T08:00:00Z')});
  assert.equal(ledger.total(), 0);
  ledger.add('u:alice', 3);
  assert.equal(ledger.used('u:alice'), 3);
});

test('账号名是 __proto__ 也不会读到原型上的东西', () => {
  const ledger = createLedger({file: fileIn(), now: () => Date.parse('2026-11-02T08:00:00Z')});
  assert.equal(ledger.used('__proto__'), 0);
  assert.equal(ledger.used('constructor'), 0);
});

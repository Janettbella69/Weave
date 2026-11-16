// Every skill a scope lists has its SKILL.md in the plugin, with the same frontmatter name. The weekly-review text names
// the notebook file, a table and its script; this keeps those names real, so a rename on either side shows up here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SCOPES, scopeFor} from '../scopes.mjs';
import {NOTEBOOK_FILE, SCHEMA} from '../notebook.mjs';

const PLUGIN_DIR = fileURLToPath(new URL('../plugin', import.meta.url));
const PLUGIN_NAME = JSON.parse(readFileSync(join(PLUGIN_DIR, '.claude-plugin/plugin.json'), 'utf8')).name;
const frontmatter = text => {
  const block = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  return block ? Object.fromEntries(block.split('\n').map(line => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()])) : null;
};

test('范围里列的每个 Skill 都有 SKILL.md，frontmatter 的 name 和名单对得上', () => {
  const listed = Object.values(SCOPES).flatMap(scope => [...scope.skills]);
  assert.deepEqual(listed, ['weave:weekly-review']);
  for (const full of listed) {
    const [plugin, name] = full.split(':');
    assert.equal(plugin, PLUGIN_NAME, full);
    const file = join(PLUGIN_DIR, 'skills', name, 'SKILL.md');
    assert.ok(existsSync(file), file);
    assert.equal(frontmatter(readFileSync(file, 'utf8'))?.name, name, file);
  }
});

test('weekly-review：读的是本子 records.db 的 completions 表，参考脚本在；群里没有这个 Skill', () => {
  const text = readFileSync(join(PLUGIN_DIR, 'skills/weekly-review/SKILL.md'), 'utf8');
  assert.ok(text.includes(NOTEBOOK_FILE) && !text.includes('weave/weave.db'), text);
  assert.ok(text.includes('completions') && SCHEMA.includes('CREATE TABLE IF NOT EXISTS completions'));
  assert.ok(existsSync(join(PLUGIN_DIR, 'skills/weekly-review/scripts/stats.py')));
  assert.ok(!scopeFor('group').skills.includes('weave:weekly-review'));
});

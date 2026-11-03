// Every skill a scope lists has its SKILL.md in the plugin, with the same frontmatter name. The proactive-judgment
// text names tools and snapshot tables; this keeps those names real, so a rename on either side shows up here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SCOPES, scopeFor} from '../scopes.mjs';
import {TOOL_DEFS} from '../mcp/tools.mjs';
import {TABLES} from '../snapshot.mjs';

const PLUGIN_DIR = fileURLToPath(new URL('../plugin', import.meta.url));
const PLUGIN_NAME = JSON.parse(readFileSync(join(PLUGIN_DIR, '.claude-plugin/plugin.json'), 'utf8')).name;
const frontmatter = text => {
  const block = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  return block ? Object.fromEntries(block.split('\n').map(line => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()])) : null;
};

test('范围里列的每个 Skill 都有 SKILL.md，frontmatter 的 name 和名单对得上', () => {
  const listed = Object.values(SCOPES).flatMap(scope => [...scope.skills]);
  assert.ok(listed.includes('weave:proactive-judgment') && listed.includes('weave:weekly-review'), listed.join(', '));
  for (const full of listed) {
    const [plugin, name] = full.split(':');
    assert.equal(plugin, PLUGIN_NAME, full);
    const file = join(PLUGIN_DIR, 'skills', name, 'SKILL.md');
    assert.ok(existsSync(file), file);
    assert.equal(frontmatter(readFileSync(file, 'utf8'))?.name, name, file);
  }
});

test('proactive-judgment：description 是架构文档第 5 节那句；正文提到的工具都在 owner 范围里，表都在快照里', () => {
  const text = readFileSync(join(PLUGIN_DIR, 'skills/proactive-judgment/SKILL.md'), 'utf8');
  assert.deepEqual(frontmatter(text), {name: 'proactive-judgment', description: '被定时或事件叫醒，要决定现在值不值得开口时使用。'});
  for (const tool of ['send_message', 'schedule_wake', 'cancel_schedule']) {
    assert.ok(text.includes(tool), tool);
    assert.ok(scopeFor('owner').tools.includes(tool) && Object.hasOwn(TOOL_DEFS, tool), tool);
  }
  for (const table of ['habits', 'completions', 'goals', 'schedules', 'proactive_settings']) {
    assert.ok(text.includes(table), table);
    assert.ok(Object.hasOwn(TABLES, table), table);
  }
  assert.ok(!scopeFor('group').skills.includes('weave:proactive-judgment'), '群里没有这个 Skill');
});

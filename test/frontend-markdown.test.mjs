import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseMarkdown,parseInline,safeHref} from '../hosted/app/workspace/markdown.mjs';

const text=value=>({type:'text',text:value});
const flat=nodes=>nodes.map(n=>n.type==='text'?n.text:n.type==='br'?'\n':n.children?flat(n.children):n.text||'').join('');
const walk=(nodes,visit)=>{for(const n of nodes){visit(n);if(n.children)walk(n.children,visit);if(n.items)for(const item of n.items){walk(item.children,visit);walk(item.sublists,visit);}}};

test('the agent reply from the owner screenshots renders as bold, a list and a link',()=>{
  const blocks=parseMarkdown('**1. 帮你养成习惯**\n- 每天走路 10 分钟\n- 睡前放下手机\n\n*小提示*：先从最容易的开始，详见 [Weave](https://example.com/a?b=1&c=2)。');
  assert.deepEqual(blocks[0],{type:'p',children:[{type:'strong',children:[text('1. 帮你养成习惯')]}]});
  assert.equal(blocks[1].type,'list');assert.equal(blocks[1].ordered,false);
  assert.deepEqual(blocks[1].items.map(i=>flat(i.children)),['每天走路 10 分钟','睡前放下手机']);
  assert.deepEqual(blocks[2].children.map(n=>n.type),['em','text','link','text']);
  assert.equal(blocks[2].children[2].href,'https://example.com/a?b=1&c=2');
});

test('ordered and nested lists keep their order, start number and nesting',()=>{
  const [list]=parseMarkdown('3. 第三\n   - 子项一\n   - 子项二\n4. 第四');
  assert.equal(list.ordered,true);assert.equal(list.start,3);
  assert.equal(list.items.length,2);
  assert.equal(list.items[0].sublists.length,1);
  assert.deepEqual(list.items[0].sublists[0].items.map(i=>flat(i.children)),['子项一','子项二']);
  const loose=parseMarkdown('1. a\n\n2. b\n\n3. c');
  assert.equal(loose.length,1);assert.equal(loose[0].items.length,3);
});

test('a line right before a list does not swallow it, and a different list kind starts a new list',()=>{
  const blocks=parseMarkdown('你可以：\n- a\n- b\n1. 先\n2. 后');
  assert.deepEqual(blocks.map(b=>b.type),['p','list','list']);
  assert.equal(blocks[1].ordered,false);assert.equal(blocks[2].ordered,true);
});

test('line breaks inside a paragraph become br nodes; blank lines split paragraphs',()=>{
  const blocks=parseMarkdown('第一行\n第二行\n\n另一段');
  assert.equal(blocks.length,2);
  assert.deepEqual(blocks[0].children,[text('第一行'),{type:'br'},text('第二行')]);
});

test('markup the model writes is text, never HTML',()=>{
  const blocks=parseMarkdown('<img src=x onerror=alert(1)> <script>alert(2)</script> &amp; **<b>x</b>**');
  const all=[];walk(blocks,n=>all.push(n));
  assert.ok(all.every(n=>['p','text','strong','br'].includes(n.type)),'only the known node types');
  assert.ok(flat(blocks[0].children).includes('<img src=x onerror=alert(1)>'));
  assert.ok(flat(blocks[0].children).includes('<script>alert(2)</script>'));
});

test('only http(s) and mailto links survive; everything else is plain text',()=>{
  for(const bad of ['javascript:alert(1)','JaVaScRiPt:alert(1)','data:text/html,<b>x</b>','vbscript:x','//evil.example/x','/relative','file:///etc/passwd',' javascript:alert(1)','java\nscript:alert(1)']){
    assert.equal(safeHref(bad),null,bad);
    const nodes=parseInline('[点我]('+bad.replace(/\n/g,'')+')');
    assert.ok(!nodes.some(n=>n.type==='link'),bad);
  }
  assert.equal(safeHref('https://example.com/x?y=1'),'https://example.com/x?y=1');
  assert.equal(safeHref('http://example.com'),'http://example.com/');
  assert.equal(safeHref('mailto:a@b.co'),'mailto:a@b.co');
  const [link]=parseInline('[a](https://example.com "title")');
  assert.deepEqual(link,{type:'link',href:'https://example.com/',children:[text('a')]});
});

test('a link address may contain one level of parentheses, so a refused link leaves no stray text',()=>{
  assert.equal(flat(parseInline('见 [百科](https://en.wikipedia.org/wiki/Foo_(bar)) 页面')),'见 百科 页面');
  assert.equal(parseInline('[百科](https://en.wikipedia.org/wiki/Foo_(bar))')[0].href,'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.equal(flat(parseInline('还有 [坏链接](javascript:alert(1)) 和')),'还有 坏链接 和');
});

test('a link label cannot hold another link, and the label of a refused link stays visible',()=>{
  const nodes=parseInline('[see https://inner.example](https://outer.example)');
  assert.equal(nodes.length,1);assert.equal(nodes[0].type,'link');
  assert.ok(!nodes[0].children.some(n=>n.type==='link'));
  assert.equal(flat(parseInline('[点我](javascript:x)')),'点我');
});

test('bare links are found next to Chinese punctuation and without the trailing mark',()=>{
  const nodes=parseInline('已保存到 https://notion.so/abc-123。再见 (https://example.com/x).');
  const links=nodes.filter(n=>n.type==='link');
  assert.deepEqual(links.map(n=>n.href),['https://notion.so/abc-123','https://example.com/x']);
  assert.equal(flat(nodes),'已保存到 https://notion.so/abc-123。再见 (https://example.com/x).');
  assert.ok(!parseInline('xhttps://notword.example').some(n=>n.type==='link'),'not inside a word');
});

test('bold works next to Chinese text and punctuation; stray markers stay literal',()=>{
  assert.deepEqual(parseInline('**重点：**文字'),[{type:'strong',children:[text('重点：')]},text('文字')]);
  assert.deepEqual(parseInline('今天**很好**。'),[text('今天'),{type:'strong',children:[text('很好')]},text('。')]);
  assert.equal(flat(parseInline('**没有结尾')),'**没有结尾');
  assert.equal(flat(parseInline('2 * 3 * 4')),'2 * 3 * 4');
  assert.deepEqual(parseInline('snake_case_name and a_b_c'),[text('snake_case_name and a_b_c')]);
  assert.deepEqual(parseInline('***又粗又斜***'),[{type:'strong',children:[{type:'em',children:[text('又粗又斜')]}]}]);
  assert.deepEqual(parseInline('_斜体_ 和 *斜体*').filter(n=>n.type==='em').length,2);
});

test('code spans and blocks are not parsed further',()=>{
  assert.deepEqual(parseInline('用 `**x**` 试试'),[text('用 '),{type:'code',text:'**x**'},text(' 试试')]);
  const blocks=parseMarkdown('```js\nconst a = "**x**";\n- not a list\n```\n之后');
  assert.deepEqual(blocks[0],{type:'code',text:'const a = "**x**";\n- not a list'});
  assert.equal(blocks[1].type,'p');
  assert.equal(parseMarkdown('```\n没有结尾')[0].text,'没有结尾');
});

test('headings and rules; # without a space is not a heading',()=>{
  const blocks=parseMarkdown('### 小标题 ###\n\n---\n\n#标签');
  assert.equal(blocks[0].type,'heading');assert.equal(blocks[0].level,3);assert.equal(flat(blocks[0].children),'小标题');
  assert.equal(blocks[1].type,'hr');
  assert.equal(blocks[2].type,'p');
});

test('backslash escapes and <br> work',()=>{
  assert.equal(flat(parseInline('\\*不是斜体\\* 和 1\\. 点')),'*不是斜体* 和 1. 点');
  assert.deepEqual(parseInline('a<br>b<br/>c').map(n=>n.type),['text','br','text','br','text']);
});

test('empty and non-string input give no blocks; huge input stays one plain paragraph',()=>{
  assert.deepEqual(parseMarkdown(''),[]);assert.deepEqual(parseMarkdown(null),[]);assert.deepEqual(parseMarkdown(undefined),[]);assert.deepEqual(parseMarkdown('  \n '),[]);
  const huge=parseMarkdown('**x** '.repeat(20000));
  assert.equal(huge.length,1);assert.deepEqual(huge[0].children.map(n=>n.type),['text']);
});

test('pathological input finishes quickly and does not recurse without bound',()=>{
  const started=Date.now();
  parseMarkdown('*'.repeat(5000));parseMarkdown('['.repeat(3000)+'](x)');parseMarkdown('**a '.repeat(3000));
  parseMarkdown('_'.repeat(5000));parseMarkdown('`'.repeat(4000));parseMarkdown('h'.repeat(20000));
  const nested=Array.from({length:150},(_,k)=>' '.repeat(k*2)+'- x').join('\n');
  const [list]=parseMarkdown(nested);
  let depth=0;for(let node=list;node&&node.items;node=node.items[node.items.length-1].sublists[0])depth++;
  assert.ok(depth<=6,'list nesting is capped, got '+depth);
  parseMarkdown('*a '.repeat(2000)+'*b'.repeat(2000));
  assert.ok(Date.now()-started<3000,'took '+(Date.now()-started)+' ms');
});

test('the renderer never writes HTML itself',async()=>{
  const component=await readFile(new URL('../hosted/app/workspace/Markdown.jsx',import.meta.url),'utf8');
  assert.ok(!component.includes('dangerouslySetInnerHTML'));
  assert.ok(component.includes('noopener noreferrer'));
});

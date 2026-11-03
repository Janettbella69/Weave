import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NOTION_TEXT,readNotionReturn,resolveNotionReturn,notionErrorText,needsPagesReason,needsPagesText,notionRow,normalizePickerPages} from '../hosted/app/workspace/notion-return.mjs';

// What the callback can send (hosted/lib/weave/notion-connect.mjs) and what the page says for each.
const CODES=['access_denied','notion_error','bad_code_state','missing_state','missing_config','exchange_failed','no_pages','search_failed','server_error'];

test('every callback code has a sentence; only the ones with a different next step get their own',()=>{
  for(const code of CODES)assert.ok(notionErrorText(code).length>0,code);
  assert.equal(notionErrorText('missing_config'),'Notion 连接暂不可用，请稍后重试');
  assert.equal(notionErrorText('no_pages'),NOTION_TEXT.noPages);
  assert.equal(notionErrorText('search_failed'),NOTION_TEXT.searchFailed);
  for(const code of ['access_denied','notion_error','bad_code_state','missing_state','exchange_failed','server_error','','something_new',undefined])assert.equal(notionErrorText(code),'Notion 连接未完成，请重试',String(code));
});

test('the new sentences name only buttons that exist, and show no ids or codes',()=>{
  assert.ok(NOTION_TEXT.noPages.includes('「连接」')&&NOTION_TEXT.searchFailed.includes('「重试」'));
  for(const text of Object.values(NOTION_TEXT))assert.ok(!/[0-9a-f]{8}-|detail|_/.test(text),text);
  assert.equal(needsPagesReason('no_pages'),'no_pages');assert.equal(needsPagesReason('search_failed'),'search_failed');assert.equal(needsPagesReason('exchange_failed'),'');
  assert.equal(needsPagesText('no_pages'),NOTION_TEXT.noPages);assert.equal(needsPagesText('x'),'');
});

const ask=(...answers)=>{const asked=[];return {asked,getConnection:async()=>{asked.push(1);const next=answers.shift();if(next instanceof Error)throw next;return next;},legacyPages:async()=>null};};

test('status=connected lands as connected; it is checked, but an unreachable check does not undo it',async()=>{
  const ok=ask({state:'connected',page:{title:'我的长期记忆'}});
  assert.deepEqual(await resolveNotionReturn({status:'connected',detail:''},ok),{kind:'connected'});
  assert.deepEqual(await resolveNotionReturn({status:'connected',detail:''},ask(new Error('offline'))),{kind:'connected'});
  assert.deepEqual(await resolveNotionReturn({status:'connected',detail:''},ask({state:'disconnected'})),{kind:'failed',message:'Notion 连接未完成，请重试'},'someone typed the address by hand');
});

test('a callback opened twice (missing_state, bad_code_state) is a success when Notion is connected already',async()=>{
  for(const detail of ['missing_state','bad_code_state']){
    const probe=ask({state:'connected',page:{title:'x'}});
    assert.deepEqual(await resolveNotionReturn({status:'error',detail},probe),{kind:'connected'},detail);
    assert.equal(probe.asked.length,1,'asks before saying anything');
    assert.deepEqual(await resolveNotionReturn({status:'error',detail},ask({state:'disconnected'})),{kind:'failed',message:'Notion 连接未完成，请重试'},detail);
    assert.deepEqual(await resolveNotionReturn({status:'error',detail},ask(new Error('offline'))),{kind:'failed',message:'Notion 连接未完成，请重试'},detail);
    assert.deepEqual(await resolveNotionReturn({status:'error',detail},ask({state:'needs_pages',reason:'no_pages'})),{kind:'failed',message:'Notion 连接未完成，请重试'},detail);
  }
});

test('the other error codes do not ask anything first',async()=>{
  for(const detail of CODES.filter(code=>!['missing_state','bad_code_state'].includes(code))){
    const probe=ask({state:'connected'});
    const outcome=await resolveNotionReturn({status:'error',detail},probe);
    assert.equal(probe.asked.length,0,detail);
    if(detail==='no_pages'||detail==='search_failed')assert.deepEqual(outcome,{kind:'needs_pages',reason:detail});
    else assert.deepEqual(outcome,{kind:'failed',message:notionErrorText(detail)},detail);
  }
});

test('status=ready still goes through the older pick-a-page step',async()=>{
  const base={getConnection:async()=>{throw new Error('not used');}};
  assert.deepEqual(await resolveNotionReturn({status:'ready',detail:''},{...base,legacyPages:async()=>({pages:[{id:'a',title:'A'}]})}),{kind:'pick',pages:[{id:'a',title:'A'}]});
  assert.deepEqual(await resolveNotionReturn({status:'ready',detail:''},{...base,legacyPages:async()=>({connected:true})}),{kind:'connected'});
  assert.deepEqual(await resolveNotionReturn({status:'ready',detail:''},{...base,legacyPages:async()=>null}),{kind:'failed',message:'Notion 连接未完成，请重试'});
  await assert.rejects(resolveNotionReturn({status:'ready',detail:''},{...base,legacyPages:async()=>{throw new Error('请求失败');}}),{message:'请求失败'});
});

test('the Notion row: shown unless the site has no Notion and nothing is connected; title only when connected',()=>{
  const connected={state:'connected',page:{title:' 我的长期记忆 '},workspace:'测试工作区'};
  assert.deepEqual(notionRow({connection:connected,connected:true,configured:true}),{title:'我的长期记忆',needsPages:'',note:'',shown:true});
  assert.equal(notionRow({connection:connected,connected:false,configured:true}).title,'','no title once disconnected, even before the answer catches up');
  assert.equal(notionRow({connection:{state:'connected',page:{title:''}},connected:true,configured:true}).title,'','manual connections have no title');
  assert.equal(notionRow({connection:null,connected:true,configured:true}).title,'');
  // site without Notion set up
  assert.equal(notionRow({connection:{state:'unavailable'},connected:false,configured:false}).shown,false);
  assert.equal(notionRow({connection:null,connected:false,configured:undefined}).shown,true,'older servers do not say; show it');
  assert.equal(notionRow({connection:connected,connected:true,configured:false}).shown,true,'something is connected: it can still be disconnected');
  const waiting=notionRow({connection:{state:'needs_pages',reason:'no_pages'},connected:false,configured:false});
  assert.equal(waiting.shown,true);assert.equal(waiting.needsPages,'no_pages');assert.equal(waiting.note,NOTION_TEXT.noPages);
  assert.equal(notionRow({connection:{state:'needs_pages',reason:'search_failed'},connected:false,configured:true}).note,NOTION_TEXT.searchFailed);
  // a leftover from the older flow has pages waiting, but nothing to say here: 「连接」 opens its list
  const leftover=notionRow({connection:{state:'needs_pages',reason:'not_finished'},connected:false,configured:true});
  assert.equal(leftover.needsPages,'');assert.equal(leftover.note,'');
  assert.equal(notionRow({connection:{state:'needs_pages',reason:'no_pages'},connected:true,configured:true}).needsPages,'','connected wins');
});

test('the pages to change to carry titles and mark the current one, whatever the id spelling',()=>{
  const result={selectedId:'11111111-2222-3333-4444-555555555555',pages:[
    {id:'66666666-7777-8888-9999-000000000000',title:'Weave 记忆',topLevel:true},
    {id:'11111111222233334444555555555555',title:'我的页面',topLevel:true},
    {id:'aaaaaaaa-0000-0000-0000-000000000000',title:'',topLevel:false},
    {title:'没有 id'},null]};
  assert.deepEqual(normalizePickerPages(result),[
    {id:'66666666-7777-8888-9999-000000000000',title:'Weave 记忆',selected:false},
    {id:'11111111222233334444555555555555',title:'我的页面',selected:true},
    {id:'aaaaaaaa-0000-0000-0000-000000000000',title:'未命名页面',selected:false}]);
  assert.deepEqual(normalizePickerPages({pages:[{id:'x',title:'y'}]}),[{id:'x',title:'y',selected:false}]);
  assert.deepEqual(normalizePickerPages(undefined),[]);assert.deepEqual(normalizePickerPages({pages:'no'}),[]);
});

test('an unknown status in the address is an error, never a success',()=>{
  assert.deepEqual(readNotionReturn('?connection=notion&status=CONNECTED'),{status:'error',detail:''});
  assert.deepEqual(readNotionReturn('?connection=notion&status=connected&detail=x'),{status:'connected',detail:'x'});
});

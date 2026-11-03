import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {WECHAT_TEXT,wechatRow} from '../hosted/app/workspace/wechat-row.mjs';

// Wording the owner approved, as written. Do not edit these two lines without asking.
const SOON='即将开通';
const NOTE='开通后，你可以直接在微信里和 Weave 聊天，也能把它拉进群里一起打卡。';

test('the approved wording is used exactly as written',()=>{
  assert.equal(WECHAT_TEXT.soon,SOON);
  assert.equal(WECHAT_TEXT.soonNote,NOTE);
  assert.deepEqual(Object.keys(WECHAT_TEXT).sort(),['soon','soonNote'],'no other new wording in the module');
});

test('the WeChat row is always there; what it offers follows the server',()=>{
  // not configured, not bound: a badge and the sentence, nothing to press
  for(const wechat of [undefined,null,{},{configured:false,online:false,bound:false}]){
    assert.deepEqual(wechatRow(wechat),{kind:'soon',connect:false,disconnect:false,badge:SOON,note:NOTE,card:false},JSON.stringify(wechat));
  }
  // configured, not bound: the connect flow as it was
  for(const wechat of [{configured:true,online:false,bound:false},{configured:true,online:true,bound:false}]){
    assert.deepEqual(wechatRow(wechat),{kind:'connect',connect:true,disconnect:false,badge:'',note:'',card:true},JSON.stringify(wechat));
  }
  // bound: connected as it was (also when the server lost its config afterwards)
  for(const wechat of [{configured:true,online:true,bound:true},{configured:false,online:false,bound:true}]){
    assert.deepEqual(wechatRow(wechat),{kind:'connected',connect:false,disconnect:true,badge:'已连接',note:'',card:false},JSON.stringify(wechat));
  }
});

test('no state offers a button that cannot work, and the unfinished one carries no error',()=>{
  for(const wechat of [undefined,{configured:false,bound:false},{configured:true,bound:false},{configured:true,bound:true}]){
    const row=wechatRow(wechat);
    assert.ok(!(row.connect&&row.disconnect),'connect and disconnect never together');
    assert.ok(!(row.kind==='soon'&&(row.connect||row.disconnect)),'no button before it is set up');
    assert.ok(row.card===row.connect,'the card, which says to press 「连接」, shows only next to that button');
    assert.ok(!/暂不可用|失败|错误/.test(row.badge+row.note),'not worded as a failure');
  }
});

const walk=async dir=>(await Promise.all((await readdir(dir,{withFileTypes:true})).map(entry=>entry.isDirectory()?walk(new URL(entry.name+'/',dir)):[new URL(entry.name,dir)]))).flat();

const appSources=async()=>{
  const files=await walk(new URL('../hosted/app/',import.meta.url));
  return Promise.all(files.filter(file=>/\.(jsx?|mjs|tsx?)$/.test(file.pathname)).map(async file=>[file.pathname,await readFile(file,'utf8')]));
};

test('the sentence has one home, and the old hiding and dead button are gone',async()=>{
  const sources=await appSources();
  assert.deepEqual(sources.filter(([,text])=>text.includes(NOTE)).map(([path])=>path.split('/').pop()),['wechat-row.mjs']);
  const workspace=sources.find(([path])=>path.endsWith('/Workspace.jsx'))[1];
  assert.ok(!workspace.includes('wechatShown'),'the row is no longer hidden');
  assert.ok(!workspace.includes('disabled={!state.settings.wechat'),'no disabled connect button');
  for(const [path,text] of sources)assert.ok(!text.includes('微信连接暂不可用'),path+' brings back the old unavailable wording');
});

test('the row follows the server, and the card the row',{todo:'Task 10 moves the WeChat row into SettingsPage.jsx'},async()=>{
  const workspace=(await appSources()).find(([path])=>path.endsWith('/Workspace.jsx'))[1];
  assert.ok(workspace.includes('wechatRow(state.settings.wechat)'));
  assert.ok(workspace.includes('{wechat.card&&'),'the card follows the same state as the row');
});

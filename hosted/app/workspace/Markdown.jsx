'use client';
import {Fragment,useMemo} from 'react';
import {parseMarkdown} from './markdown.mjs';

// Renders the safe Markdown subset from markdown.mjs. Every string goes through React (escaped), nothing is
// written as raw HTML, and links only ever carry http(s)/mailto addresses.
function Inline({nodes}){
  return nodes.map((node,index)=>{
    if(node.type==='text')return <Fragment key={index}>{node.text}</Fragment>;
    if(node.type==='br')return <br key={index}/>;
    if(node.type==='code')return <code key={index}>{node.text}</code>;
    if(node.type==='strong')return <strong key={index}><Inline nodes={node.children}/></strong>;
    if(node.type==='em')return <em key={index}><Inline nodes={node.children}/></em>;
    if(node.type==='link')return <a key={index} href={node.href} target="_blank" rel="noopener noreferrer"><Inline nodes={node.children}/></a>;
    return null;
  });
}
function List({list}){
  const Tag=list.ordered?'ol':'ul';
  return <Tag start={list.ordered&&list.start!==1?list.start:undefined}>{list.items.map((item,index)=><li key={index}><Inline nodes={item.children}/>{item.sublists.map((sub,i)=><List key={i} list={sub}/>)}</li>)}</Tag>;
}
export default function Markdown({text}){
  const blocks=useMemo(()=>parseMarkdown(text),[text]);
  return <>{blocks.map((block,index)=>{
    if(block.type==='p')return <p key={index}><Inline nodes={block.children}/></p>;
    if(block.type==='heading')return <p key={index} className="md-heading"><strong><Inline nodes={block.children}/></strong></p>;
    if(block.type==='list')return <List key={index} list={block}/>;
    if(block.type==='code')return <pre key={index}><code>{block.text}</code></pre>;
    if(block.type==='hr')return <hr key={index}/>;
    return null;
  })}</>;
}

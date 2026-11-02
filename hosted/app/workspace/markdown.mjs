// A deliberately tiny, safe Markdown subset for agent replies:
//   paragraphs, # headings, - / * / 1. lists (nested by indent), ``` code blocks, --- rules,
//   **bold**, *italic*, `code`, [text](https://…), bare https:// links and line breaks.
//
// It returns plain data and never HTML. The React side (Markdown.jsx) turns every node into an element,
// and React escapes every string, so nothing the model writes can inject markup. Only http(s) and mailto
// links are kept; anything else (javascript:, data:, relative paths) is shown as plain text.
//
// Nodes (inline):  {type:'text',text} {type:'br'} {type:'strong',children} {type:'em',children}
//                  {type:'code',text} {type:'link',href,children}
// Nodes (block):   {type:'p',children} {type:'heading',level,children} {type:'list',ordered,start,items}
//                  {type:'code',text} {type:'hr'}      item = {children, sublists}

const MAX_LENGTH = 60000;
const MAX_DEPTH = 6;
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const ESCAPABLE = '\\`*_{}[]()#+-.!>~|';
const isSpace = ch => ch === undefined || /\s/.test(ch);
const isWordChar = ch => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

export function safeHref(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || /[\u0000-\u001f\u007f\s]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
}

// The next closing marker (e.g. '**') after `from` that is not preceded by whitespace.
function findClose(s, from, marker) {
  let k = s.indexOf(marker, from);
  while (k !== -1) {
    if (k > from && !isSpace(s[k - 1])) return k;
    k = s.indexOf(marker, k + 1);
  }
  return -1;
}

const BARE_URL = /^https?:\/\/[^\s<>"'`，。！？；：、）】」』》（【「『《]+/i;
const LINK = /^\[([^\]\n]{1,300})\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/;

export function parseInline(source, depth = 0, noLinks = false) {
  const s = typeof source === 'string' ? source : '';
  const nodes = [];
  let text = '';
  const flush = () => { if (text) { nodes.push({type: 'text', text}); text = ''; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) { text += s[i + 1]; i += 2; continue; }
    if (c === '\n') { text = text.replace(/ +$/, ''); flush(); nodes.push({type: 'br'}); i++; continue; }
    if (c === '<') {
      const br = /^<br\s*\/?>/i.exec(s.slice(i, i + 8));
      if (br) { flush(); nodes.push({type: 'br'}); i += br[0].length; continue; }
    }
    if (c === '`') {
      let n = 1; while (s[i + n] === '`') n++;
      const fence = '`'.repeat(n), end = s.indexOf(fence, i + n);
      if (end > i + n) { flush(); nodes.push({type: 'code', text: s.slice(i + n, end).replace(/\n/g, ' ').replace(/^ (.+) $/, '$1')}); i = end + n; continue; }
      text += fence; i += n; continue;
    }
    if (c === '[' && !noLinks && depth < MAX_DEPTH) {
      const m = LINK.exec(s.slice(i, i + 2400));
      if (m) {
        const href = safeHref(m[2]), children = parseInline(m[1], depth + 1, true);
        flush();
        if (href) nodes.push({type: 'link', href, children}); else nodes.push(...children);
        i += m[0].length; continue;
      }
    }
    if ((c === 'h' || c === 'H') && !noLinks && !isWordChar(s[i - 1]) && s.slice(i, i + 4).toLowerCase() === 'http') {
      const m = BARE_URL.exec(s.slice(i, i + 2100));
      if (m) {
        const shown = m[0].replace(/[.,;:!?)\]}'"*_~]+$/, ''), href = safeHref(shown);
        if (href) { flush(); nodes.push({type: 'link', href, children: [{type: 'text', text: shown}]}); i += shown.length; continue; }
      }
    }
    if ((c === '*' || c === '_') && depth < MAX_DEPTH) {
      // ***bold italic***
      if (s.startsWith(c.repeat(3), i) && !isSpace(s[i + 3])) {
        const k = findClose(s, i + 3, c.repeat(3));
        if (k !== -1) { flush(); nodes.push({type: 'strong', children: [{type: 'em', children: parseInline(s.slice(i + 3, k), depth + 2, noLinks)}]}); i = k + 3; continue; }
      }
      // **bold** (no word-boundary rule for *, so it also works next to Chinese text and punctuation)
      if (s[i + 1] === c && !isSpace(s[i + 2]) && (c === '*' || !isWordChar(s[i - 1]))) {
        const k = findClose(s, i + 2, c + c);
        if (k !== -1 && (c === '*' || !isWordChar(s[k + 2]))) {
          flush(); nodes.push({type: 'strong', children: parseInline(s.slice(i + 2, k), depth + 1, noLinks)}); i = k + 2; continue;
        }
      }
      // *italic*  (a single marker that is not part of a double one)
      if (s[i + 1] !== c && !isSpace(s[i + 1]) && (c === '*' || !isWordChar(s[i - 1]))) {
        let k = s.indexOf(c, i + 1);
        while (k !== -1 && (isSpace(s[k - 1]) || s[k + 1] === c || s[k - 1] === c || (c === '_' && isWordChar(s[k + 1])))) k = s.indexOf(c, k + 1);
        if (k !== -1 && k > i + 1) {
          flush(); nodes.push({type: 'em', children: parseInline(s.slice(i + 1, k), depth + 1, noLinks)}); i = k + 1; continue;
        }
      }
    }
    text += c; i++;
  }
  flush();
  return nodes;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ITEM = /^([ \t]*)([-*+•]|\d{1,9}[.)])[ \t]+(.*)$/;
const blank = line => /^\s*$/.test(line);
const indentOf = whitespace => whitespace.replace(/\t/g, '    ').length;
function item(line) {
  const m = ITEM.exec(line);
  if (!m || HR.test(line)) return null;
  const ordered = /\d/.test(m[2]);
  return {indent: indentOf(m[1]), ordered, number: ordered ? parseInt(m[2], 10) : undefined, text: m[3]};
}
const startsBlock = line => FENCE.test(line) || HEADING.test(line) || HR.test(line) || item(line) !== null;

// Lines from `i` on that form one list (and its nested lists). Returns [listNode, nextIndex].
function readList(lines, i) {
  const first = item(lines[i]);
  const root = {type: 'list', ordered: first.ordered, start: first.ordered ? first.number : undefined, items: []};
  const stack = [{indent: first.indent, list: root}];
  const sources = new Map();   // list item -> raw text, parsed once the whole item is known
  const add = (list, text) => { const entry = {children: [], sublists: []}; sources.set(entry, text); list.items.push(entry); return entry; };
  add(root, first.text);
  i++;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      let j = i; while (j < lines.length && blank(lines[j])) j++;
      const next = j < lines.length ? item(lines[j]) : null;
      if (next && next.indent >= first.indent) { i = j; continue; }   // a loose list: blank lines between items
      break;
    }
    const m = item(line);
    if (m) {
      if (m.indent < first.indent) break;
      while (stack.length > 1 && m.indent < stack[stack.length - 1].indent) stack.pop();
      const top = stack[stack.length - 1];
      if (m.indent > top.indent + 1 && stack.length < MAX_DEPTH) {
        const parent = top.list.items[top.list.items.length - 1];
        const child = {type: 'list', ordered: m.ordered, start: m.ordered ? m.number : undefined, items: []};
        parent.sublists.push(child);
        stack.push({indent: m.indent, list: child});
        add(child, m.text);
      } else {
        if (m.ordered !== top.list.ordered && stack.length === 1) break;   // a different kind of list starts here
        add(top.list, m.text);
      }
      i++; continue;
    }
    const lead = indentOf(/^[ \t]*/.exec(line)[0]);
    if (lead > first.indent && !startsBlock(line)) {   // a wrapped line of the last item
      const top = stack[stack.length - 1], last = top.list.items[top.list.items.length - 1];
      sources.set(last, sources.get(last) + '\n' + line.trim());
      i++; continue;
    }
    break;
  }
  const finish = list => { for (const entry of list.items) { entry.children = parseInline(sources.get(entry)); entry.sublists.forEach(finish); } };
  finish(root);
  return [root, i];
}

export function parseMarkdown(source) {
  if (typeof source !== 'string' || !source.trim()) return [];
  const text = source.replace(/\r\n?/g, '\n');
  if (text.length > MAX_LENGTH) return [{type: 'p', children: [{type: 'text', text}]}];
  const lines = text.split('\n'), blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1][0], size = fence[1].length, body = [];
      i++;
      while (i < lines.length && !new RegExp('^ {0,3}' + (mark === '`' ? '`' : '~') + '{' + size + ',}\\s*$').test(lines[i])) body.push(lines[i++]);
      i++;   // the closing fence (or the end of the text)
      blocks.push({type: 'code', text: body.join('\n')});
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({type: 'heading', level: heading[1].length, children: parseInline(heading[2])}); i++; continue; }
    if (HR.test(line)) { blocks.push({type: 'hr'}); i++; continue; }
    if (item(line)) { const [list, next] = readList(lines, i); blocks.push(list); i = next; continue; }
    const paragraph = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i])) paragraph.push(lines[i++].trim());
    blocks.push({type: 'p', children: parseInline(paragraph.join('\n'))});
  }
  return blocks;
}

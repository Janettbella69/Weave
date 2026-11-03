'use client';
import {useEffect, useId, useRef, useState} from 'react';
import {COPY} from '../copy.mjs';
import {NOTION_TEXT, normalizePages, normalizePickerPages, notionRow} from '../notion-return.mjs';
import {retryOnConflict} from '../retry.mjs';
import {bindCodeTimeout, profileForSave, zoneOptions} from '../settings-view.mjs';
import {BIND_HINT, COPY_BIND, NEW_CODE, NEW_CODE_NOTE, UNBIND_CONFIRM, bindMessage, wechatRow} from '../wechat-row.mjs';
import {ChevronDown, MessageCircle, Zap} from '../ui/Icons';
import ViewLink from '../ui/ViewLink';

// 设置 (v3-Settings), three blocks:
//   连接        Notion: the one-click connection of #18 as the old settings page had it (connect, the page picker, 重试
//               when no page came back, 更换页面, 断开); the row is gone when the server has no Notion and nothing is
//               connected or waiting. WeChat: what the row offers follows the server (wechat-row.mjs).
//   时间        the person's zone, saved with the whole profile; the way to the assistant's home page.
//   数据与隐私  what happens to the data, the privacy page, export, and deleting the account.
// After a return from Notion the shell hands this page `notionReturn`: pages to pick from, or why there are none.
export default function SettingsPage(props) {
  return <div className="wv-page">
    <div className="wv-page-column is-settings">
      <h1 className="wv-page-title">{COPY.settings}</h1>
      <Connections {...props}/>
      <Time {...props}/>
      <Data {...props}/>
    </div>
  </div>;
}

// 「已连接」 with the green mark (the board's bolt), and what follows it.
function Connected({children}) {
  return <span className="wv-setting-note">
    <span className="wv-connected-mark is-16" aria-hidden="true"><Zap size={10} strokeWidth={0} fill="currentColor"/></span>
    {children}
  </span>;
}

function Connections(props) {
  const titleId = useId();
  return <section className="wv-settings" aria-labelledby={titleId}>
    <h2 id={titleId}>{COPY.connections}</h2>
    <NotionRow {...props}/>
    <WeChatRow {...props}/>
  </section>;
}

function NotionRow({state, api, act, notionReturn}) {
  const connected = !!state.settings.notion;
  // Where Notion stands (GET connections/notion): read when the page opens, and again when the connection comes or
  // goes. A failure here is not worth a banner: the row still works from the status answer.
  const [connection, setConnection] = useState(null);
  // The page picker. 'complete' finishes a connection that waits for its page (the older flow, or pages already
  // waiting when 「连接 Notion」 is pressed); 'select' switches the page of a connection (「更换页面」).
  const [picker, setPicker] = useState(null);
  useEffect(() => {
    let live = true;
    api('connections/notion').then(result => { if (live) setConnection(result); }, () => {});
    return () => { live = false; };
  }, [api, connected]);
  useEffect(() => {
    if (!notionReturn) return;
    if (notionReturn.kind === 'pick') setPicker({mode: 'complete', pages: notionReturn.pages});
    else if (notionReturn.kind === 'needs_pages') setConnection({state: 'needs_pages', reason: notionReturn.reason});
  }, [notionReturn]);
  const row = notionRow({connection, connected, configured: state.settings.notionConfigured});

  const connect = () => act(async () => {
    const pending = await api('connections/notion/pending');
    const pages = normalizePages(pending.pages);
    if (pending.ready && pages.length) { setPicker({mode: 'complete', pages}); return; }
    const result = await api('connections/notion/start');
    window.location.assign(result.url);
  });
  const pick = page => {
    const select = picker.mode === 'select';
    return act(async () => {
      if (select) setConnection(await api('connections/notion/select', {pageId: page.id}));
      else await api('connections/notion/complete', {pageId: page.id});
      setPicker(null);
    }, select ? '' : NOTION_TEXT.connected);
  };
  // 「更换页面」 opens the list of pages to change to, and closes it again.
  const changePage = () => {
    if (picker && picker.mode === 'select') { setPicker(null); return; }
    act(async () => {
      const pages = normalizePickerPages(await api('connections/notion/pages'));
      if (!pages.length) throw Error(NOTION_TEXT.failed);
      setPicker({mode: 'select', pages});
    });
  };
  // Authorized in Notion but no page yet: look again without going back to Notion.
  const retry = () => act(async () => {
    const result = await api('connections/notion/finish');
    setConnection(result);
    if (result.state !== 'connected') throw Error(NOTION_TEXT.failed);
  }, NOTION_TEXT.connected);
  const disconnect = () => act(async () => {
    await api('connections/notion/disconnect');
    setPicker(null);
    setConnection(null);
  });

  if (!row.shown && !picker) return null;
  return <div className="wv-setting">
    <div className="wv-setting-row">
      <span className="wv-setting-icon is-letter" aria-hidden="true">N</span>
      <div className="wv-setting-text">
        <span className="wv-setting-name">{COPY.notion}</span>
        {connected ? <Connected>{[COPY.connected, row.title && COPY.notionPage(row.title)].filter(Boolean).join(' · ')}</Connected>
          : <span className="wv-setting-note">{row.note || COPY.notionIntro}</span>}
      </div>
      <div className="wv-setting-actions">
        {connected ? <>
          <button type="button" className="wv-button" aria-expanded={!!picker && picker.mode === 'select'} onClick={changePage}>{COPY.changePage}</button>
          <button type="button" className="wv-button" onClick={disconnect}>{COPY.disconnect}</button>
        </> : <>
          {row.needsPages && <button type="button" className="wv-button" onClick={retry}>{COPY.retry}</button>}
          <button type="button" className="wv-button is-primary" onClick={connect}>{COPY.connectNotion}</button>
        </>}
      </div>
    </div>
    {picker && <div className="wv-picker">
      <p className="wv-picker-title">{COPY.pickPage}</p>
      <ul>
        {picker.pages.map(page => <li key={page.id}>
          <button type="button" className="wv-picker-page" disabled={!!page.selected} onClick={() => pick(page)}>
            <span className="wv-picker-name">{page.title}</span>
            <span className="wv-picker-state">{page.selected ? COPY.connected : COPY.choosePage}</span>
          </button>
        </li>)}
      </ul>
    </div>}
  </div>;
}

function WeChatRow({state, api, act}) {
  const wechat = wechatRow(state.settings.wechat);
  // The binding code on screen, {code, timeout}. It goes once the account is bound (the 5 s status poll shows it),
  // when it expires (15 minutes), and after 「断开」.
  const [bind, setBind] = useState(null);
  const bound = wechat.kind === 'connected';
  useEffect(() => { if (bound) setBind(null); }, [bound]);
  useEffect(() => {
    if (!bind) return undefined;
    const timer = setTimeout(() => setBind(null), bind.timeout);
    return () => clearTimeout(timer);
  }, [bind]);
  // 「连接」 goes away when the code shows, so the focus moves on to 「复制绑定消息」.
  const copyButton = useRef(null), message = useRef(null), focusCopy = useRef(false);
  useEffect(() => {
    if (!bind || !focusCopy.current) return;
    focusCopy.current = false;
    if (copyButton.current) copyButton.current.focus();
  }, [bind]);
  const messageId = useId(), hintId = useId();

  // A new code makes the one before it useless (the server keeps one per account).
  const newCode = first => act(async () => {
    const result = await api('wechat/bind', {});
    focusCopy.current = first;
    setBind({code: result.code, timeout: bindCodeTimeout(result.expiresAt, Date.now())});
  });
  // Only 「绑定 码」 is copied: that message, sent as it is, is what binds. When the browser does not let the page copy,
  // the message is selected instead, for the person to copy.
  const copy = async () => {
    try { await navigator.clipboard.writeText(bindMessage(bind.code)); }
    catch { selectText(message.current); }
  };
  const unbind = () => {
    if (!window.confirm(UNBIND_CONFIRM)) return;
    act(async () => {
      await api('wechat/unbind', {});
      setBind(null);
    });
  };

  return <div className="wv-setting">
    <div className="wv-setting-row">
      <span className="wv-setting-icon" aria-hidden="true"><MessageCircle size={22} strokeWidth={1.7}/></span>
      <div className="wv-setting-text">
        <span className="wv-setting-name">{COPY.wechat}</span>
        {wechat.disconnect ? <Connected>{wechat.badge}</Connected> : wechat.note ? <span className="wv-setting-note">{wechat.note}</span> : null}
      </div>
      {wechat.disconnect ? <button type="button" className="wv-button" onClick={unbind}>{COPY.disconnect}</button>
        : wechat.connect ? !bind && <button type="button" className="wv-button is-primary" onClick={() => newCode(true)}>{COPY.connect}</button>
        : <span className="wv-badge">{wechat.badge}</span>}
    </div>
    {/* The card shows only while the row offers 「连接」 (wechatRow), so a bound account never has a code on screen. */}
    {wechat.card && bind && <div className="wv-bind">
      <div className="wv-bind-row">
        <span ref={message} id={messageId} className="wv-bind-message">{bindMessage(bind.code)}</span>
        <button ref={copyButton} type="button" className="wv-button is-primary" aria-describedby={messageId + ' ' + hintId} onClick={copy}>{COPY_BIND}</button>
      </div>
      <p id={hintId} className="wv-bind-hint">{BIND_HINT}</p>
      <div className="wv-bind-renew">
        <button type="button" className="wv-button" onClick={() => newCode(false)}>{NEW_CODE}</button>
        <span>{NEW_CODE_NOTE}</span>
      </div>
    </div>}
  </div>;
}

// Selects what is written in `element`, so it can be copied by hand.
function selectText(element) {
  if (!element || typeof window.getSelection !== 'function') return;
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function Time({state, api, act, refresh, navigate}) {
  const titleId = useId(), zoneId = useId();
  const saved = state.profile.timezone;
  // A zone picked here shows at once and stays while it is being saved, until the status answer has it too.
  const [picked, setPicked] = useState('');
  useEffect(() => { if (picked && picked === saved) setPicked(''); }, [picked, saved]);
  // The profile as the last status answer has it: the save sends all of it, and runs after the changes before it.
  const profile = useRef(state.profile);
  useEffect(() => { profile.current = state.profile; });
  const current = picked || saved;

  // The zone comes from this choice, never from the browser. A clash with Weave writing at the same moment (409) is
  // tried once more with the profile as it is then.
  const pick = timezone => {
    if (timezone === current) return;
    setPicked(timezone);
    act(async () => {
      let latest = profile.current;
      try {
        await retryOnConflict(() => api('profile', profileForSave(latest, {timezone, now: Date.now()})), async () => { latest = (await refresh({queue: true})).profile; });
      } catch (error) {
        setPicked(shown => (shown === timezone ? '' : shown));
        throw error;
      }
    });
  };

  return <section className="wv-settings" aria-labelledby={titleId}>
    <h2 id={titleId}>{COPY.time}</h2>
    <div className="wv-setting">
      <div className="wv-setting-row is-split">
        <label htmlFor={zoneId} className="wv-setting-label">{COPY.zoneLabel}</label>
        <span className="wv-select">
          <select id={zoneId} value={current} onChange={event => pick(event.target.value)}>
            {zoneOptions(current).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <ChevronDown size={18} strokeWidth={2}/>
        </span>
      </div>
    </div>
    <div className="wv-setting">
      <div className="wv-setting-row is-split">
        <span className="wv-setting-label">{COPY.whenProactive}</span>
        <ViewLink view="agent" navigate={navigate} className="wv-setting-link">{COPY.goAgent}</ViewLink>
      </div>
    </div>
  </section>;
}

function Data({api, act, authKind}) {
  const titleId = useId();
  const remove = () => {
    if (!window.confirm(COPY.deleteConfirm)) return;
    act(async () => {
      await api('account/delete', {confirm: true});
      window.location.href = authKind === 'guest' ? '/api/auth/guest/signout?return_to=%2F' : '/';
      // The page is on its way out. Waiting here keeps `act` from asking for the status of the account that is gone: for
      // a guest that answer is a 401, which would start a new guest session instead of signing out.
      await new Promise(() => {});
    });
  };
  return <section className="wv-settings is-data" aria-labelledby={titleId}>
    <h2 id={titleId}>{COPY.privacy}</h2>
    <p className="wv-settings-text">{COPY.privacyText}<a href="/privacy">{COPY.privacyLink}</a></p>
    <div className="wv-setting-actions">
      <a className="wv-button" href="/api/export" download="weave-export.json">{COPY.export}</a>
      <button type="button" className="wv-button is-danger" onClick={remove}>{COPY.deleteAccount}</button>
    </div>
  </section>;
}

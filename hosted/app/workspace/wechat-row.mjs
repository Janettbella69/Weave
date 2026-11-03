// The WeChat row in settings. It is always there: WeChat is the most important channel, and a row that disappears
// reads as a feature that does not exist. What the row offers depends on the server (settings.wechat in
// GET /api/status: {configured, online, bound}):
//   bound                   connected: 「已连接」 and 「断开」
//   configured, not bound   「连接」 starts the binding, and the card below says what to do next
//   neither                 the bridge is not set up on this server yet: a badge and a sentence, no button

export const WECHAT_TEXT = Object.freeze({
  // The owner approved this wording as written.
  soon: '即将开通',
  soonNote: '开通后，你可以直接在微信里和 Weave 聊天，也能把它拉进群里一起打卡。',
});

// Binding a WeChat account: the person copies one message and sends it, as it is, to Weave's WeChat. These are new
// drafts, not part of the approved pair above (WECHAT_TEXT keeps to exactly those two).
// 草稿文案，待确认。(spec section 3.5 and Appendix A-4)
export const COPY_BIND = '复制绑定消息';
export const BIND_HINT = '把这句原样发给 Weave 的微信，多一个字都不算。';
export const NEW_CODE = '换一个新码';
export const NEW_CODE_NOTE = '换新码后，旧码就不能用了。';
// 草稿文案，待确认。(not in spec Appendix A: asked with window.confirm before 「断开」)
export const UNBIND_CONFIRM = '断开以后，Weave 就不能在微信里找你了；要再用，得重新绑定。确定断开吗？';

// The one message that binds. Only these characters count, so it is all that gets copied.
export const bindMessage = code => '绑定 ' + code;

export function wechatRow(wechat) {
  const bound = !!(wechat && wechat.bound), configured = !!(wechat && wechat.configured);
  if (bound) return {kind: 'connected', connect: false, disconnect: true, badge: '已连接', note: '', card: false};
  // The card tells the person to press 「连接」, so it only shows when that button is there.
  if (configured) return {kind: 'connect', connect: true, disconnect: false, badge: '', note: '', card: true};
  return {kind: 'soon', connect: false, disconnect: false, badge: WECHAT_TEXT.soon, note: WECHAT_TEXT.soonNote, card: false};
}

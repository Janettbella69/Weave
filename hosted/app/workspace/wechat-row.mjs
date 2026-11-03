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

export function wechatRow(wechat) {
  const bound = !!(wechat && wechat.bound), configured = !!(wechat && wechat.configured);
  if (bound) return {kind: 'connected', connect: false, disconnect: true, badge: '已连接', note: '', card: false};
  // The card tells the person to press 「连接」, so it only shows when that button is there.
  if (configured) return {kind: 'connect', connect: true, disconnect: false, badge: '', note: '', card: true};
  return {kind: 'soon', connect: false, disconnect: false, badge: WECHAT_TEXT.soon, note: WECHAT_TEXT.soonNote, card: false};
}

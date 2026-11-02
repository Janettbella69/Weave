// Enter sends, Shift+Enter breaks the line. While an input method (Chinese, Japanese, …) is composing,
// Enter only confirms the candidate and must never send.
//
// Browsers report that in different ways: `isComposing` on the keydown, keyCode 229 for the keydown that
// ends a composition (Safari fires compositionend first, so isComposing is already false there), and
// compositionstart/compositionend events. Accept any of them.
export function isImeComposing(event) {
  const native = event && event.nativeEvent ? event.nativeEvent : event;
  return !!(native && (native.isComposing || native.keyCode === 229 || native.key === 'Process')) || !!(event && (event.isComposing || event.keyCode === 229));
}

// `composing` is the caller's own compositionstart/compositionend flag (optional).
export function shouldSendOnEnter(event, composing = false) {
  if (!event || event.key !== 'Enter' || event.shiftKey) return false;
  return !(composing || isImeComposing(event));
}

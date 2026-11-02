// Parts of the workspace that exist in the code but are not offered to anyone for now.
// Flip a flag to bring the screens back; nothing else needs to change.
export const FEATURES = Object.freeze({
  // Friend invites and agent-to-agent negotiation: postponed by the owner.
  collaboration: false,
  // The background "主动" page: needs the separate background runtime, which is not connected yet.
  proactive: false,
});

// The views that can be opened from the navigation, in order.
export function navViews(features = FEATURES) {
  return [
    ['chat', '聊天'],
    ...(features.collaboration ? [['connections', '协作']] : []),
    ['calendar', '日程'],
    ...(features.proactive ? [['proactive', '主动']] : []),
    ['memory', '记忆'],
  ];
}

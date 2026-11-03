// Weave's avatar: two waves on a soft-blue circle, drawn as on the v3 boards. It is decoration: the link, button or
// heading it sits in carries the name. The boards use 30 (navigation), 32 (phone header), 36 (chat header),
// 56 (first run) and 128 (the assistant's home page, which also has a thin ring).
const MARK = {30: 18, 32: 18, 36: 20, 56: 30, 128: 60};

export default function Avatar({size = 36}) {
  const mark = MARK[size] || Math.round(size * 0.55), large = size >= 100;
  return <span className={'wv-avatar' + (large ? ' is-large' : '')} style={{width: size, height: size}} aria-hidden="true">
    <svg width={mark} height={mark} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={large ? 2 : 2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 9c2.5 0 2.5 3 5 3s2.5-3 5-3 2.5 3 5 3 2-2 3-3"/>
      <path d="M3 15c2.5 0 2.5 3 5 3s2.5-3 5-3 2.5 3 5 3 2-2 3-3"/>
    </svg>
  </span>;
}

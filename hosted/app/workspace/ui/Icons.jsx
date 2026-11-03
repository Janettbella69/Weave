// The icons of the v3 pages, all from lucide-react (they render with aria-hidden unless given a label). Every name here
// was checked against the installed version, lucide-react 1.31.0; a name it does not have fails the build. The boards
// draw the same shapes by hand, with a 1.7 stroke at 22px in the navigation and a 2.2 stroke on the send button, so
// pages pass strokeWidth to match. Weave's own avatar (the two waves) is not from the set: Avatar.jsx draws it.
import {Calendar, MessageCircle, Settings2, SquareCheck, Target} from 'lucide-react';

// The five tabs (NAV_ICONS below). SquareCheck is also the goal category 「其他」.
export {Calendar, MessageCircle, Settings2, SquareCheck, Target};

export {
  ArrowUp,                    // send
  Check,                      // a ticked box
  ChevronDown,                // the zone choice in settings
  ChevronLeft, ChevronRight,
  Clock,                      // 「HH:MM · Weave 主动来问」, and the reminders tab
  NotepadText,                // the memory tab
  Trash2,                     // deleting a reminder
  Zap,                        // 「已连接」
  // the goal categories, in their order: health, relationships, finance, career, interests, productivity
  Heart, Users, JapaneseYen, Briefcase, Palette, Laptop,
} from 'lucide-react';

// The icon of each tab, by view id (NAV in view-route.mjs).
export const NAV_ICONS = Object.freeze({chat: MessageCircle, todo: SquareCheck, goals: Target, records: Calendar, settings: Settings2});

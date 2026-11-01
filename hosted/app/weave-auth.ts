import { cookies } from "next/headers";
import {
  getChatGPTUser,
  type ChatGPTUser,
  chatGPTSignInPath,
  chatGPTSignOutPath,
} from "./chatgpt-auth";

export type WeaveAuthKind = "chatgpt" | "guest";

export type WeaveUser = ChatGPTUser & { authKind: WeaveAuthKind };

export const GUEST_COOKIE_NAME = "weave_guest";
export const GUEST_ID_PATTERN = /^[a-f0-9]{48}$/;
const GUEST_USER_PREFIX = "guest:";

export function guestUserIdFromToken(token: string): string {
  return `${GUEST_USER_PREFIX}${token}`;
}

export function newGuestToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function getGuestUserFromCookie(): Promise<ChatGPTUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(GUEST_COOKIE_NAME)?.value;
  if (!token || !GUEST_ID_PATTERN.test(token)) return null;

  return {
    userId: guestUserIdFromToken(token),
    displayName: "访客",
    email: "",
    fullName: null,
  };
}

export async function getWeaveUser(): Promise<WeaveUser | null> {
  const chatgpt = await getChatGPTUser();
  if (chatgpt) return { ...chatgpt, authKind: "chatgpt" };

  const guest = await getGuestUserFromCookie();
  if (guest) return { ...guest, authKind: "guest" };

  return null;
}

export function guestStartPath(returnTo: string): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `/api/auth/guest/start?return_to=${encodeURIComponent(safeReturnTo)}`;
}

export function guestSignOutPath(returnTo = "/"): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `/api/auth/guest/signout?return_to=${encodeURIComponent(safeReturnTo)}`;
}

export {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  type ChatGPTUser,
} from "./chatgpt-auth";

const GUEST_START_PATH = "/api/auth/guest/start";
const GUEST_SIGNOUT_PATH = "/api/auth/guest/signout";

function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";

  let url: URL;
  try {
    url = new URL(value, "https://app.local");
  } catch {
    return "/";
  }
  if (url.origin !== "https://app.local") return "/";
  if (isReservedAuthPath(url.pathname)) return "/";

  return `${url.pathname}${url.search}${url.hash}`;
}

function isReservedAuthPath(pathname: string): boolean {
  return (
    pathname === "/signin-with-chatgpt" ||
    pathname === "/signout-with-chatgpt" ||
    pathname === "/callback" ||
    pathname === GUEST_START_PATH ||
    pathname === GUEST_SIGNOUT_PATH
  );
}

export function guestSessionCookie(token: string, secure: boolean): string {
  return `${GUEST_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 400}${secure ? "; Secure" : ""}`;
}

export function clearGuestSessionCookie(secure: boolean): string {
  return `${GUEST_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

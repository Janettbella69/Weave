import { env } from "cloudflare:workers";
import {
  clearGuestSessionCookie,
  guestSessionCookie,
  GUEST_COOKIE_NAME,
  GUEST_ID_PATTERN,
  newGuestToken,
} from "../../../../weave-auth";

export const dynamic = "force-dynamic";

function safeReturnTo(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://app.local");
    if (url.origin !== "https://app.local") return "/";
    if (
      url.pathname === "/api/auth/guest/start" ||
      url.pathname === "/api/auth/guest/signout"
    ) {
      return "/";
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function requestIsSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:";
}

function readGuestToken(request: Request): string | null {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${GUEST_COOKIE_NAME}=`)) continue;
    const value = trimmed.slice(GUEST_COOKIE_NAME.length + 1);
    if (GUEST_ID_PATTERN.test(value)) return value;
  }
  return null;
}

async function recordGuestSession(db: D1Database, token: string): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO weave_guest_sessions (id, created_at) VALUES (?, ?)",
    )
    .bind(token, Date.now())
    .run();
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("return_to"));
  const secure = requestIsSecure(request);
  const config = env as unknown as Cloudflare.Env;

  const existing = readGuestToken(request);
  if (existing) {
    if (config.DB) {
      try {
        await recordGuestSession(config.DB, existing);
      } catch {
        /* session row is optional metadata; cookie remains authoritative */
      }
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: returnTo,
        "Cache-Control": "private, no-store",
      },
    });
  }

  const token = newGuestToken();
  if (config.DB) {
    try {
      await recordGuestSession(config.DB, token);
    } catch {
      /* allow guest access even if migration not applied yet */
    }
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: returnTo,
      "Cache-Control": "private, no-store",
      "Set-Cookie": guestSessionCookie(token, secure),
    },
  });
}

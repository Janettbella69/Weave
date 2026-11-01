import { clearGuestSessionCookie } from "../../../../weave-auth";

export const dynamic = "force-dynamic";

function safeReturnTo(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, "https://app.local");
    if (url.origin !== "https://app.local") return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("return_to"));
  const secure = url.protocol === "https:";

  return new Response(null, {
    status: 302,
    headers: {
      Location: returnTo,
      "Cache-Control": "private, no-store",
      "Set-Cookie": clearGuestSessionCookie(secure),
    },
  });
}

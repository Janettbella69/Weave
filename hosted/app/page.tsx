import { getChatGPTUser, chatGPTSignInPath } from "./chatgpt-auth";
import Workspace from "./workspace/Workspace";
import LandingMarketing from "./LandingMarketing";
import { ErrorBoundary } from "../components/ErrorBoundary";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ join?: string }>;
}) {
  const user = await getChatGPTUser();
  if (user) {
    return (
      <ErrorBoundary>
        <Workspace />
      </ErrorBoundary>
    );
  }

  const { join } = await searchParams;
  const returnTo =
    join && /^[a-f0-9]{48}$/.test(join) ? "/?join=" + join : "/";

  return <LandingMarketing signInHref={chatGPTSignInPath(returnTo)} />;
}

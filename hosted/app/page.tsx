import { getWeaveUser } from "./weave-auth";
import LandingMarketing from "./LandingMarketing";
import Workspace from "./workspace/Workspace";
import { ErrorBoundary } from "../components/ErrorBoundary";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ join?: string }>;
}) {
  const user = await getWeaveUser();
  if (user) {
    return (
      <ErrorBoundary>
        <Workspace authKind={user.authKind} />
      </ErrorBoundary>
    );
  }

  const { join } = await searchParams;
  const returnTo =
    join && /^[a-f0-9]{48}$/.test(join) ? "/?join=" + join : "/";

  return <LandingMarketing returnTo={returnTo} />;
}

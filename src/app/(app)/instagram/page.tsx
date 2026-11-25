import { SocialConveyor } from "@/components/socialConveyor";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const sp = await searchParams;
  return <SocialConveyor platform="INSTAGRAM" ok={sp.ok} err={sp.err} />;
}

import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { logoutAction } from "@/app/actions";
import { Nav } from "@/components/nav";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const hb = await db.setting.findUnique({ where: { key: "workerHeartbeat" } });
  const hbAt = hb ? new Date((hb.value as { at: string }).at) : null;
  const workerDown = !hbAt || Date.now() - hbAt.getTime() > 2 * 60_000;
  const openIssues = await db.publicationJob.count({ where: { status: { in: ["ACTION_REQUIRED", "FAILED", "UNKNOWN"] }, OR: [{ errorCode: null }, { errorCode: { not: "MANUAL" } }] } });

  return (
    <div className="md:flex">
      <aside className="border-b md:border-b-0 md:border-r md:min-h-screen md:w-56 shrink-0" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
        <div className="flex items-center justify-between px-4 py-3 md:block">
          <Link href="/" className="font-semibold">SMM Админка</Link>
          <div className="text-xs muted md:mt-1 truncate">{user.email}</div>
        </div>
        <Nav issues={openIssues} />
        <form action={logoutAction} className="px-4 py-3 hidden md:block">
          <button className="text-sm muted hover:underline">Выйти</button>
        </form>
      </aside>
      <main className="flex-1 min-w-0 px-4 py-5 md:px-8 md:py-7 max-w-[1400px]">
        {workerDown && (
          <div className="mb-4 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
            Worker не отвечает{hbAt ? ` с ${hbAt.toLocaleString("ru-RU")}` : ""}. Публикации и синхронизация не выполняются.
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

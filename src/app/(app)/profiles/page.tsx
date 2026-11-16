import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { Empty, Flash, PageHeader, PlatformTag } from "@/components/ui";
import { agentCommandAction, deleteOctoProfileAction, linkAccountProfileAction, saveOctoProfileAction } from "@/app/actions";

const CMD: Record<string, string> = { START_PROFILE: "Открыть", STOP_PROFILE: "Закрыть", LIST_PROFILES: "Загрузить список" };
const CMD_STATUS: Record<string, string> = { PENDING: "ждёт агента", TAKEN: "выполняется", DONE: "готово", FAILED: "ошибка" };

export default async function ProfilesPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const sp = await searchParams;
  const [profiles, accounts, hb, commands] = await Promise.all([
    db.octoProfile.findMany({ orderBy: { title: "asc" }, include: { accounts: true } }),
    db.socialAccount.findMany({ where: { status: { not: "DISABLED" } }, orderBy: [{ platform: "asc" }, { handle: "asc" }] }),
    db.setting.findUnique({ where: { key: "agentHeartbeat" } }),
    db.agentCommand.findMany({ orderBy: { createdAt: "desc" }, take: 10, include: { profile: true } }),
  ]);
  const agent = hb?.value as { at: string; hostname: string; octo?: { reachable?: boolean; apiAvailable?: boolean; username?: string } } | undefined;
  const agentOnline = agent && Date.now() - new Date(agent.at).getTime() < 60_000;
  const apiOk = Boolean(agentOnline && agent?.octo?.apiAvailable);
  const tz = env().BASE_TIMEZONE;

  return (
    <div className="max-w-5xl">
      <PageHeader title="Профили Octo Browser" />
      <Flash msg={sp.ok} />
      <Flash msg={sp.err} kind="err" />

      <div className="card mb-5 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`h-2.5 w-2.5 rounded-full ${agentOnline ? "bg-green-500" : "bg-gray-400"}`} />
          <span className="font-medium">Агент на компьютере: {agentOnline ? `в сети (${agent!.hostname})` : agent ? `не в сети с ${new Date(agent.at).toLocaleString("ru-RU", { timeZone: tz })}` : "ещё не подключался"}</span>
          {agentOnline && (
            <span className="muted">
              Octo: {agent!.octo?.reachable ? "запущен" : "не запущен"}
              {agent!.octo?.reachable && (apiOk ? " · API доступен" : " · API недоступен (тариф Starter)")}
            </span>
          )}
          {apiOk && (
            <form action={agentCommandAction} className="ml-auto">
              <input type="hidden" name="type" value="LIST_PROFILES" />
              <button className="btn btn-sm">Загрузить профили из Octo</button>
            </form>
          )}
        </div>
        {!apiOk && (
          <p className="mt-2 text-xs muted">
            Без API профили открываются вручную в Octo по названию. Кнопки «Открыть/Закрыть» заработают после перехода на тариф Base и запуска агента (инструкция: agent/README.md в репозитории).
          </p>
        )}
      </div>

      {profiles.length === 0 ? (
        <Empty>Добавьте свои профили Octo (названия как в Octo) и привяжите к ним аккаунты соцсетей.</Empty>
      ) : (
        <div className="mb-6 grid gap-3 md:grid-cols-2">
          {profiles.map((p) => (
            <div key={p.id} className="card p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${p.running ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`} title={p.running ? "запущен" : "остановлен"} />
                <span className="flex-1 font-medium">{p.title}</span>
                {apiOk && p.octoUuid && (
                  <form action={agentCommandAction}>
                    <input type="hidden" name="type" value={p.running ? "STOP_PROFILE" : "START_PROFILE"} />
                    <input type="hidden" name="profileId" value={p.id} />
                    <button className="btn btn-sm">{p.running ? "Закрыть" : "Открыть"}</button>
                  </form>
                )}
              </div>
              <ul className="mb-3 space-y-1 text-sm">
                {p.accounts.length === 0 && <li className="muted">нет привязанных аккаунтов</li>}
                {p.accounts.map((a) => (
                  <li key={a.id} className="flex items-center gap-2">
                    <PlatformTag platform={a.platform} /> <span>@{a.handle}</span>
                    {a.language && <span className="text-xs muted">{a.language}</span>}
                  </li>
                ))}
              </ul>
              <details>
                <summary className="cursor-pointer text-xs muted">Изменить</summary>
                <form action={saveOctoProfileAction} className="mt-2 grid gap-2">
                  <input type="hidden" name="id" value={p.id} />
                  <div><label className="label">Название (как в Octo)</label><input name="title" defaultValue={p.title} className="input" /></div>
                  <div><label className="label">UUID в Octo (для API)</label><input name="octoUuid" defaultValue={p.octoUuid ?? ""} className="input font-mono text-xs" /></div>
                  <div><label className="label">Прокси / гео</label><input name="proxyNote" defaultValue={p.proxyNote ?? ""} className="input" /></div>
                  <div><label className="label">Заметки</label><textarea name="notes" defaultValue={p.notes ?? ""} rows={2} className="input" /></div>
                  <button className="btn btn-sm">Сохранить</button>
                </form>
                <form action={deleteOctoProfileAction} className="mt-2">
                  <input type="hidden" name="id" value={p.id} />
                  <button className="btn btn-sm btn-danger">Удалить из админки</button>
                </form>
              </details>
              {p.proxyNote && <div className="mt-2 text-xs muted">Прокси: {p.proxyNote}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <form action={saveOctoProfileAction} className="card grid gap-2 p-4">
          <h2 className="font-medium">Добавить профиль</h2>
          <div><label className="label">Название (как в Octo)</label><input name="title" required className="input" placeholder="EN-1" /></div>
          <div><label className="label">Прокси / гео</label><input name="proxyNote" className="input" placeholder="US, residential" /></div>
          <button className="btn btn-primary">Добавить</button>
        </form>

        <div className="card p-4">
          <h2 className="mb-2 font-medium">Аккаунт → профиль</h2>
          {accounts.length === 0 ? <p className="text-sm muted">Сначала добавьте аккаунты.</p> : (
            <div className="space-y-2">
              {accounts.map((a) => (
                <form key={a.id} action={linkAccountProfileAction} className="flex items-center gap-2 text-sm">
                  <input type="hidden" name="accountId" value={a.id} />
                  <span className="w-44 truncate"><PlatformTag platform={a.platform} /> @{a.handle}</span>
                  <select name="profileId" defaultValue={a.octoProfileId ?? ""} className="input flex-1">
                    <option value="">— без профиля —</option>
                    {profiles.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                  </select>
                  <button className="btn btn-sm">OK</button>
                </form>
              ))}
            </div>
          )}
        </div>
      </div>

      {commands.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 font-medium">Последние команды агенту</h2>
          <ul className="space-y-1 text-xs muted">
            {commands.map((c) => (
              <li key={c.id}>
                {c.createdAt.toLocaleString("ru-RU", { timeZone: tz })} · {CMD[c.type]} {c.profile?.title ?? ""} · {CMD_STATUS[c.status]}
                {c.error && <span className="text-red-600"> · {c.error}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

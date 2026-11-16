import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { Empty, Flash, PageHeader, PlatformTag } from "@/components/ui";
import { addTikTokAccountAction, checkAccountAction, deleteAccountAction, updateAccountAction } from "@/app/actions";

const STATUS: Record<string, string> = { ACTIVE: "Активен", NEEDS_RECONNECT: "Нужно переподключить", DISABLED: "Отключён" };

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const sp = await searchParams;
  const accounts = await db.socialAccount.findMany({ orderBy: [{ platform: "asc" }, { handle: "asc" }], include: { _count: { select: { jobs: true } } } });
  const e = env();
  const ytReady = Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
  const igReady = Boolean(e.INSTAGRAM_APP_ID && e.INSTAGRAM_APP_SECRET);

  return (
    <div>
      <PageHeader title="Аккаунты">
        {ytReady ? <a href="/api/oauth/youtube/start" className="btn">+ YouTube канал</a> : <span className="btn opacity-50" title="Заполните GOOGLE_CLIENT_ID / SECRET">+ YouTube (не настроено)</span>}
        {igReady ? <a href="/api/oauth/instagram/start" className="btn">+ Instagram</a> : <span className="btn opacity-50" title="Заполните INSTAGRAM_APP_ID / SECRET">+ Instagram (не настроено)</span>}
      </PageHeader>
      <Flash msg={sp.ok} />
      <Flash msg={sp.err} kind="err" />

      {accounts.length === 0 ? (
        <Empty>Аккаунтов пока нет. Подключите YouTube или Instagram через кнопки выше, TikTok добавляется формой ниже.</Empty>
      ) : (
        <div className="card scroll-x mb-6">
          <table className="tbl">
            <thead><tr><th>Площадка</th><th>Аккаунт</th><th>Язык</th><th>Режим</th><th>Статус</th><th>Проверен</th><th></th></tr></thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td><PlatformTag platform={a.platform} /></td>
                  <td>
                    <div className="font-medium">@{a.handle}</div>
                    <div className="text-xs muted">{a.displayName ?? a.externalId}</div>
                  </td>
                  <td colSpan={2}>
                    <form action={updateAccountAction} className="flex gap-1">
                      <input type="hidden" name="id" value={a.id} />
                      <input name="language" defaultValue={a.language ?? ""} placeholder="en" className="input w-16" />
                      {a.platform === "TIKTOK" && (
                        <select name="mode" defaultValue={a.tiktokMode ?? "MANUAL"} className="input w-36">
                          <option value="MANUAL">Вручную (пакет)</option>
                          <option value="PARTNER">Upload-Post</option>
                        </select>
                      )}
                      <button className="btn btn-sm">OK</button>
                    </form>
                  </td>
                  <td>
                    <span className={a.status === "ACTIVE" ? "text-green-600" : a.status === "NEEDS_RECONNECT" ? "text-red-600" : "muted"}>{STATUS[a.status]}</span>
                    {a.lastError && <div className="max-w-xs truncate text-xs text-red-600" title={a.lastError}>{a.lastError}</div>}
                  </td>
                  <td className="text-xs muted whitespace-nowrap">{a.lastCheckedAt?.toLocaleString("ru-RU", { timeZone: e.BASE_TIMEZONE }) ?? "—"}</td>
                  <td className="whitespace-nowrap">
                    <div className="flex gap-1">
                      <form action={checkAccountAction}><input type="hidden" name="id" value={a.id} /><button className="btn btn-sm">Проверить</button></form>
                      {a.status === "NEEDS_RECONNECT" && a.platform !== "TIKTOK" && (
                        <a className="btn btn-sm btn-primary" href={`/api/oauth/${a.platform.toLowerCase()}/start`}>Переподключить</a>
                      )}
                      {a.status !== "DISABLED" ? (
                        <form action={deleteAccountAction}><input type="hidden" name="id" value={a.id} /><button className="btn btn-sm btn-danger">Отключить</button></form>
                      ) : (
                        <form action={updateAccountAction}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="language" value={a.language ?? ""} /><input type="hidden" name="status" value="ACTIVE" /><button className="btn btn-sm">Включить</button></form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mb-2 font-medium">Добавить TikTok</h2>
      <form action={addTikTokAccountAction} className="card grid gap-3 p-4 md:grid-cols-5 md:items-end">
        <div><label className="label">@аккаунт</label><input name="handle" required className="input" placeholder="@channel_en" /></div>
        <div><label className="label">Язык</label><input name="language" className="input" placeholder="en" /></div>
        <div>
          <label className="label">Режим</label>
          <select name="mode" className="input">
            <option value="MANUAL">Вручную: пакет для TikTok Studio</option>
            <option value="PARTNER">Upload-Post (платно)</option>
          </select>
        </div>
        <div><label className="label">Профиль Upload-Post</label><input name="uploadPostProfile" className="input" placeholder="только для Upload-Post" /></div>
        <button className="btn btn-primary">Добавить</button>
      </form>
      <p className="mt-2 text-xs muted">
        Аккаунты YouTube и Instagram подключаются через OAuth владельцем аккаунта: пароли не нужны. Пока приложения Google и Meta не прошли проверку, подключать можно только аккаунты, добавленные в тестировщики.
      </p>
    </div>
  );
}

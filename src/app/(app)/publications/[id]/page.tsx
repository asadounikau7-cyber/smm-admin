import Link from "next/link";
import { notFound } from "next/navigation";
import { DateTime } from "luxon";
import { db } from "@/lib/db";
import { Flash, PageHeader, PlatformTag, StatusBadge, fmtDur, fmtSize } from "@/components/ui";
import { CopyButton } from "@/components/copy";
import { FORMAT_LABEL } from "@/lib/validators";
import { adapterFor, isManual } from "@/lib/adapters";
import { agentCommandAction, cancelJobAction, generateCoverAction, manualStatusAction, rescheduleJobAction, retryJobAction, setYtPrivacyAction } from "@/app/actions";
import { studioEditUrl } from "@/lib/adapters/youtube";

export default async function JobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const j = await db.publicationJob.findUnique({
    where: { id },
    include: {
      account: { include: { octoProfile: true } },
      rule: true,
      plan: true,
      attempts: { orderBy: { startedAt: "desc" }, take: 30 },
      assetVersion: { include: { asset: { include: { series: true, episode: true } } } },
    },
  });
  if (!j) notFound();
  const audit = await db.auditEvent.findMany({ where: { entity: "PublicationJob", entityId: id }, include: { user: true }, orderBy: { createdAt: "desc" }, take: 20 });
  const meta = (j.meta ?? {}) as Record<string, any>;
  const a = j.assetVersion?.asset;
  const manualTikTok = isManual(j.account);
  const ig = j.platform === "INSTAGRAM";
  const caps = adapterFor(j.account)?.capabilities;
  const active = !["CANCELLED", "PUBLISHED", "CANCEL_PENDING"].includes(j.status);
  const flags = [meta.aiDisclosure && "AI-контент", meta.paidPromotion && "Платное продвижение / реклама", meta.madeForKids && "Для детей"].filter(Boolean) as string[];
  const hb = (await db.setting.findUnique({ where: { key: "agentHeartbeat" } }))?.value as { at: string; octo?: { apiAvailable?: boolean } } | undefined;
  const agentApi = Boolean(hb && Date.now() - new Date(hb.at).getTime() < 60_000 && hb.octo?.apiAvailable);
  const ytVideo = j.platform === "YOUTUBE" && j.externalId ? j.externalId : null;
  const studioUrl = j.platform === "TIKTOK" ? "https://www.tiktok.com/tiktokstudio/upload" : j.platform === "INSTAGRAM" ? "https://www.instagram.com/" : ytVideo ? studioEditUrl(ytVideo) : "https://studio.youtube.com/";
  const tzLocal = DateTime.fromJSDate(j.scheduledAt, { zone: j.timezone }).toFormat("yyyy-LL-dd'T'HH:mm");

  return (
    <div className="max-w-4xl">
      <PageHeader title={`${a?.series?.title ?? "Публикация"}${a?.episode ? ` · S${a.episode.season}E${a.episode.number}` : ""}`}>
        <Link href="/publications" className="btn">← Все публикации</Link>
      </PageHeader>
      <Flash msg={sp.ok} />
      <Flash msg={sp.err} kind="err" />

      <div className="card mb-4 grid gap-3 p-4 text-sm md:grid-cols-3">
        <div><div className="label">Статус</div><StatusBadge status={j.status} /></div>
        <div><div className="label">Куда</div><PlatformTag platform={j.platform} /> @{j.account.handle} · {FORMAT_LABEL[j.format]}</div>
        <div><div className="label">Когда</div>{j.localTime} <span className="muted">{j.timezone}</span></div>
        <div><div className="label">Файл</div>{a ? <a target="_blank" className="underline" href={`/api/media/${j.assetVersionId}`}>{a.objectKey.split("/").pop()}</a> : "—"} <span className="muted">{fmtDur(j.assetVersion?.durationSec)} · {fmtSize(j.assetVersion?.size)}</span></div>
        <div><div className="label">Версия файла</div><span className="font-mono text-xs">{j.assetVersion?.versionKey.slice(0, 24)}</span>{j.assetVersion && !j.assetVersion.isCurrent && <span className="ml-1 text-amber-600">в B2 есть новая</span>}</div>
        <div><div className="label">Ссылка</div>{j.externalUrl ? <a href={j.externalUrl} target="_blank" className="underline break-all">{j.externalUrl}</a> : "—"}</div>
        {j.errorMessage && <div className="md:col-span-3 text-amber-700 dark:text-amber-400">{j.errorMessage}</div>}
        {meta.operatorConfirmed && <div className="md:col-span-3 text-xs muted">Подтверждено оператором: {meta.operatorConfirmed.by}, {new Date(meta.operatorConfirmed.at).toLocaleString("ru-RU")}</div>}
      </div>

      {ytVideo && (
        <section className="card mb-4 flex flex-wrap items-center gap-3 p-4 text-sm">
          <a href={studioEditUrl(ytVideo)} target="_blank" className="btn">Открыть в Studio</a>
          <form action={setYtPrivacyAction} className="flex items-center gap-2">
            <input type="hidden" name="id" value={j.id} />
            <select name="privacy" defaultValue={j.visibility === "PRIVATE" ? "unlisted" : j.visibility.toLowerCase()} className="input">
              <option value="public">Открытый</option>
              <option value="unlisted">По ссылке</option>
              <option value="private">Закрытый</option>
            </select>
            <button className="btn">Сменить доступ через API</button>
          </form>
          {meta.adapter?.manualOpen && <span className="text-xs text-amber-700 dark:text-amber-400">API не открыл ролик: откройте его в Studio, админка сама увидит и отметит «Опубликовано».</span>}
        </section>
      )}

      {j.account.octoProfile && (
        <section className="card mb-4 flex flex-wrap items-center gap-3 p-4 text-sm">
          <span className={`h-2 w-2 rounded-full ${j.account.octoProfile.running ? "bg-green-500" : "bg-gray-400"}`} />
          <span>Профиль Octo: <b>{j.account.octoProfile.title}</b>{j.account.octoProfile.proxyNote ? <span className="muted"> · {j.account.octoProfile.proxyNote}</span> : null}</span>
          {agentApi && j.account.octoProfile.octoUuid ? (
            <form action={agentCommandAction} className="ml-auto">
              <input type="hidden" name="type" value="START_PROFILE" />
              <input type="hidden" name="profileId" value={j.account.octoProfile.id} />
              <input type="hidden" name="url" value={studioUrl} />
              <input type="hidden" name="back" value={`/publications/${j.id}`} />
              <button className="btn btn-sm btn-primary">Открыть профиль</button>
            </form>
          ) : (
            <span className="ml-auto text-xs muted">Откройте этот профиль в Octo вручную</span>
          )}
        </section>
      )}

      {manualTikTok && (
        <section className="card mb-4 space-y-3 p-4">
          <h2 className="font-medium">{ig ? "Пакет для Instagram Reels" : "Пакет для TikTok Studio"}</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>Скачайте видео{j.coverKey ? " и обложку" : ""}.</li>
            {j.account.octoProfile && <li>Откройте профиль Octo <b>{j.account.octoProfile.title}</b>.</li>}
            {ig ? (
              <li>В Instagram (Meta Business Suite или приложение) создайте Reels в аккаунте <b>@{j.account.handle}</b>, вставьте подпись и запланируйте на <b>{j.localTime}</b> ({j.timezone}) или опубликуйте в это время.</li>
            ) : (
              <li>В TikTok Studio (веб) загрузите видео в аккаунт <b>@{j.account.handle}</b>, вставьте подпись, включите расписание и поставьте время <b>{j.localTime}</b> ({j.timezone}).</li>
            )}
            {flags.length > 0 && <li>Включите маркировку: <b>{flags.join(", ")}</b>.</li>}
            <li>Нажмите «Запланировано вручную» ниже. После выхода поста вставьте ссылку и отметьте «Опубликовано».</li>
          </ol>
          <div className="flex flex-wrap gap-2">
            {j.assetVersionId && <a className="btn" href={`/api/media/${j.assetVersionId}`} target="_blank">Скачать видео</a>}
            {j.coverKey && <a className="btn" href={`/api/cover?k=${encodeURIComponent(j.coverKey)}`} target="_blank">Обложка</a>}
            <CopyButton text={j.caption} label="Копировать подпись" />
          </div>
          <pre className="whitespace-pre-wrap rounded-md p-3 text-sm" style={{ background: "var(--bg)" }}>{j.caption}</pre>
          {active && (
            <div className="flex flex-wrap gap-2">
              <form action={manualStatusAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="id" value={j.id} /><input type="hidden" name="rowVersion" value={j.rowVersion} />
                <input type="hidden" name="target" value="MANUALLY_SCHEDULED" />
                <input name="url" placeholder="ссылка (необязательно)" className="input w-64" />
                <button className="btn">Запланировано вручную</button>
              </form>
              <form action={manualStatusAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="id" value={j.id} /><input type="hidden" name="rowVersion" value={j.rowVersion} />
                <input type="hidden" name="target" value="PUBLISHED" />
                <input name="url" required placeholder={ig ? "https://www.instagram.com/reel/…" : "https://www.tiktok.com/@…/video/…"} className="input w-64" />
                <button className="btn btn-primary">Опубликовано</button>
              </form>
            </div>
          )}
        </section>
      )}

      {!manualTikTok && (
        <section className="card mb-4 p-4">
          <h2 className="mb-2 font-medium">Подпись</h2>
          {j.title && <div className="mb-1 font-medium">{j.title}</div>}
          <pre className="whitespace-pre-wrap text-sm">{j.caption}</pre>
        </section>
      )}

      <section className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        {active && (
          <form action={rescheduleJobAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="id" value={j.id} /><input type="hidden" name="rowVersion" value={j.rowVersion} />
            <div><label className="label">Перенести на ({j.timezone})</label><input type="datetime-local" name="localTime" defaultValue={tzLocal} className="input" /></div>
            <button className="btn" disabled={Boolean(j.externalId) && !caps?.reschedule}>Перенести</button>
          </form>
        )}
        {["FAILED", "UNKNOWN", "ACTION_REQUIRED"].includes(j.status) && !manualTikTok && (
          <form action={retryJobAction} className="flex items-center gap-2">
            <input type="hidden" name="id" value={j.id} /><input type="hidden" name="rowVersion" value={j.rowVersion} />
            {j.status === "UNKNOWN" && <label className="flex items-center gap-1 text-xs text-amber-700"><input type="checkbox" name="confirmRepost" /> Проверил: поста нет, публиковать заново</label>}
            <button className="btn">Повторить</button>
          </form>
        )}
        {j.assetVersionId && active && !j.externalId && (
          <form action={generateCoverAction} className="flex items-center gap-1">
            <input type="hidden" name="id" value={j.id} />
            <input name="coverTitle" placeholder="текст на обложке" className="input w-40" />
            <button className="btn">Обложка</button>
          </form>
        )}
        {active && (
          <form action={cancelJobAction}>
            <input type="hidden" name="id" value={j.id} /><input type="hidden" name="rowVersion" value={j.rowVersion} />
            <button className="btn btn-danger">{j.externalId ? "Отменить на площадке" : "Отменить"}</button>
          </form>
        )}
        {manualTikTok && j.status === "MANUALLY_SCHEDULED" && <p className="text-xs muted">Отмена здесь не удалит пост из {ig ? "Instagram" : "TikTok Studio"}: удалите его там вручную.</p>}
      </section>

      <section className="mb-4">
        <h2 className="mb-2 font-medium">Попытки</h2>
        {j.attempts.length === 0 ? <p className="text-sm muted">Ещё не было.</p> : (
          <div className="card scroll-x">
            <table className="tbl">
              <thead><tr><th>Время</th><th>Шаг</th><th>Итог</th><th>Код</th><th>Сообщение</th></tr></thead>
              <tbody>
                {j.attempts.map((t) => (
                  <tr key={t.id}>
                    <td className="whitespace-nowrap text-xs">{t.startedAt.toLocaleString("ru-RU", { timeZone: j.timezone })}</td>
                    <td>{t.step}</td>
                    <td>{t.ok == null ? "…" : t.ok ? "OK" : "ошибка"}</td>
                    <td className="text-xs">{t.errorCode ?? ""}{t.httpStatus ? ` ${t.httpStatus}` : ""}</td>
                    <td className="max-w-md break-words text-xs">{t.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-medium">Журнал действий</h2>
        <ul className="space-y-1 text-xs muted">
          {audit.map((e) => <li key={e.id}>{e.createdAt.toLocaleString("ru-RU", { timeZone: j.timezone })} · {e.action} · {e.user?.email ?? "система"}</li>)}
        </ul>
      </section>
    </div>
  );
}

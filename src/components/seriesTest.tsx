import Link from "next/link";
import type { Episode, PublicationJob, Series, SeriesStage, SocialAccount } from "@prisma/client";
import { StatusBadge } from "./ui";
import { AutoRefresh } from "./autoRefresh";
import { decideSeriesTestAction, launchSeriesAction, resetSeriesTestAction, resumeSeriesTestAction, startSeriesTestAction } from "@/app/testActions";
import type { YtTestSettings } from "@/lib/seriesTest";

const STAGE: Record<SeriesStage, { label: string; cls: string }> = {
  NEW: { label: "Не тестировался", cls: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" },
  TESTING: { label: "Идёт тест", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  IN_WORK: { label: "Прошёл · в работе", cls: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300" },
  TEST_FAILED: { label: "Не прошёл", cls: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" },
};

type Job = PublicationJob & { account: SocialAccount };

function JobLine({ label, job }: { label: string; job: Job | null }) {
  if (!job) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="muted">{label}:</span>
      <span>@{job.account.handle}</span>
      <StatusBadge status={job.status} />
      {job.externalUrl && <a href={job.externalUrl} target="_blank" className="text-xs underline">открыть на YouTube</a>}
      <Link href={`/publications?job=${job.id}`} className="text-xs underline">публикация</Link>
    </div>
  );
}

export function SeriesTestCard(props: {
  series: Series & { episodes: Episode[] };
  accounts: { id: string; label: string }[];
  defaults: YtTestSettings;
  testJob: Job | null;
  launchJob: Job | null;
}) {
  const { series, accounts, defaults, testJob, launchJob } = props;
  const st = STAGE[series.stage];
  const testMeta = (testJob?.meta ?? {}) as { launchAccountId?: string | null };
  const launchDefault = testMeta.launchAccountId ?? defaults.launchAccountId ?? "";
  const busy = series.stage === "TESTING" || (launchJob && ["QUEUED", "SENT", "PROCESSING"].includes(launchJob.status));

  return (
    <div className="card space-y-3 p-4">
      {busy && <AutoRefresh seconds={20} />}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">Тест на YouTube</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${st.cls}`}>{st.label}</span>
      </div>
      {series.testNote && <div className={`text-sm ${series.stage === "TEST_FAILED" ? "text-red-600" : ""}`}>{series.testNote}</div>}
      <JobLine label="Тестовый ролик" job={testJob} />
      <JobLine label="Серия 1 на основном (авто)" job={launchJob} />

      {accounts.length === 0 ? (
        <div className="text-sm muted">Нет подключённых YouTube-каналов. Подключите их на странице «Аккаунты».</div>
      ) : series.stage !== "TESTING" ? (
        <form action={startSeriesTestAction} className="grid gap-2 md:grid-cols-[1fr_90px_auto] md:items-end">
          <input type="hidden" name="id" value={series.id} />
          <div>
            <label className="label">Тестовый канал</label>
            <select name="testAccountId" defaultValue={defaults.testAccountId ?? ""} className="input" required>
              <option value="">—</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Серия</label>
            <input name="episode" type="number" min={1} defaultValue={series.episodes[0]?.number ?? 1} className="input" />
          </div>
          <button className="btn btn-primary">{series.stage === "NEW" ? "Отправить на тест" : "Тестировать заново"}</button>
        </form>
      ) : (
        <div className="text-xs muted">
          Админка сама следит за роликом: ждёт обработки YouTube и {defaults.waitMin} мин без блокировок. Страница обновляется сама.
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {(series.stage === "TESTING" || series.stage === "TEST_FAILED") && (
          <>
            <form action={decideSeriesTestAction}>
              <input type="hidden" name="id" value={series.id} />
              <input type="hidden" name="verdict" value="pass" />
              <button className="btn btn-sm">Прошёл (вручную)</button>
            </form>
            <form action={decideSeriesTestAction} className="flex gap-1">
              <input type="hidden" name="id" value={series.id} />
              <input type="hidden" name="verdict" value="fail" />
              <input name="note" placeholder="причина, напр. claim в Studio" className="input w-56" />
              <button className="btn btn-sm btn-danger">Не прошёл</button>
            </form>
            {series.stage === "TEST_FAILED" && testJob?.externalId && (
              <form action={resumeSeriesTestAction}>
                <input type="hidden" name="id" value={series.id} />
                <button className="btn btn-sm">Продолжить наблюдение</button>
              </form>
            )}
            <form action={resetSeriesTestAction}>
              <input type="hidden" name="id" value={series.id} />
              <button className="btn btn-sm">Сбросить</button>
            </form>
          </>
        )}
        {series.stage === "IN_WORK" && defaults.launchAccountId && (!launchJob || ["CANCELLED", "FAILED"].includes(launchJob.status)) && accounts.length > 0 && (
          <form action={launchSeriesAction} className="flex gap-1">
            <input type="hidden" name="id" value={series.id} />
            <select name="launchAccountId" defaultValue={launchDefault} className="input">
              <option value="">— основной канал —</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
            <button className="btn btn-sm btn-primary">Опубликовать серию 1</button>
          </form>
        )}
      </div>
    </div>
  );
}

import type { Asset, AssetVersion, Episode, Series } from "@prisma/client";
import { CopyButton } from "./copy";
import { renderCaption } from "@/lib/caption";
import { markEpisodePostedAction } from "@/app/testActions";

type Ep = Episode & { assets: (Asset & { versions: AssetVersion[] })[] };

const pad = (n: number) => String(n).padStart(2, "0");

/** File to upload by hand: a vertical cut when there is one, else the full episode. */
function fileOf(ep: Ep) {
  const ok = ep.assets.filter((a) => !a.deletedAt && a.versions[0] && (a.kind === "VERTICAL" || a.kind === "FULL_EPISODE"));
  return (ok.find((a) => a.kind === "VERTICAL") ?? ok[0])?.versions[0] ?? null;
}

/** Series that passed the test: everything the operator needs to upload each episode to the main channel by hand. */
export function ManualUploads({ series }: { series: Series & { episodes: Ep[] } }) {
  const done = series.episodes.filter((e) => e.mainUrl).length;
  const next = series.episodes.find((e) => !e.mainUrl);
  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">Основной канал: загрузка вручную</h3>
        <span className="text-xs muted">загружено {done} из {series.episodes.length}</span>
      </div>
      <p className="text-xs muted">
        Профиль Octo «Боевой» → YouTube Studio → «Создать» → «Загрузить видео». Скачайте файл, вставьте название и описание, опубликуйте. Затем вставьте сюда ссылку на ролик и нажмите «Загружено». Серии идут по порядку.
      </p>
      <div className="divide-y" style={{ borderColor: "var(--border)" }}>
        {series.episodes.map((e) => {
          const v = fileOf(e);
          const title = `${series.title} — S${pad(e.season)}E${pad(e.number)}${e.title ? ` · ${e.title}` : ""}`.slice(0, 100);
          const description = renderCaption("{title} — S{season}E{episode}\n{hashtags}", { title: series.title, series: series.title, season: e.season, episode: e.number, hashtags: series.hashtags });
          return (
            <div key={e.id} className={`flex flex-wrap items-center gap-2 py-2 text-sm ${next?.id === e.id ? "font-medium" : ""}`}>
              <span className="w-16">S{pad(e.season)}E{pad(e.number)}</span>
              {e.mainUrl ? (
                <>
                  <a href={e.mainUrl} target="_blank" className="text-green-600 underline">✓ на канале</a>
                  <span className="text-xs muted">{e.mainPostedAt?.toLocaleDateString("ru-RU")}</span>
                  <form action={markEpisodePostedAction} className="ml-auto">
                    <input type="hidden" name="episodeId" value={e.id} />
                    <button className="btn btn-sm">Снять отметку</button>
                  </form>
                </>
              ) : (
                <>
                  {v ? <a className="btn btn-sm" href={`/api/media/${v.id}`} target="_blank" download>Скачать</a> : <span className="text-red-600 text-xs">нет файла</span>}
                  <CopyButton text={title} label="Название" />
                  <CopyButton text={description} label="Описание" />
                  <form action={markEpisodePostedAction} className="ml-auto flex gap-1">
                    <input type="hidden" name="episodeId" value={e.id} />
                    <input name="url" required placeholder="https://youtube.com/shorts/…" className="input w-56" />
                    <button className="btn btn-sm btn-primary">Загружено</button>
                  </form>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

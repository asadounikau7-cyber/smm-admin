"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  PRESETS,
  cssFilter,
  normalizeRecipe,
  outputDuration,
  sampleRecipe,
  type Preset,
  type Range,
  type Recipe,
  type TextOverlay,
  type Variation,
} from "@/lib/recipe";

export type EditorSource = { versionId: string; label: string; durationSec: number | null };

type Props = {
  mode: "template" | "variant";
  sources: EditorSource[];
  initialSource?: string;
  initialRecipe: Recipe;
  initialVariation?: Variation;
  action: (f: FormData) => void | Promise<void>;
  hidden: Record<string, string>;
  name?: string;
  notes?: string;
  submitLabel: string;
};

const W = 270; // preview width; 1080 → 270 is ×0.25
const K = W / 1080;

function fmt(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function Slider(p: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <label className="block">
      <span className="label">
        <span className="flex justify-between">
          <span>{p.label}</span>
          <span>
            {p.value}
            {p.suffix ?? ""}
          </span>
        </span>
      </span>
      <input type="range" className="w-full" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
    </label>
  );
}

function Num(p: { label: string; value: number | null; onChange: (v: number | null) => void; step?: number; placeholder?: string }) {
  return (
    <label className="block">
      <span className="label">{p.label}</span>
      <input
        className="input"
        type="number"
        step={p.step ?? 0.1}
        value={p.value ?? ""}
        placeholder={p.placeholder}
        onChange={(e) => p.onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
    </label>
  );
}

function RangeRow(p: { label: string; value?: Range; step?: number; onChange: (v?: Range) => void; hint?: string }) {
  const on = Boolean(p.value);
  return (
    <div className="grid grid-cols-[auto_1fr_1fr] items-center gap-2 text-sm">
      <label className="flex items-center gap-2 whitespace-nowrap">
        <input type="checkbox" checked={on} onChange={(e) => p.onChange(e.target.checked ? [0, 0] : undefined)} />
        <span className="w-28">{p.label}</span>
      </label>
      <input className="input" type="number" step={p.step ?? 0.01} disabled={!on} value={p.value?.[0] ?? ""} onChange={(e) => p.onChange([Number(e.target.value), p.value?.[1] ?? 0])} title="от" />
      <input className="input" type="number" step={p.step ?? 0.01} disabled={!on} value={p.value?.[1] ?? ""} onChange={(e) => p.onChange([p.value?.[0] ?? 0, Number(e.target.value)])} title="до" />
    </div>
  );
}

export function Editor(props: Props) {
  const [recipe, setRecipe] = useState<Recipe>(normalizeRecipe(props.initialRecipe));
  const [variation, setVariation] = useState<Variation>(props.initialVariation ?? {});
  const [sample, setSample] = useState<Recipe | null>(null);
  const [srcId, setSrcId] = useState(props.initialSource ?? props.sources[0]?.versionId ?? "");
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);
  const [frameBusy, setFrameBusy] = useState(false);
  const [frameErr, setFrameErr] = useState<string | null>(null);
  const [name, setName] = useState(props.name ?? "");
  const [notes, setNotes] = useState(props.notes ?? "");
  const video = useRef<HTMLVideoElement>(null);

  const src = props.sources.find((s) => s.versionId === srcId) ?? props.sources[0];
  const shown = sample ?? recipe;
  const srcDur = src?.durationSec ?? video.current?.duration ?? null;
  const end = shown.trimEnd ?? srcDur ?? 0;
  const outT = Math.max(0, (cur - shown.trimStart) / shown.speed + (shown.hook ? shown.hook.length / shown.speed : 0));
  const outDur = srcDur ? outputDuration(shown, srcDur) : null;

  const set = <K extends keyof Recipe>(k: K, v: Recipe[K]) => {
    setSample(null);
    setRecipe((r) => ({ ...r, [k]: v }));
  };
  const setText = (i: number, patch: Partial<TextOverlay>) => set("texts", recipe.texts.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  // Keep playback inside the trimmed segment, at the version's speed.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.playbackRate = shown.speed;
    v.volume = Math.min(1, shown.volume);
  }, [shown.speed, shown.volume]);

  const onTime = () => {
    const v = video.current;
    if (!v) return;
    const stopAt = shown.maxDuration ? Math.min(end || v.duration, shown.trimStart + shown.maxDuration * shown.speed) : end || v.duration;
    if (v.currentTime < shown.trimStart - 0.3 || (stopAt && v.currentTime >= stopAt)) v.currentTime = shown.trimStart;
    setCur(v.currentTime);
  };

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    setFrame(null);
    if (v.paused) {
      if (v.currentTime < shown.trimStart) v.currentTime = shown.trimStart;
      v.play();
    } else v.pause();
  };

  const seek = (t: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = t;
    setCur(t);
    setFrame(null);
  };

  const exactFrame = async () => {
    setFrameBusy(true);
    setFrameErr(null);
    video.current?.pause();
    try {
      const res = await fetch("/api/render/frame", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ versionId: srcId, recipe: shown, t: outT }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const blob = await res.blob();
      setFrame(URL.createObjectURL(blob));
    } catch (e) {
      setFrameErr((e as Error).message);
    } finally {
      setFrameBusy(false);
    }
  };

  const visibleTexts = shown.texts.filter((t) => outT >= t.from && (t.to === null || outT <= t.to));
  const origin = `${((shown.panX + 1) / 2) * 100}% ${((shown.panY + 1) / 2) * 100}%`;
  const payload = useMemo(() => JSON.stringify(recipe), [recipe]);
  const vPayload = useMemo(() => JSON.stringify(variation), [variation]);

  return (
    <form action={props.action} className="grid gap-5 lg:grid-cols-[300px_1fr]">
      {Object.entries(props.hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input type="hidden" name="recipe" value={payload} />
      {props.mode === "template" && <input type="hidden" name="variation" value={vPayload} />}

      {/* ---------- preview ---------- */}
      <div className="lg:sticky lg:top-4 lg:self-start">
        {props.sources.length > 1 && (
          <select className="input mb-2" value={srcId} onChange={(e) => { setSrcId(e.target.value); setFrame(null); }}>
            {props.sources.map((s) => (
              <option key={s.versionId} value={s.versionId}>{s.label}</option>
            ))}
          </select>
        )}
        <div className="relative mx-auto overflow-hidden rounded-lg bg-black" style={{ width: W, height: (W * 16) / 9 }}>
          {src ? (
            <video
              ref={video}
              key={src.versionId}
              src={`/api/media/${src.versionId}`}
              className="absolute inset-0 h-full w-full"
              style={{ objectFit: "cover", objectPosition: origin, transform: `scale(${shown.zoom})`, transformOrigin: origin, filter: cssFilter(shown) }}
              playsInline
              preload="metadata"
              onTimeUpdate={onTime}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onLoadedMetadata={() => seek(shown.trimStart)}
            />
          ) : (
            <div className="p-4 text-sm text-white/70">Нет исходника: сначала загрузите каталог</div>
          )}
          {shown.vignette && <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,.55) 100%)" }} />}
          {visibleTexts.map((t, i) => (
            <div
              key={i}
              className="pointer-events-none absolute left-0 right-0 flex justify-center px-2 text-center font-bold leading-tight"
              style={{
                top: t.pos === "top" ? "10%" : t.pos === "center" ? "50%" : undefined,
                bottom: t.pos === "bottom" ? "20%" : undefined,
                transform: t.pos === "center" ? "translateY(-50%)" : undefined,
                fontSize: t.size * K,
                color: t.color,
                textShadow: "0 0 3px #000, 0 0 3px #000, 0 0 2px #000",
                whiteSpace: "pre-wrap",
              }}
            >
              <span style={{ background: t.box ? "rgba(0,0,0,.45)" : undefined, padding: t.box ? `${t.size * K * 0.3}px ${t.size * K * 0.35}px` : undefined }}>{t.text}</span>
            </div>
          ))}
          {frame && <img src={frame} alt="Точный кадр" className="absolute inset-0 h-full w-full" />}
        </div>

        <div className="mx-auto mt-2" style={{ width: W }}>
          <input type="range" className="w-full" min={0} max={srcDur ?? 100} step={0.1} value={cur} onChange={(e) => seek(Number(e.target.value))} />
          <div className="relative h-1.5 rounded bg-gray-200 dark:bg-gray-700">
            {srcDur ? (
              <div
                className="absolute h-1.5 rounded bg-blue-500"
                style={{ left: `${(shown.trimStart / srcDur) * 100}%`, width: `${((Math.min(end || srcDur, srcDur) - shown.trimStart) / srcDur) * 100}%` }}
              />
            ) : null}
          </div>
          <div className="mt-1 flex justify-between text-xs muted">
            <span>исходник {fmt(cur)}</span>
            <span>
              итог {fmt(outT)}
              {outDur ? ` / ${fmt(outDur)}` : ""}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className="btn btn-sm" onClick={toggle}>{playing ? "Пауза" : "Играть"}</button>
            <button type="button" className="btn btn-sm" onClick={() => set("trimStart", Math.round(cur * 10) / 10)}>Начало здесь</button>
            <button type="button" className="btn btn-sm" onClick={() => set("trimEnd", Math.round(cur * 10) / 10)}>Конец здесь</button>
            <button type="button" className="btn btn-sm" onClick={() => set("coverTime", Math.round(outT * 10) / 10)}>Обложка здесь</button>
            <button type="button" className="btn btn-sm" onClick={exactFrame} disabled={frameBusy}>{frameBusy ? "Считаю…" : "Точный кадр"}</button>
          </div>
          {frameErr && <p className="mt-1 text-xs text-red-600">{frameErr}</p>}
          <p className="mt-2 text-xs muted">
            Видео выше показывает примерный вид. «Точный кадр» собирает настоящий кадр с фильтрами, текстом и крючком.
          </p>
          {props.mode === "template" && (
            <div className="mt-2 flex gap-1.5">
              <button type="button" className="btn btn-sm" onClick={() => setSample(sampleRecipe(recipe, variation, Math.random))}>Случайная версия</button>
              {sample && <button type="button" className="btn btn-sm" onClick={() => setSample(null)}>Вернуть основу</button>}
            </div>
          )}
          {sample && <p className="mt-1 text-xs muted">Показана случайная версия: {PRESETS[sample.preset]}, зум {sample.zoom}, начало {sample.trimStart} с</p>}
        </div>
      </div>

      {/* ---------- controls ---------- */}
      <div className="grid gap-4">
        {props.mode === "template" && (
          <div className="card grid gap-3 p-4 md:grid-cols-2">
            <label className="block"><span className="label">Название шаблона</span><input className="input" name="name" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="block"><span className="label">Заметка</span><input className="input" name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          </div>
        )}

        <div className="card grid gap-3 p-4 md:grid-cols-4">
          <div className="md:col-span-4 font-medium">Обрезка</div>
          <Num label="Начало, с" value={recipe.trimStart} onChange={(v) => set("trimStart", v ?? 0)} />
          <Num label="Конец, с (пусто = до конца)" value={recipe.trimEnd} onChange={(v) => set("trimEnd", v)} />
          <Num label="Не длиннее, с" value={recipe.maxDuration} onChange={(v) => set("maxDuration", v)} placeholder="без лимита" />
          <Num label="Скорость" value={recipe.speed} step={0.01} onChange={(v) => set("speed", v ?? 1)} />
          <label className="flex items-center gap-2 text-sm md:col-span-4">
            <input type="checkbox" checked={Boolean(recipe.hook)} onChange={(e) => set("hook", e.target.checked ? { from: Math.round(cur * 10) / 10, length: 2.5 } : null)} />
            Крючок: показать в начале кусок из середины серии
          </label>
          {recipe.hook && (
            <>
              <Num label="Крючок с, с" value={recipe.hook.from} onChange={(v) => set("hook", { ...recipe.hook!, from: v ?? 0 })} />
              <Num label="Длина крючка, с" value={recipe.hook.length} onChange={(v) => set("hook", { ...recipe.hook!, length: v ?? 2.5 })} />
            </>
          )}
        </div>

        <div className="card grid gap-3 p-4 md:grid-cols-3">
          <div className="md:col-span-3 font-medium">Кадр и цвет</div>
          <Slider label="Зум" value={recipe.zoom} min={1} max={1.5} step={0.01} onChange={(v) => set("zoom", v)} />
          <Slider label="Сдвиг по горизонтали" value={recipe.panX} min={-1} max={1} step={0.05} onChange={(v) => set("panX", v)} />
          <Slider label="Сдвиг по вертикали" value={recipe.panY} min={-1} max={1} step={0.05} onChange={(v) => set("panY", v)} />
          <label className="block">
            <span className="label">Фильтр</span>
            <select className="input" value={recipe.preset} onChange={(e) => set("preset", e.target.value as Preset)}>
              {Object.entries(PRESETS).map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </select>
          </label>
          <Slider label="Яркость" value={recipe.brightness} min={-0.3} max={0.3} step={0.01} onChange={(v) => set("brightness", v)} />
          <Slider label="Контраст" value={recipe.contrast} min={0.7} max={1.5} step={0.01} onChange={(v) => set("contrast", v)} />
          <Slider label="Насыщенность" value={recipe.saturation} min={0} max={2} step={0.01} onChange={(v) => set("saturation", v)} />
          <Slider label="Зерно" value={recipe.grain} min={0} max={30} step={1} onChange={(v) => set("grain", v)} />
          <div className="flex flex-wrap items-end gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={recipe.sharpen} onChange={(e) => set("sharpen", e.target.checked)} /> Резкость</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={recipe.vignette} onChange={(e) => set("vignette", e.target.checked)} /> Виньетка</label>
          </div>
          <Num label="Появление, с" value={recipe.fadeIn} onChange={(v) => set("fadeIn", v ?? 0)} />
          <Num label="Затухание в конце, с" value={recipe.fadeOut} onChange={(v) => set("fadeOut", v ?? 0)} />
          <Slider label="Громкость" value={recipe.volume} min={0} max={2} step={0.05} onChange={(v) => set("volume", v)} />
        </div>

        <div className="card grid gap-3 p-4">
          <div className="flex items-center justify-between">
            <span className="font-medium">Текст поверх видео</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => set("texts", [...recipe.texts, { text: "Текст", from: 0, to: 3, pos: "top", size: 64, color: "white", box: true }])}
            >
              + Текст
            </button>
          </div>
          {recipe.texts.length === 0 && <p className="text-sm muted">Нет текста. Например, крючок сверху на первые 3 секунды или @ник внизу.</p>}
          <p className="text-xs muted">{"{handle}"} в тексте заменится на ник аккаунта, за которым закреплена версия.</p>
          {recipe.texts.map((t, i) => (
            <div key={i} className="grid gap-2 rounded-lg border p-3 md:grid-cols-6" style={{ borderColor: "var(--border)" }}>
              <label className="block md:col-span-6">
                <span className="label">Текст</span>
                <textarea className="input" rows={2} value={t.text} onChange={(e) => setText(i, { text: e.target.value })} />
              </label>
              <Num label="С, с" value={t.from} onChange={(v) => setText(i, { from: v ?? 0 })} />
              <Num label="До, с (пусто = до конца)" value={t.to} onChange={(v) => setText(i, { to: v })} />
              <label className="block">
                <span className="label">Где</span>
                <select className="input" value={t.pos} onChange={(e) => setText(i, { pos: e.target.value as TextOverlay["pos"] })}>
                  <option value="top">Сверху</option>
                  <option value="center">По центру</option>
                  <option value="bottom">Снизу</option>
                </select>
              </label>
              <Num label="Размер" value={t.size} step={2} onChange={(v) => setText(i, { size: v ?? 64 })} />
              <label className="block">
                <span className="label">Цвет</span>
                <select className="input" value={t.color} onChange={(e) => setText(i, { color: e.target.value })}>
                  <option value="white">Белый</option>
                  <option value="yellow">Жёлтый</option>
                  <option value="cyan">Голубой</option>
                  <option value="red">Красный</option>
                  <option value="black">Чёрный</option>
                </select>
              </label>
              <div className="flex items-end justify-between gap-2 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" checked={t.box} onChange={(e) => setText(i, { box: e.target.checked })} /> Плашка</label>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => set("texts", recipe.texts.filter((_, j) => j !== i))}>×</button>
              </div>
            </div>
          ))}
          <Num label="Кадр для обложки, с (от начала итогового видео)" value={recipe.coverTime} onChange={(v) => set("coverTime", v ?? 1)} />
        </div>

        {props.mode === "template" && (
          <div className="card grid gap-2 p-4">
            <div className="font-medium">Чем версии отличаются друг от друга</div>
            <p className="text-xs muted">
              Для каждой версии значение выбирается случайно в диапазоне «от–до» (вместо значения из основы выше). Одинаковых версий одной серии не будет.
            </p>
            <RangeRow label="Начало, с" step={0.1} value={variation.trimStart} onChange={(v) => setVariation({ ...variation, trimStart: v })} />
            <RangeRow label="Зум" value={variation.zoom} onChange={(v) => setVariation({ ...variation, zoom: v })} />
            <RangeRow label="Сдвиг гориз." value={variation.panX} onChange={(v) => setVariation({ ...variation, panX: v })} />
            <RangeRow label="Сдвиг верт." value={variation.panY} onChange={(v) => setVariation({ ...variation, panY: v })} />
            <RangeRow label="Скорость" value={variation.speed} onChange={(v) => setVariation({ ...variation, speed: v })} />
            <RangeRow label="Яркость" value={variation.brightness} onChange={(v) => setVariation({ ...variation, brightness: v })} />
            <RangeRow label="Контраст" value={variation.contrast} onChange={(v) => setVariation({ ...variation, contrast: v })} />
            <RangeRow label="Насыщенность" value={variation.saturation} onChange={(v) => setVariation({ ...variation, saturation: v })} />
            <RangeRow label="Зерно" step={1} value={variation.grain} onChange={(v) => setVariation({ ...variation, grain: v })} />
            <RangeRow label="Обложка, с" step={0.1} value={variation.coverTime} onChange={(v) => setVariation({ ...variation, coverTime: v })} />
            <div className="mt-2">
              <span className="label">Фильтры (каждой версии достаётся один из отмеченных)</span>
              <div className="flex flex-wrap gap-3 text-sm">
                {Object.entries(PRESETS).map(([k, l]) => (
                  <label key={k} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={variation.presets?.includes(k as Preset) ?? false}
                      onChange={(e) =>
                        setVariation({ ...variation, presets: e.target.checked ? [...(variation.presets ?? []), k as Preset] : (variation.presets ?? []).filter((p) => p !== k) })
                      }
                    />
                    {l}
                  </label>
                ))}
              </div>
            </div>
            <label className="mt-2 block">
              <span className="label">Тексты-крючки сверху, по одному на строку (каждой версии достаётся один)</span>
              <textarea
                className="input"
                rows={4}
                value={(variation.hookTexts ?? []).join("\n")}
                onChange={(e) => setVariation({ ...variation, hookTexts: e.target.value.split("\n") })}
                placeholder={"She had no idea who he really was…\nWait for the ending 😳"}
              />
            </label>
            <div className="grid gap-2 md:grid-cols-3">
              <Num label="Крючок-текст держится, с" value={variation.hookTextSeconds ?? 3} onChange={(v) => setVariation({ ...variation, hookTextSeconds: v ?? 3 })} />
              <Num label="Доля версий с клипом-крючком, 0–1" step={0.05} value={variation.hookChance ?? 0} onChange={(v) => setVariation({ ...variation, hookChance: v ?? 0 })} />
              <Num label="Длина клипа-крючка, с" value={variation.hookLength ?? 2.5} onChange={(v) => setVariation({ ...variation, hookLength: v ?? 2.5 })} />
            </div>
            {(variation.hookChance ?? 0) > 0 && (
              <RangeRow label="Клип-крючок из, с" step={1} value={variation.hookFrom} onChange={(v) => setVariation({ ...variation, hookFrom: v })} />
            )}
          </div>
        )}

        {props.mode === "variant" && (
          <label className="card block p-4">
            <span className="label">Заметка к версии</span>
            <input className="input" name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        )}

        <div className="flex gap-2">
          <button className="btn btn-primary">{props.submitLabel}</button>
        </div>
      </div>
    </form>
  );
}

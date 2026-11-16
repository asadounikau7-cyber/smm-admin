import type { JobStatus, Platform } from "@prisma/client";

export const STATUS_LABEL: Record<JobStatus, string> = {
  DRAFT: "Черновик",
  BLOCKED: "Заблокировано",
  QUEUED: "В очереди",
  SENT: "Отправлено",
  PROCESSING: "Обрабатывается",
  PUBLISHED: "Опубликовано",
  ACTION_REQUIRED: "Требуется действие",
  MANUALLY_SCHEDULED: "Запланировано вручную",
  FAILED: "Ошибка",
  CANCEL_PENDING: "Отмена ожидает подтверждения",
  CANCELLED: "Отменено",
  UNKNOWN: "Результат неизвестен",
};

const STATUS_COLOR: Record<JobStatus, string> = {
  DRAFT: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  BLOCKED: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  QUEUED: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  SENT: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  PROCESSING: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  PUBLISHED: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  ACTION_REQUIRED: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  MANUALLY_SCHEDULED: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  FAILED: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  CANCEL_PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  CANCELLED: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
  UNKNOWN: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_COLOR[status]}`}>{STATUS_LABEL[status]}</span>;
}

export const PLATFORM_LABEL: Record<Platform, string> = { YOUTUBE: "YouTube", INSTAGRAM: "Instagram", TIKTOK: "TikTok" };
const PLATFORM_DOT: Record<Platform, string> = { YOUTUBE: "bg-red-500", INSTAGRAM: "bg-pink-500", TIKTOK: "bg-gray-900 dark:bg-gray-100" };

export function PlatformTag({ platform }: { platform: Platform }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={`h-2 w-2 rounded-full ${PLATFORM_DOT[platform]}`} />
      {PLATFORM_LABEL[platform]}
    </span>
  );
}

export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="card p-6 text-sm muted">{children}</div>;
}

export function Flash({ msg, kind = "ok" }: { msg?: string | null; kind?: "ok" | "err" }) {
  if (!msg) return null;
  return (
    <div className={`mb-4 rounded-lg px-3 py-2 text-sm ${kind === "ok" ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"}`}>
      {msg}
    </div>
  );
}

export function fmtSize(bytes: number | bigint | null | undefined) {
  if (bytes == null) return "—";
  const n = Number(bytes);
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} КБ`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`;
  return `${(n / 1024 ** 3).toFixed(2)} ГБ`;
}

export function fmtDur(sec: number | null | undefined) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

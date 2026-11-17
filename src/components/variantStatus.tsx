import type { VariantStatus } from "@prisma/client";

export const VARIANT_STATUS: Record<VariantStatus, string> = { PENDING: "В очереди", RENDERING: "Собирается", READY: "Готово", FAILED: "Ошибка" };
const COLOR: Record<VariantStatus, string> = {
  PENDING: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  RENDERING: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  READY: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  FAILED: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

export function VariantBadge({ status }: { status: VariantStatus }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${COLOR[status]}`}>{VARIANT_STATUS[status]}</span>;
}

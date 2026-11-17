"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Обзор" },
  { href: "/plan", label: "Неделя" },
  { href: "/publications", label: "Публикации" },
  { href: "/catalog", label: "Каталог" },
  { href: "/variants", label: "Версии" },
  { href: "/templates", label: "Шаблоны" },
  { href: "/rules", label: "Правила" },
  { href: "/accounts", label: "Аккаунты" },
  { href: "/profiles", label: "Профили Octo" },
  { href: "/settings", label: "Настройки" },
];

export function Nav({ issues }: { issues: number }) {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:px-2 md:pb-0">
      {ITEMS.map((i) => {
        const active = i.href === "/" ? path === "/" : path.startsWith(i.href);
        return (
          <Link
            key={i.href}
            href={i.href}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${active ? "font-medium" : "muted"}`}
            style={active ? { background: "var(--bg)" } : undefined}
          >
            {i.label}
            {i.href === "/" && issues > 0 && <span className="ml-2 rounded-full bg-amber-500 px-1.5 text-xs text-white">{issues}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

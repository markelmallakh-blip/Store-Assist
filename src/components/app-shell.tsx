"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconBox, IconCamera, IconHome, IconLayers, IconSettings } from "./icons";

const NAV = [
  { href: "/", label: "Today", Icon: IconHome },
  { href: "/purchase", label: "Purchase", Icon: IconCamera },
  { href: "/products", label: "Products", Icon: IconBox },
  { href: "/bundles", label: "Bundles", Icon: IconLayers },
  { href: "/settings", label: "Settings", Icon: IconSettings },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login") return <>{children}</>;
  const active = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/80 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid size-7 place-items-center rounded-lg bg-surface-2 text-[13px] font-bold text-neon ring-1 ring-neon/60 glow-neon">SA</span>
            <span>Store Assist</span>
            <span className="hidden text-sm font-normal text-fg-muted sm:inline">· Cupcairo</span>
          </Link>
          <nav className="ml-auto hidden gap-1 md:flex">
            {NAV.map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${
                  active(href) ? "bg-neon/10 font-medium text-neon" : "text-fg-muted hover:bg-surface-3"
                }`}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="pb-safe mx-auto max-w-6xl px-4 pt-4 md:pt-6">{children}</main>

      <nav className="bottom-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/90 backdrop-blur md:hidden">
        <div className="grid grid-cols-5">
          {NAV.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              className={`flex flex-col items-center gap-0.5 py-2 text-[11px] ${active(href) ? "text-neon" : "text-fg-muted"}`}
            >
              <Icon className={`size-6 ${active(href) ? "stroke-[2.2]" : ""}`} />
              {label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}

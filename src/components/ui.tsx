"use client";

import { useCallback, useEffect, useState } from "react";
import { IconAlert, IconRefresh } from "./icons";

// ---------- data ----------

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    cache: "no-store",
  });
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export function useApi<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<T>(url));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

// ---------- formatting ----------

const egp = new Intl.NumberFormat("en-EG", { maximumFractionDigits: 2 });
export const money = (n: number | null | undefined) => (n == null ? "—" : `${egp.format(n)} EGP`);
export const qty = (n: number | null | undefined) => (n == null ? "—" : String(n));

export const ageInDays = (iso: string) => (Date.now() - Date.parse(iso)) / 86_400_000;

export function timeAgo(iso: string) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// ---------- building blocks ----------

export function Card({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return <div className={`rounded-2xl border border-line bg-surface shadow-[0_1px_0_rgba(255,255,255,0.03)_inset] ${className}`}>{children}</div>;
}

const tones = {
  red: "bg-pink/10 text-pink ring-pink/30",
  amber: "bg-amber/10 text-amber ring-amber/30",
  green: "bg-green/10 text-green ring-green/30",
  stone: "bg-surface-3 text-fg-muted ring-line-strong",
  accent: "bg-neon/10 text-neon ring-neon/30",
  blue: "bg-cyan/10 text-cyan ring-cyan/30",
};

export function Badge({ tone = "stone", children, className = "" }: { tone?: keyof typeof tones; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[tone]} ${className}`}>
      {children}
    </span>
  );
}

const buttonStyles = {
  primary: "bg-neon text-neon-ink glow-neon hover:brightness-110 disabled:bg-surface-3 disabled:text-fg-subtle disabled:shadow-none",
  /** Neon outline, for actions repeated down a list (one solid primary per screen). */
  soft: "bg-neon/10 text-neon ring-1 ring-inset ring-neon/40 hover:bg-neon/20 disabled:text-fg-subtle disabled:ring-line",
  secondary: "bg-surface-2 text-fg ring-1 ring-inset ring-line-strong hover:bg-surface-3 disabled:text-fg-subtle",
  ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg disabled:text-fg-subtle",
  success: "bg-green/15 text-green ring-1 ring-inset ring-green/50 hover:bg-green/25 disabled:bg-surface-3 disabled:text-fg-subtle disabled:ring-0",
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  loading,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof buttonStyles; size?: "sm" | "md" | "lg"; loading?: boolean }) {
  const sizes = { sm: "h-8 px-3 text-xs", md: "h-10 px-4 text-sm", lg: "h-12 px-5 text-base" };
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-medium transition active:scale-[0.98] disabled:cursor-not-allowed ${sizes[size]} ${buttonStyles[variant]} ${className}`}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

export function LinkButton({ href, className = "", children, external }: { href: string; className?: string; children: React.ReactNode; external?: boolean }) {
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-medium ring-1 ring-inset ring-line-strong transition hover:bg-surface-2 active:scale-[0.98] ${className}`}
    >
      {children}
    </a>
  );
}

export function Spinner({ className = "size-5" }: { className?: string }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-r-transparent ${className}`} aria-label="Loading" />;
}

export function Thumb({ src, alt = "" }: { src: string | null; alt?: string }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element -- Shopify CDN thumbnails, already resized
    <img src={src} alt={alt} className="size-11 shrink-0 rounded-lg border border-line bg-tile object-contain" loading="lazy" />
  ) : (
    <div className="size-11 shrink-0 rounded-lg border border-dashed border-line-strong bg-surface-2" />
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-pink/30 bg-pink/10 p-4 text-sm text-pink">
      <IconAlert className="mt-0.5 size-5 text-pink" />
      <div className="flex-1 break-words">{message}</div>
      {onRetry && (
        <button onClick={onRetry} className="font-medium underline">
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong bg-surface/60 px-4 py-8 text-center">
      <div className="font-medium text-fg">{title}</div>
      {children && <div className="mt-1 text-sm text-fg-muted">{children}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  onRefresh,
  loading,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  onRefresh?: () => void;
  loading?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-0.5 text-sm text-fg-muted">{subtitle}</div>}
      </div>
      {children}
      {onRefresh && (
        <Button variant="secondary" size="sm" onClick={onRefresh} disabled={loading} aria-label="Refresh">
          {loading ? <Spinner className="size-4" /> : <IconRefresh className="size-4" />}
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-20 animate-pulse rounded-2xl bg-surface-2" />
      ))}
    </div>
  );
}

/** Tiny toast used after actions. */
export function useToast() {
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  const node = toast ? (
    <div role="status" aria-live="polite" className="fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 md:bottom-8">
      <div className={`rounded-xl px-4 py-2.5 text-sm font-medium shadow-lg shadow-black/40 ${toast.tone === "ok" ? "bg-surface-3 text-fg ring-1 ring-neon/40" : "bg-pink text-neon-ink"}`}>{toast.text}</div>
    </div>
  ) : null;
  return { show: (text: string, tone: "ok" | "err" = "ok") => setToast({ text, tone }), node };
}

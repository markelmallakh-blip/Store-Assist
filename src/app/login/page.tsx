"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

function Login() {
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(params.get("error"));
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
      return;
    }
    const data = await res.json().catch(() => ({}));
    setError(data.error ?? "Couldn't sign in");
    setLoading(false);
  }

  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <form method="post" action="/api/auth/login" onSubmit={submit} className="w-full max-w-sm rounded-3xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-surface-2 font-bold text-neon ring-1 ring-neon/60 glow-neon">SA</span>
          <div>
            <div className="text-lg font-semibold">Store Assist</div>
            <div className="text-sm text-fg-muted">Cupcairo admin</div>
          </div>
        </div>
        <label className="mb-1.5 block text-sm font-medium" htmlFor="pw">
          Password
        </label>
        <input
          id="pw"
          name="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-11 w-full rounded-xl px-3 bg-surface-2 ring-1 ring-inset ring-line-strong outline-none focus:ring-2 focus:ring-neon"
        />
        {error && <p className="mt-2 text-sm text-pink">{error}</p>}
        <button
          disabled={loading || !password}
          className="mt-4 h-11 w-full rounded-xl bg-neon font-medium text-neon-ink glow-neon transition hover:brightness-110 disabled:bg-surface-3 disabled:text-fg-subtle disabled:shadow-none"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

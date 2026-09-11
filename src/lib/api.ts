import { NextResponse } from "next/server";

/** Wrap a route handler so thrown errors become a JSON { error } response instead of a crash page. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A) => {
    try {
      const result = await fn(...args);
      return result instanceof Response ? result : NextResponse.json(result);
    } catch (e) {
      console.error(e);
      const message = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  };
}

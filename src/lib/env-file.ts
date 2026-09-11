import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Settings typed into the dashboard can only be saved to disk when running locally (not on Netlify/Vercel). */
export const canSaveLocally = () => process.env.NODE_ENV !== "production" && !process.env.NETLIFY && !process.env.VERCEL;

/** Set (or replace) KEY=value lines in .env.local. */
export async function writeEnvLocal(values: Record<string, string>) {
  const file = path.join(process.cwd(), ".env.local");
  let text = await readFile(file, "utf8").catch(() => "");
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) throw new Error(`Invalid value for ${key}`);
    const line = `${key}=${value}`;
    const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text}${text.endsWith("\n") || !text ? "" : "\n"}${line}\n`;
  }
  await writeFile(file, text);
}

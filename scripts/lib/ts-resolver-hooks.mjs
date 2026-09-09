import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXTENSIONS = [".ts", ".mts", ".tsx"];

export async function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  const hasExtension = /\.[a-z]+$/i.test(specifier);
  if (relative && !hasExtension && context.parentURL) {
    const base = new URL(specifier, context.parentURL);
    for (const extension of EXTENSIONS) {
      const candidate = `${base.href}${extension}`;
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate, context);
    }
  }
  return nextResolve(specifier, context);
}

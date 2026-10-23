// 讓檢查腳本能直接 import 原始碼:補上 tsconfig 的 `@/` 別名,以及 TypeScript
// 省略的副檔名(node 兩樣都不認)。
//
// 用法:在腳本最前面
//   import { register } from "node:module";
//   register("./pa-alias-loader.mjs", import.meta.url);
// 然後才 await import("../src/server/pa/…")。

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = new URL("../src/", import.meta.url);

export async function resolve(specifier, context, next) {
  let s = specifier;
  if (s.startsWith("@/")) s = new URL(s.slice(2), SRC).href;

  const relative = s.startsWith("./") || s.startsWith("../");
  if ((relative || s.startsWith("file:")) && !/\.[a-z]+$/i.test(s)) {
    const base = s.startsWith("file:") ? s : new URL(s, context.parentURL).href;
    for (const suffix of [".ts", ".tsx", "/index.ts"]) {
      if (existsSync(fileURLToPath(base + suffix))) return next(base + suffix, context);
    }
  }
  return next(s, context);
}

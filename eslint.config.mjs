import { FlatCompat } from "@eslint/eslintrc";
import { globalIgnores } from "eslint/config";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });
const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  globalIgnores([".next/**", ".next-dev/**", "node_modules/**", "outputs/**", "next-env.d.ts"]),
];

export default config;

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Serwist's build output (see .gitignore). Generated on every `pnpm build`,
    // minified and not ours to lint — without this, `pnpm lint` after a build
    // reports errors inside a file nobody wrote.
    "public/sw.js",
    "public/swe-worker-*.js",
  ]),
]);

export default eslintConfig;

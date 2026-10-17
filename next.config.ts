import { spawnSync } from "node:child_process";

import withSerwistInit from "@serwist/next";
import type { NextConfig } from "next";

/**
 * Serwist is registered as a webpack plugin, so the POS builds and develops
 * with `--webpack` (see `package.json`). Turbopack has its own, separate
 * Serwist integration (`@serwist/turbopack`); mixing the two would silently
 * ship a build with no service worker, which is the one thing a POS that must
 * survive a dropped connection cannot ship. One build tool, one pipeline.
 *
 * A revision string lets Serwist version precached entries. Without it, an
 * offline terminal can keep serving yesterday's shell after a deploy.
 */
const revision =
  spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).stdout ??
  crypto.randomUUID();

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  // Keep navigation responses in the runtime cache for instant back/forward.
  cacheOnNavigation: true,
  additionalPrecacheEntries: [{ url: "/~offline", revision }],
});

const nextConfig: NextConfig = {
  experimental: {
    agentFeedback: true,
  },
  // The POS is a client-rendered app over IndexedDB. Cache Components keeps the
  // route shells static and prerendered, which is exactly what has to be on
  // disk before the first offline load.
  cacheComponents: true,
  partialPrefetching: true,
  // Product photography lives in the shared Supabase `product-images` bucket and
  // `product.image_url` is the object's public URL. `remotePatterns` is the
  // allow-list an external `next/image` `src` is checked against. The two
  // entries are the hosted project (`*.supabase.co`) and its local development
  // twin (`127.0.0.1:54321`), because the same catalogue is served from both
  // depending on where the storefront is running.
  //
  // The grid itself renders these with a plain `<img>` (see
  // components/pos/product-grid.tsx) so the browser's cache serves them offline;
  // this list keeps `next/image` — used for the local logo — honest about where
  // remote images may come from.
  images: {
    remotePatterns: [
      {
        protocol: "http",
        hostname: "127.0.0.1",
        port: "54321",
        pathname: "/storage/v1/object/public/**",
      },
      {
        protocol: "https",
        hostname: "*.supabase.co",
        port: "",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
  // Tailwind is wired through PostCSS (postcss.config.mjs) so that both the
  // Turbopack dev server and the webpack production build produce identical
  // utility output.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default withSerwist(nextConfig);

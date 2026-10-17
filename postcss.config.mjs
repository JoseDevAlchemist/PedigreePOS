/**
 * Tailwind CSS v4 runs through PostCSS here.
 *
 * `@serwist/next` is a webpack plugin, so the POS builds with `next build --webpack`
 * (see package.json). Turbopack's bespoke Tailwind loader is not used on that
 * path, so the stylesheet pipeline is wired up through PostCSS instead — one
 * pipeline that works under webpack and Turbopack alike.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;

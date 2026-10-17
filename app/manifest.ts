import type { MetadataRoute } from "next";

/**
 * Web app manifest. Served at `/manifest.webmanifest`; Next adds the
 * `<link rel="manifest">` to every document itself, so no manual tag is needed.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Pedigree POS",
    short_name: "Pedigree POS",
    description:
      "Point of sale for the Pedigree Leather workshop. Works offline; syncs when the connection returns.",
    id: "/pos",
    start_url: "/pos",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f5e9d9",
    theme_color: "#5d4037",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

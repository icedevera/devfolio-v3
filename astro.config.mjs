import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://www.icedevera.com",
  devToolbar: { enabled: false },
  // Match v2's URLs: /articles/<slug>, no trailing slash.
  trailingSlash: "never",
  build: { format: "file" },
  // v2 pages that no longer exist.
  redirects: {
    "/about": "/",
    "/projects": "/",
    "/thank-you": "/",
    "/uses": "/",
  },
  // three.js alone is over Vite's 500 kB warning. The 3D stages that use it
  // load after the page, while the early ones play. Its license notice stays
  // in the bundle, as the MIT license asks.
  vite: {
    build: {
      chunkSizeWarningLimit: 650,
      rolldownOptions: { output: { comments: { legal: true } } },
    },
  },
  markdown: {
    // Colors come from --astro-code-* variables in global.css.
    shikiConfig: { theme: "css-variables" },
  },
});

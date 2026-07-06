// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// 100% static site: the game runs entirely in the browser (Azure Speech SDK
// for JS talks directly to the service). No backend: players set credentials
// in Settings and they live in their localStorage.
//
// GitHub Pages serves the site under /<repo>/, so builds there need `base`
// (assets 404 without it). The workflow sets GITHUB_PAGES=true; local
// dev/preview keep serving from the root.
export default defineConfig({
  integrations: [react()],
  site: "https://iam-oov.github.io",
  base: process.env.GITHUB_PAGES ? "/english-full" : undefined,
});

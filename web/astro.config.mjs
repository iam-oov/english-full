// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// 100% static site: the game runs entirely in the browser (Azure Speech SDK
// for JS talks directly to the service). No backend: players set credentials
// in Settings and they live in their localStorage.
export default defineConfig({
  integrations: [react()],
});

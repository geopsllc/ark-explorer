import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// base "./" + hash routing: the built dist/ folder works from any static webserver and any
// sub-path (e.g. https://example.com/explorer/) without rewrite rules.
export default defineConfig({
  base: "./",
  plugins: [svelte()],
  server: { port: 1430, strictPort: true },
  preview: { port: 1431, strictPort: true },
  build: { target: "es2020", assetsInlineLimit: 0 },
});

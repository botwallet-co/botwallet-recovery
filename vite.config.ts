import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "../dist",
    minify: false,
    target: "es2022",
    assetsInlineLimit: Infinity,
    emptyOutDir: true,
  },
  root: "src",
});

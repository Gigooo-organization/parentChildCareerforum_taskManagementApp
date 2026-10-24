import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import vize from "@vizejs/vite-plugin";
import { previewBoundary } from "./preview";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const appDir = process.env.BOOTH_APP_DIR;
const outDir = process.env.BOOTH_BUILD_DIR;
if (!appDir || !outDir) throw new Error("参加者アプリの作業フォルダを指定してください。");

export default defineConfig({
  root: appDir,
  envDir: false,
  envPrefix: [],
  plugins: [
    previewBoundary(appDir, [join(repoRoot, "shared"), join(repoRoot, "node_modules")]),
    vize(),
  ],
  resolve: {
    alias: {
      "@booth-shared": join(repoRoot, "shared"),
      vue: join(repoRoot, "node_modules", "vue", "dist", "vue.runtime.esm-bundler.js"),
    },
  },
  build: { outDir, emptyOutDir: true },
});

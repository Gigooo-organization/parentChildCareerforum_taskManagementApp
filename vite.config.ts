import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite-plus";
import vueDevTools from "vite-plugin-vue-devtools";

import { createVizeLintConfig } from "oxlint-plugin-vize";
import vize from "@vizejs/vite-plugin";

// vize() は @vitejs/plugin-vue の置き換えであって併用ではない。
// 両方 plugins に入れると SFC を二重にコンパイルしようとして
// `App.vue.ts` を読みに行き、build が ENOENT で落ちる。
export default defineConfig({
  lint: createVizeLintConfig({
    preset: "happy-path",
    settings: {
      helpLevel: "short",
    },
  }),
  plugins: [vize(), vueDevTools()],
  server: {
    watch: {
      // nix-direnv が .direnv/flake-inputs 配下に nixpkgs のソース全体を
      // 置くため、除外しないと dev サーバのウォッチャがそれを走査して
      // 起動しなくなる（無関係な tsconfig.json や index.html も拾う）。
      ignored: ["**/.direnv/**"],
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});

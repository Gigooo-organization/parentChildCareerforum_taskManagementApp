import { defineConfig } from "vize";

export default defineConfig({
  compiler: {
    templateSyntax: "standard",
  },
  linter: {
    enabled: true,
    preset: "happy-path",
  },
  formatter: {
    singleAttributePerLine: false,
    sortBlocks: true,
  },
  typeChecker: {
    enabled: true,
    strict: true,
    jsxTypecheck: true,
  },
  vite: {
    scanPatterns: ["src/**/*.vue", "booth-app/src/**/*.vue"],
  },
});

import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { previewBoundary, assertPreviewSource } from "./preview";
import vize from "@vizejs/vite-plugin";

const roots: string[] = [];
const servers: ViteDevServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(linked = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "booth-preview-")));
  roots.push(root);
  let app = join(root, "app");
  const shared = join(root, "shared");
  await mkdir(join(app, "src"), { recursive: true });
  if (linked) {
    const alias = join(root, "linked-app");
    await symlink(app, alias);
    app = alias;
  }
  await mkdir(shared);
  await writeFile(join(root, "outside.txt"), "PROTECTED_SENTINEL");
  await writeFile(join(root, "outside.css"), "body { color: red }");
  await writeFile(join(shared, "value.ts"), "export const value = 42");
  const server = await createServer({
    configFile: false,
    root: app,
    logLevel: "silent",
    plugins: [previewBoundary(app, [shared, join(process.cwd(), "node_modules")]), vize()],
    resolve: {
      alias: { vue: join(process.cwd(), "node_modules/vue/dist/vue.runtime.esm-bundler.js") },
    },
    server: {
      port: 0,
      host: "127.0.0.1",
      fs: {
        strict: true,
        allow: [await realpath(app), shared, join(process.cwd(), "node_modules")],
      },
    },
  });
  servers.push(server);
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("No preview address");
  return { root, app, server, url: `http://127.0.0.1:${address.port}` };
}

describe("preview file boundary", () => {
  it("applies source preflight through a symlinked root", async () => {
    const { app, server } = await fixture(true);
    await writeFile(join(app, "src", "main.css"), '@import "../../outside.css";');
    await expect(server.transformRequest("/src/main.css")).rejects.toThrow("プレビュー");
  });
  it("allows application modules and explicit shared modules", async () => {
    const { app, server } = await fixture();
    await writeFile(
      join(app, "src", "main.ts"),
      "import {value} from '../../shared/value'; export {value}",
    );
    expect((await server.transformRequest("/src/main.ts"))?.code).toContain("value");
  });
  it("transforms a normal Vue component and local CSS", async () => {
    const { app, server } = await fixture();
    await writeFile(
      join(app, "src", "App.vue"),
      "<template><h1>hi</h1></template><style>h1 {color: blue}</style>",
    );
    expect((await server.transformRequest("/src/App.vue"))?.code).toContain("h1");
  });
  it("keeps outside raw requests forbidden after a refused import", async () => {
    const { root, app, server, url } = await fixture();
    const outside = `${url}/@fs${join(root, "outside.txt")}?raw`;
    expect((await fetch(outside)).status).toBe(403);
    await writeFile(
      join(app, "src", "main.ts"),
      'import value from "../../outside.txt?raw"; export {value}',
    );
    await expect(server.transformRequest("/src/main.ts")).rejects.toThrow("プレビュー");
    const response = await fetch(outside);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("PROTECTED_SENTINEL");
  });
  it.each(["../../outside.txt?raw", "../../outside.txt?url"])(
    "rejects outside import %s before Vite grants it access",
    async (source) => {
      const { app, server } = await fixture();
      await writeFile(
        join(app, "src", "main.ts"),
        `import value from ${JSON.stringify(source)}; export {value}`,
      );
      await expect(server.transformRequest("/src/main.ts")).rejects.toThrow("プレビュー");
    },
  );
  it("rejects absolute paths and symlinks into outside files", async () => {
    const { root, app, server } = await fixture();
    await symlink(join(root, "outside.txt"), join(app, "src", "linked.txt"));
    for (const source of [join(root, "outside.txt") + "?raw", "./linked.txt?raw"]) {
      await writeFile(
        join(app, "src", "main.ts"),
        `import value from ${JSON.stringify(source)}; export {value}`,
      );
      server.moduleGraph.invalidateAll();
      await expect(server.transformRequest("/src/main.ts")).rejects.toThrow("プレビュー");
    }
  });
  it("accepts ordinary CSS styling but rejects parsed CSS URLs and escaped imports", () => {
    expect(() =>
      assertPreviewSource(
        "@media (min-width: 500px) { h1 {color:blue} } @keyframes hop {to {translate:0 -1px}}",
        "src/style.css",
      ),
    ).not.toThrow();
    for (const css of [
      "h1{background:url(../../outside.txt?inline)}",
      '@\\69mport "../../outside.css";',
    ]) {
      expect(() => assertPreviewSource(css, "src/style.css")).toThrow("プレビュー");
    }
  });
  it("rejects Vue external blocks, CSS Modules and preprocessors before compilation", () => {
    for (const code of [
      '<template src="../../outside.txt"></template>',
      '<template><h1>hi</h1></template><docs src="../../outside.txt"></docs>',
      '<template><h1>hi</h1></template><script src="../../outside.ts"></script>',
      '<template><h1>hi</h1></template><style src="../../outside.css"></style>',
      '<template><h1>hi</h1></template><style lang="scss">@use "../../outside";</style>',
      '<template><h1>hi</h1></template><style module>h1{composes: outside from "../../outside.css"}</style>',
    ])
      expect(() => assertPreviewSource(code, "src/App.vue")).toThrow("プレビュー");
  });
  it("rejects an outside import in actual Vue styles", async () => {
    const { app, server } = await fixture();
    await writeFile(
      join(app, "src", "App.vue"),
      '<template><h1>hi</h1></template><style>@import "../../outside.css";</style>',
    );
    await expect(server.transformRequest("/src/App.vue")).rejects.toThrow("プレビュー");
  });
  it("rejects outside URL assets before they can be inlined", async () => {
    const { app, server } = await fixture();
    await writeFile(
      join(app, "src", "main.ts"),
      'export const value = new URL("../../outside.txt?inline", import.meta.url).href',
    );
    await expect(server.transformRequest("/src/main.ts")).rejects.toThrow("プレビュー");
  });
  it("rejects outside CSS imports", async () => {
    const { app, server } = await fixture();
    await writeFile(join(app, "src", "main.css"), '@import "../../outside.css";');
    await expect(server.transformRequest("/src/main.css")).rejects.toThrow("プレビュー");
  });
});

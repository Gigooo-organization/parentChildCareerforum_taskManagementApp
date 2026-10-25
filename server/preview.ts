import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync, Visitor, type Plugin } from "vite";
import { transform as parseCss } from "lightningcss";
import { parse as parseSfc } from "vue/compiler-sfc";

export function assertPreviewSource(code: string, id: string) {
  function assertScript(content: string, filename: string) {
    const parsed = parseSync(filename, content);
    if (parsed.errors.length) throw new Error("プレビューのスクリプトを読み取れません。");
    new Visitor({
      MemberExpression(node) {
        if (node.object.type === "MetaProperty" && node.object.meta.name === "import") {
          const property =
            !node.computed && node.property.type === "Identifier" ? node.property.name : null;
          if (property !== "hot" && property !== "env")
            throw new Error("プレビューではimport.meta.hotとimport.meta.envだけを使えます。");
        }
      },
    }).visit(parsed.program);
  }
  function assertCss(content: string) {
    parseCss({
      filename: id,
      code: Buffer.from(content),
      visitor: {
        Rule: {
          import() {
            throw new Error("プレビューのCSSはJavaScriptから読み込んでください。");
          },
        },
        Url() {
          throw new Error("プレビューのCSSから画像や外部ファイルは読み込めません。");
        },
      },
    });
  }
  if (/\.vue$/.test(id)) {
    const { descriptor, errors } = parseSfc(code, { filename: id });
    if (errors.length) throw new Error("プレビューのVueファイルを読み取れません。");
    if (descriptor.customBlocks.length)
      throw new Error("プレビューのVueカスタムブロックは使えません。");
    for (const block of [
      descriptor.template,
      descriptor.script,
      descriptor.scriptSetup,
      ...descriptor.styles,
    ]) {
      if (block?.src) throw new Error("プレビューのVueブロックから外部ファイルは読み込めません。");
    }
    for (const style of descriptor.styles) {
      if (style.lang && style.lang !== "css")
        throw new Error("プレビューのスタイルにはCSSを使ってください。");
      if (style.module) throw new Error("プレビューではCSS Modulesを使えません。");
      assertCss(style.content);
    }
    for (const script of [descriptor.script, descriptor.scriptSetup]) {
      if (script) assertScript(script.content, script.lang === "ts" ? "source.ts" : "source.js");
    }
  } else if (/\.css(?:$|\?)/.test(id) || /[?&]type=style(?:&|$)/.test(id)) {
    if (/\.module\.css(?:$|\?)/.test(id))
      throw new Error("プレビューではCSS Modulesを使えません。");
    assertCss(code);
  } else if (/\.(?:ts|js)(?:$|\?)/.test(id)) {
    assertScript(code, id.split("?", 1)[0] ?? id);
  }
}

export function previewBoundary(appDir: string, allowedDirs: string[]): Plugin {
  const roots = [appDir, ...allowedDirs].map((path) => resolve(path));
  const sourceRoots = [
    appDir,
    ...allowedDirs.filter((path) => basename(path) !== "node_modules"),
  ].map((path) => resolve(path));
  function within(base: string, target: string) {
    const subpath = relative(base, target);
    return !subpath || (subpath !== ".." && !subpath.startsWith("../") && !isAbsolute(subpath));
  }

  async function canonical(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(path);
      if (parent === path) throw error;
      return join(await canonical(parent), relative(parent, path));
    }
  }

  async function assertFile(id: string) {
    if (id.startsWith("\0")) return;
    let path = id.split(/[?#]/, 1)[0] ?? "";
    if (path.startsWith("file:")) path = fileURLToPath(path);
    if (path.startsWith("/@fs/")) path = path.slice(4);
    if (!isAbsolute(path)) return;
    const target = await canonical(path);
    for (const root of roots) {
      const base = await canonical(root);
      if (within(base, target)) return;
    }
    throw new Error("プレビューで作業フォルダ外のファイルは読み込めません。");
  }

  return {
    name: "booth-preview-files",
    enforce: "pre",
    async resolveId(source, importer, options) {
      const result = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (result) await assertFile(result.id);
      return result;
    },
    async load(id) {
      await assertFile(id);
      const path = (id.split(/[?#]/, 1)[0] ?? "").replace(/\.vue\.ts$/, ".vue");
      if (path.endsWith(".vue")) assertPreviewSource(await readFile(path, "utf8"), path);
      return null;
    },
    async transform(code, id) {
      const path = id.split(/[?#]/, 1)[0] ?? "";
      if (id.startsWith("\0") || !isAbsolute(path)) return null;
      const target = await canonical(path);
      const bases = await Promise.all(sourceRoots.map(canonical));
      if (bases.some((root) => within(root, target))) assertPreviewSource(code, id);
      return null;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void (async () => {
          const url = decodeURIComponent(req.url?.split("?", 1)[0] ?? "/");
          if (!url.startsWith("/@vite/") && !url.startsWith("/@id/")) {
            await assertFile(url.startsWith("/@fs/") ? url : join(appDir, url));
          }
          next();
        })().catch(() => {
          res.writeHead(403);
          res.end("プレビューでこのファイルは読み込めません。");
        });
      });
    },
  };
}

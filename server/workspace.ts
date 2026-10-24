import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseFeatures } from "../shared/features";

export class Workspace {
  readonly root: string;
  readonly appDir: string;
  revision = 0;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.root = resolve(root);
    this.appDir = join(this.root, ".booth", "app");
  }

  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async #assertDirectory(path: string) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("作業フォルダが正しくありません。");
  }

  async #assertApp() {
    await this.#assertDirectory(join(this.root, ".booth"));
    await this.#assertDirectory(this.appDir);
    const stat = await lstat(join(this.appDir, "features.json"));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("設定ファイルが正しくありません。");
  }

  readFeatures() {
    return this.serialize(async () => {
      await this.#assertApp();
      return parseFeatures(JSON.parse(await readFile(join(this.appDir, "features.json"), "utf8")));
    });
  }

  writeFeatures(input: unknown, assertCurrent?: () => void) {
    return this.serialize(async () => {
      assertCurrent?.();
      const features = parseFeatures(input);
      await this.#assertApp();
      const temporary = join(this.appDir, `.features-${randomUUID()}.json`);
      try {
        await writeFile(temporary, JSON.stringify(features, null, 2) + "\n", { flag: "wx" });
        await rename(temporary, join(this.appDir, "features.json"));
      } finally {
        await rm(temporary, { force: true });
      }
      return features;
    });
  }

  reset() {
    return this.serialize(async () => {
      const boothDir = join(this.root, ".booth");
      await mkdir(boothDir, { recursive: true });
      await this.#assertDirectory(boothDir);
      const next = join(boothDir, `next-${randomUUID()}`);
      const previous = join(boothDir, `previous-${randomUUID()}`);
      let hadPrevious = false;
      try {
        await cp(join(this.root, "booth-app"), next, {
          recursive: true,
          filter: (source) =>
            !["node_modules", "dist", ".git"].includes(source.split(/[\\/]/).at(-1) ?? ""),
        });
        parseFeatures(JSON.parse(await readFile(join(next, "features.json"), "utf8")));
        try {
          const stat = await lstat(this.appDir);
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error("作業フォルダが正しくありません。");
          await rename(this.appDir, previous);
          hadPrevious = true;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        try {
          await rename(next, this.appDir);
        } catch (error) {
          if (hadPrevious) await rename(previous, this.appDir);
          throw error;
        }
        this.revision += 1;
      } finally {
        await rm(next, { recursive: true, force: true });
      }
      if (hadPrevious) await rm(previous, { recursive: true, force: true });
    });
  }
}

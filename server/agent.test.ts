import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFiles, parseAgentOutput, parseCliOutput, runCommand, sandboxProfile } from "./agent";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "booth-agent-test-"));
  temporary.push(path);
  return path;
}

describe("agent output boundary", () => {
  it("accepts source files and rejects traversal, duplicate and empty changes", () => {
    expect(
      parseAgentOutput({
        files: [{ path: "src/App.vue", content: "<template>hello</template>" }],
        message: "できた",
      }).files,
    ).toHaveLength(1);
    for (const path of [
      "../outside.ts",
      "src/../outside.ts",
      "/src/App.vue",
      "src/link/../../outside.ts",
      "src/.hidden.ts",
      "src/App.vue?x",
      "src/a\\b.ts",
      "src/package.json",
    ]) {
      expect(() => parseAgentOutput({ files: [{ path, content: "x" }], message: "x" })).toThrow();
    }
    expect(() => parseAgentOutput({ files: [], message: "nothing" })).toThrow();
    expect(() =>
      parseAgentOutput({
        files: [
          { path: "src/a.ts", content: "a" },
          { path: "src/a.ts", content: "b" },
        ],
        message: "x",
      }),
    ).toThrow();
  });

  it("rejects a symlink before writing any file", async () => {
    const app = await directory();
    const outside = await directory();
    await mkdir(join(app, "src"));
    await writeFile(join(outside, "secret.ts"), "untouched");
    await symlink(outside, join(app, "src/link"));
    const output = parseAgentOutput({
      files: [
        { path: "src/good.ts", content: "new" },
        { path: "src/link/secret.ts", content: "bad" },
      ],
      message: "x",
    });
    await expect(applyFiles(app, output.files)).rejects.toThrow(/symlink|シンボリック/);
    expect(await readFile(join(outside, "secret.ts"), "utf8")).toBe("untouched");
    await expect(readFile(join(app, "src/good.ts"))).rejects.toThrow();
  });
});

describe("bounded process runner", () => {
  it("collects actual stdout and rejects nonzero exit and output overflow", async () => {
    const cwd = await directory();
    expect(
      await runCommand({
        file: process.execPath,
        args: ["-e", "process.stdout.write('ok')"],
        cwd,
        signal: new AbortController().signal,
      }),
    ).toBe("ok");
    await expect(
      runCommand({
        file: process.execPath,
        args: ["-e", "process.exit(1)"],
        cwd,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    await expect(
      runCommand({
        file: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(10000))"],
        cwd,
        signal: new AbortController().signal,
        maxBytes: 100,
      }),
    ).rejects.toThrow(/大き/);
  });

  it("kills the process group when cancelled", async () => {
    const cwd = await directory();
    const signal = AbortSignal.timeout(60);
    await expect(
      runCommand({ file: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd, signal }),
    ).rejects.toThrow();
  });

  it("uses a deny-write deny-exec sandbox with only runtime and CLI exceptions", async () => {
    const runtime = await directory();
    const profile = sandboxProfile("/usr/local/bin/codex", runtime);
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain("(deny process-exec)");
    expect(profile).toContain('(allow process-exec (literal "/usr/local/bin/codex"))');
    expect(profile).toContain(
      `(allow file-write* (subpath ${JSON.stringify(await realpath(runtime))}))`,
    );
  });

  it.skipIf(process.platform !== "darwin")(
    "allows canonical runtime writes but denies outside writes",
    async () => {
      const runtime = await directory();
      const outside = await directory();
      const binary = await realpath("/usr/bin/touch");
      const args = ["-p", sandboxProfile(binary, runtime), binary];
      await runCommand({
        file: "/usr/bin/sandbox-exec",
        args: [...args, join(runtime, "allowed")],
        cwd: runtime,
        signal: new AbortController().signal,
      });
      expect(await readFile(join(runtime, "allowed"), "utf8")).toBe("");
      await expect(
        runCommand({
          file: "/usr/bin/sandbox-exec",
          args: [...args, join(outside, "denied")],
          cwd: runtime,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow();
      await expect(readFile(join(outside, "denied"))).rejects.toThrow();
    },
  );
});

it("requires successful provider completion, not just process exit zero", () => {
  const output = {
    files: [{ path: "src/App.vue", content: "<template>hi</template>" }],
    message: "完成",
  };
  expect(
    parseCliOutput("claude", JSON.stringify({ subtype: "success", structured_output: output })),
  ).toEqual(output);
  expect(() =>
    parseCliOutput(
      "claude",
      JSON.stringify({ subtype: "error", is_error: true, structured_output: output }),
    ),
  ).toThrow();
  const message = JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(output) },
  });
  expect(
    parseCliOutput("codex", message + "\n" + JSON.stringify({ type: "turn.completed" })),
  ).toEqual(output);
  expect(() => parseCliOutput("codex", message)).toThrow();
  expect(() =>
    parseCliOutput("codex", message + "\n" + JSON.stringify({ type: "turn.failed" })),
  ).toThrow();
});

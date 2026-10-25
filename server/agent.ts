import { spawn } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

export type Provider = "claude" | "codex";
export type AgentOutput = { files: { path: string; content: string }[]; message: string };
const maxBytes = 256 * 1024;
const sourcePath = /^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:vue|ts|css)$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAgentOutput(value: unknown): AgentOutput {
  if (
    !record(value) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > 20 ||
    typeof value.message !== "string" ||
    value.message.length > 500
  ) {
    throw new Error("AIの変更内容が正しくありません。");
  }
  const files: AgentOutput["files"] = [];
  let size = 0;
  for (const file of value.files) {
    if (
      !record(file) ||
      typeof file.path !== "string" ||
      !sourcePath.test(file.path) ||
      typeof file.content !== "string" ||
      !file.content.trim() ||
      files.some((item) => item.path === file.path)
    ) {
      throw new Error("AIはsrc内のVue・TypeScript・CSSだけを変更できます。");
    }
    size += Buffer.byteLength(file.content);
    if (size > maxBytes) throw new Error("AIの変更内容が大きすぎます。");
    files.push({ path: file.path, content: file.content });
  }
  return { files, message: value.message };
}

async function checkPath(appDir: string, path: string) {
  if (!sourcePath.test(path)) throw new Error("変更先が正しくありません。");
  let current = appDir;
  for (const part of path.split("/")) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("シンボリックリンクには変更を適用できません。");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}

export async function applyFiles(appDir: string, files: AgentOutput["files"]) {
  for (const file of files) await checkPath(appDir, file.path);
  for (const file of files) {
    const path = join(appDir, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, { flag: "w" });
  }
}

export async function readSource(appDir: string) {
  const files: AgentOutput["files"] = [];
  let size = 0;
  async function visit(path: string) {
    for (const entry of await readdir(join(appDir, path), { withFileTypes: true })) {
      const name = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("作業コピーにシンボリックリンクがあります。");
      if (entry.isDirectory()) await visit(name);
      else if (sourcePath.test(name)) {
        const content = await readFile(join(appDir, name), "utf8");
        size += Buffer.byteLength(content);
        if (size > maxBytes || files.length >= 40)
          throw new Error("アプリが大きすぎるためAIへ送信できません。");
        files.push({ path: name, content });
      }
    }
  }
  await visit("src");
  return files;
}

export function sandboxProfile(binary: string, runtime: string) {
  return `(version 1) (allow default) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(realpathSync(runtime))})) (allow file-write-data (literal "/dev/null")) (deny process-exec) (allow process-exec (literal ${JSON.stringify(binary)}))`;
}

export function runCommand(options: {
  file: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  input?: string;
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
  onProgress?: () => void;
}): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(options.file, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    function stop(error: Error) {
      failure ??= error;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (killError) {
          if (!(killError instanceof Error && "code" in killError && killError.code === "ESRCH"))
            failure = new Error("AIプロセスを停止できませんでした。");
        }
      }
    }
    const abort = () => stop(new Error("AIの実行を中止しました。"));
    options.signal.addEventListener("abort", abort, { once: true });
    const collect = (chunk: Buffer, output: boolean) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? maxBytes * 4)) stop(new Error("AIの出力が大きすぎます。"));
      else if (output) {
        stdout.push(chunk);
        options.onProgress?.();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.on("error", () => {
      failure ??= new Error("AIコマンドを起動できません。スタッフに確認してください。");
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      options.signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error("AIの実行に失敗しました。スタッフが認証と接続を確認してください。"));
      else resolveResult(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(options.input);
    if (options.signal.aborted) abort();
  });
}

async function executable(name: string) {
  for (const path of (process.env.PATH ?? "").split(delimiter)) {
    const file = resolve(path, name);
    try {
      await access(file, constants.X_OK);
      return await realpath(file);
    } catch {
      /* Continue searching PATH. */
    }
  }
  throw new Error(`${name}が見つかりません。スタッフがCLIをインストールしてください。`);
}

export function parseCliOutput(provider: Provider, text: string): AgentOutput {
  if (provider === "claude") {
    const result: unknown = JSON.parse(text);
    if (!record(result) || result.is_error === true || result.subtype !== "success")
      throw new Error("AIが変更を完了できませんでした。");
    return parseAgentOutput(result.structured_output);
  }
  let final: unknown;
  let completed = false;
  for (const line of text.split("\n").filter((line) => line.trim())) {
    const event: unknown = JSON.parse(line);
    if (!record(event)) throw new Error("AIの応答形式が正しくありません。");
    if (event.type === "turn.failed" || event.type === "error")
      throw new Error("AIが変更を完了できませんでした。");
    if (event.type === "turn.completed") completed = true;
    if (
      event.type === "item.completed" &&
      record(event.item) &&
      event.item.type === "agent_message" &&
      typeof event.item.text === "string"
    )
      final = JSON.parse(event.item.text);
  }
  if (!completed) throw new Error("AIが変更を完了できませんでした。");
  return parseAgentOutput(final);
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["files", "message"],
  properties: {
    message: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: { path: { type: "string" }, content: { type: "string" } },
      },
    },
  },
};

export async function runAgent(options: {
  provider: Provider;
  appDir: string;
  prompt: string;
  signal: AbortSignal;
  onProgress?: () => void;
}): Promise<AgentOutput> {
  if (process.platform !== "darwin")
    throw new Error("AIの安全な実行にはmacOSが必要です。カタログ機能はそのまま使えます。");
  await access("/usr/bin/sandbox-exec", constants.X_OK);
  const binary = await executable(options.provider);
  const runtime = await mkdtemp(join(tmpdir(), "booth-ai-"));
  try {
    const source = await readSource(options.appDir);
    const config = join(runtime, "config");
    await mkdir(config);
    const credential = options.provider === "codex" ? "auth.json" : ".credentials.json";
    const original =
      options.provider === "codex"
        ? (process.env.CODEX_HOME ?? join(homedir(), ".codex"))
        : (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
    let stored: string | undefined;
    if (
      options.provider === "claude" &&
      original === join(homedir(), ".claude") &&
      !process.env.ANTHROPIC_API_KEY &&
      !process.env.ANTHROPIC_AUTH_TOKEN
    ) {
      try {
        stored = await runCommand({
          file: "/usr/bin/security",
          args: ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
          cwd: runtime,
          signal: options.signal,
        });
      } catch {
        options.signal.throwIfAborted();
      }
    }
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (!record(parsed) || !record(parsed.claudeAiOauth))
        throw new Error("Claudeの認証を読み取れません。スタッフがログインを確認してください。");
      await writeFile(join(config, credential), stored, { mode: 0o600 });
    } else {
      try {
        await copyFile(join(original, credential), join(config, credential));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    const schemaPath = join(runtime, "schema.json");
    await writeFile(schemaPath, JSON.stringify(schema));
    const input = `あなたは中学生の勉強タスクアプリ制作を手伝います。アプリと無関係な依頼は拒否してください。ツール、シェル、ネット通信は使わないでください。提示されたsrcファイルだけを編集し、変更したファイルの全文をfilesに入れたJSONを返してください。空のfilesは拒否を意味します。既存の設定機能と@booth-sharedの参照を維持してください。messageには変更結果だけを参加者向けの短い日本語で書き、ファイル名やコードは書かないでください。新しい依存関係や外部URLは使えません。\n依頼: ${options.prompt}\n現在のファイル: ${JSON.stringify(source)}`;
    const args =
      options.provider === "claude"
        ? [
            "-p",
            "--output-format",
            "json",
            "--json-schema",
            JSON.stringify(schema),
            "--restricted",
            "--tools",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--setting-sources",
            "",
            "--disable-slash-commands",
            "--no-session-persistence",
            "--safe-mode",
            "--permission-mode",
            "dontAsk",
            "--permission-prompts",
            "none",
          ]
        : [
            "exec",
            "--json",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--output-schema",
            schemaPath,
            ...[
              "shell_tool",
              "hooks",
              "plugins",
              "apps",
              "multi_agent",
              "browser_use",
              "browser_use_external",
              "computer_use",
              "image_generation",
            ].flatMap((feature) => ["--disable", feature]),
            "-c",
            'web_search="disabled"',
            "-c",
            'approval_policy="never"',
            "-",
          ];
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: homedir(),
      LANG: process.env.LANG,
      TMPDIR: runtime,
      CODEX_HOME: config,
      CLAUDE_CONFIG_DIR: config,
    };
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"])
      if (process.env[key]) env[key] = process.env[key];
    const text = await runCommand({
      file: "/usr/bin/sandbox-exec",
      args: ["-p", sandboxProfile(binary, runtime), binary, ...args],
      cwd: runtime,
      env,
      input,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    return parseCliOutput(options.provider, text);
  } finally {
    await rm(runtime, { recursive: true, force: true });
  }
}

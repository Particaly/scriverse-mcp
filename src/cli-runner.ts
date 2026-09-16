import { spawn } from "node:child_process";

/** 一次 scriverse CLI 子进程调用的完整结果。 */
export type CliRunResult = {
  /** 子进程退出码；被信号杀死时可能为 null。 */
  code: number | null;
  /** 标准输出全文；超出捕获上限时会截断并置 outputTruncated。 */
  stdout: string;
  /** 标准错误全文。 */
  stderr: string;
  /** 是否因超时被强制终止。 */
  timedOut: boolean;
  /** 进程无法启动时的错误说明（例如入口文件不可执行）。 */
  spawnError?: string;
  /** 标准输出是否因超过捕获上限被截断。 */
  outputTruncated: boolean;
};

export type CliRunOptions = {
  /** scriverse CLI 的 JS 入口脚本绝对路径。 */
  cliEntryScript: string;
  /** 传给 CLI 的参数，不含 node 本身与入口脚本。 */
  args: string[];
  /** 子进程超时毫秒数，超时后强制结束进程；默认 120000。 */
  timeoutMs?: number;
  /** 通过标准输入传给 `--input -` 的 JSON 文本。 */
  stdinText?: string;
  /** 子进程环境变量；默认继承当前进程。 */
  env?: NodeJS.ProcessEnv;
};

/** 单次调用允许捕获的最大输出字节数，防止异常输出拖垮内存。 */
const MAXIMUM_CAPTURE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_CLI_TIMEOUT_MS = 120_000;

/**
 * 为 CLI 参数追加 --compact 标记，使成功与失败输出都是单行 JSON，便于解析。
 * 已包含 --compact 时不重复追加。
 */
export function withCompactFlag(args: string[]): string[] {
  return args.includes("--compact") ? args : [...args, "--compact"];
}

/**
 * 把 scriverse CLI 的标准错误输出转换为面向用户的单行错误说明。
 *
 * CLI 的错误输出固定为 {"error":{"code","message","details"}} 单行 JSON；
 * 无法按该结构解析时退回原始文本（截断到 500 字符）。
 */
export function formatCliErrorOutput(stderr: string): string {
  const text = stderr.trim();
  if (!text) return "CLI 未返回错误详情";
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: unknown; message?: unknown; details?: unknown };
    };
    const code = typeof parsed.error?.code === "string" ? parsed.error.code : "CLI_ERROR";
    const message = typeof parsed.error?.message === "string" ? parsed.error.message : text;
    const details = parsed.error?.details === undefined ? "" : `；详情：${JSON.stringify(parsed.error.details)}`;
    return `[${code}] ${message}${details}`;
  } catch {
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  }
}

/**
 * 以子进程方式执行一次 scriverse CLI 命令并收集输出。
 *
 * 永远不抛异常：启动失败、超时都通过返回值中的 spawnError / timedOut 表达，
 * 便于上层统一转换为 MCP 工具错误结果。
 */
export function runScriverseCli(options: CliRunOptions): Promise<CliRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const args = withCompactFlag(options.args);
  return new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let timedOut = false;
    let outputTruncated = false;
    let settled = false;

    const child = spawn(process.execPath, [options.cliEntryScript, ...args], {
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const appendText = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (target === "stdout") {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAXIMUM_CAPTURE_BYTES) {
          outputTruncated = true;
          return;
        }
        stdout += chunk.toString("utf8");
        return;
      }
      if (stderr.length < MAXIMUM_CAPTURE_BYTES) {
        stderr += chunk.toString("utf8");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => appendText("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => appendText("stderr", chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const finish = (code: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut, outputTruncated, ...(spawnError === undefined ? {} : { spawnError }) });
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(null, error.message);
    });
    child.on("close", (code) => {
      finish(code);
    });

    if (options.stdinText !== undefined) {
      // 子进程提前退出时写入 stdin 可能触发 EPIPE，此时结果已由 close/error 表达。
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdinText, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

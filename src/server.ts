import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_CLI_TIMEOUT_MS, formatCliErrorOutput, runScriverseCli, type CliRunResult } from "./cli-runner.js";
import { defineCliTools, type CliToolDefinition } from "./cli-tools.js";
import { PACKAGE_VERSION } from "./version.js";

/** 交给模型的单条文本内容默认最大字符数，超出部分截断并说明原因。 */
const DEFAULT_MAX_OUTPUT_CHARS = 200_000;

export type ScriverseMcpServerOptions = {
  /** scriverse CLI 的 JS 入口脚本绝对路径。 */
  cliEntryScript: string;
  /** 单次 CLI 调用超时毫秒数；默认 120000。 */
  timeoutMs?: number;
  /** 追加到每条命令的 --config 路径，用于环境变量自动登录的临时配置文件。 */
  configPath?: string;
  /** 传给子进程的环境变量；默认继承当前进程。 */
  env?: NodeJS.ProcessEnv;
  /** 单条工具结果文本最大字符数；默认 200000。 */
  maxOutputChars?: number;
};

function truncateText(text: string, maxChars: number, reason: string): string {
  if (text.length <= maxChars) return text;
  const note = reason ? `（${reason}）` : "";
  return `${text.slice(0, maxChars)}\n…[内容已截断，原始长度 ${text.length} 字符${note}]`;
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * 把一次 CLI 子进程运行结果转换为 MCP 工具结果。
 *
 * 退出码非零、超时、启动失败都转为 isError 结果；成功时透传 CLI 输出，
 * 并在存在标准错误告警（例如 HTTP 明文传输提醒）时附加到结果末尾。
 */
export function cliRunToToolResult(run: CliRunResult, maxOutputChars: number): CallToolResult {
  if (run.spawnError) {
    return errorResult(`无法启动 scriverse CLI：${run.spawnError}`);
  }
  if (run.timedOut) {
    return errorResult("scriverse CLI 调用超时被强制终止；可重试，或缩小查询范围/改用文件导出");
  }
  if (run.code !== 0) {
    return errorResult(`scriverse CLI 调用失败（退出码 ${run.code ?? "unknown"}）：${formatCliErrorOutput(run.stderr)}`);
  }
  let text = run.stdout;
  if (run.outputTruncated) {
    text += "\n…[CLI 输出超过捕获上限，已截断]";
  }
  text = truncateText(text, maxOutputChars, "如需完整内容请缩小查询范围，或对正文使用 outputPath 文件导出");
  const stderrNote = run.stderr.trim();
  if (stderrNote) {
    text += `\n[CLI 警告] ${truncateText(stderrNote, 2_000, "")}`;
  }
  return { content: [{ type: "text", text }] };
}

/**
 * 创建并装配 scriverse-mcp 的 McpServer：注册全部 CLI 工具，附加使用说明。
 *
 * 工具回调流程：Zod 校验后的参数 -> buildArgs 组装 argv -> 子进程执行 CLI ->
 * 结果转换为文本内容。--input 类命令通过标准输入传递 JSON 请求体。
 */
export function createScriverseMcpServer(options: ScriverseMcpServerOptions): { server: McpServer } {
  const server = new McpServer(
    { name: "scriverse-mcp", version: PACKAGE_VERSION },
    {
      instructions: [
        "这是 Scriverse（本地长篇小说 AI 工作台）的 CLI 代理 MCP Server，所有工具都作用于已登录的远程 Scriverse 服务。",
        "工具与 scriverse CLI 子命令一一对应；执行任何写操作（create/update/restore/answer/delete）前，",
        "先用 scriverse_schema 查看对应资源的字段规范与示例；写操作会生成版本历史，可用 history 查询、restore 回滚。",
        "用户管理、作品成员管理、系统管理、AI 供应商管理、永久删除等操作不在 CLI 契约内，本 Server 也不提供。"
      ].join("")
    }
  );

  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const tools: CliToolDefinition[] = defineCliTools();
  for (const tool of tools) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema
    }, async (args) => {
      let cliArgs: string[];
      try {
        cliArgs = tool.buildArgs(args as Record<string, unknown>);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "工具参数无效");
      }
      if (options.configPath) {
        cliArgs = [...cliArgs, "--config", options.configPath];
      }
      const stdinText = cliArgs.includes("--input")
        ? JSON.stringify((args as Record<string, unknown>).input ?? {})
        : undefined;
      const run = await runScriverseCli({
        cliEntryScript: options.cliEntryScript,
        args: cliArgs,
        timeoutMs: options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
        ...(stdinText === undefined ? {} : { stdinText }),
        ...(options.env === undefined ? {} : { env: options.env })
      });
      return cliRunToToolResult(run, maxOutputChars);
    });
  }
  return { server };
}

#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveCliEntryScript } from "./cli-bin.js";
import { createScriverseMcpServer } from "./server.js";
import { loginWithEnvironment, removeTemporaryConfig, resolveLoginConfigPath } from "./entry-support.js";
import { existsSync } from "node:fs";
import { PACKAGE_VERSION } from "./version.js";

/** 向标准错误写一行日志（stdio 传输下标准错误是唯一的日志通道）。 */
function log(message: string): void {
  process.stderr.write(`scriverse-mcp: ${message}\n`);
}

/** 输出致命错误说明并以非零状态码退出。 */
function fail(message: string): never {
  process.stderr.write(`scriverse-mcp: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const env = process.env;
  let cliEntryScript: string;
  try {
    cliEntryScript = resolveCliEntryScript(env);
  } catch (error) {
    fail(error instanceof Error ? error.message : "无法定位 scriverse CLI 入口");
  }

  let temporaryConfigPath: string | undefined;
  try {
    temporaryConfigPath = await loginWithEnvironment(cliEntryScript, env);
  } catch (error) {
    fail(error instanceof Error ? error.message : "环境变量自动登录失败");
  }
  process.on("exit", () => removeTemporaryConfig(temporaryConfigPath));
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  if (!temporaryConfigPath && !existsSync(resolveLoginConfigPath(env))) {
    log(
      "未找到 CLI 登录配置；请先执行 npx scriverse auth login，或在 MCP 配置中同时提供 SCRIVERSE_SERVER 与 SCRIVERSE_API_KEY 环境变量。在此之前工具调用将返回登录错误。"
    );
  }

  const rawTimeout = Number(env.SCRIVERSE_MCP_TIMEOUT_MS);
  const timeoutMs = Number.isInteger(rawTimeout) && rawTimeout > 0 ? rawTimeout : undefined;
  const { server } = createScriverseMcpServer({
    cliEntryScript,
    ...(temporaryConfigPath === undefined ? {} : { configPath: temporaryConfigPath }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
  await server.connect(new StdioServerTransport());
  log(`version ${PACKAGE_VERSION} listening on stdio (cli: ${cliEntryScript})`);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : "启动时发生未知错误");
});

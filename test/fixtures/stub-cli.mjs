#!/usr/bin/env node
// 测试桩：模拟 scriverse CLI 的最小行为，仅用于 scriverse-mcp 的自动化测试。
// 通过 SCRIVERSE_CLI_PATH 指向本文件即可让 MCP Server 在测试中调用桩而非真实 CLI。
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const positional = [];
const options = new Map();
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--compact") continue;
  if (argument.startsWith("--")) {
    options.set(argument.slice(2), args[index + 1]);
    index += 1;
  } else {
    positional.push(argument);
  }
}

const fail = (code, message) => {
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exit(1);
};

const [group, action] = positional;

if (group === "auth" && action === "login") {
  const apiKey = options.get("api-key");
  const configPath = options.get("config");
  if (!apiKey || !configPath) fail("CLI_OPTION_VALUE_REQUIRED", "缺少 api-key 或 config");
  if (apiKey === "bad-key") fail("API_KEY_INVALID", "API Key 无效或已失效");
  writeFileSync(
    configPath,
    `${JSON.stringify({ version: 2, defaultServer: options.get("server") ?? null, servers: {} })}\n`,
    { mode: 0o600 }
  );
  process.stdout.write(`${JSON.stringify({ authenticated: true })}\n`);
  process.exit(0);
}

if (group === "work" && action === "list") {
  process.stderr.write(`${JSON.stringify({ warning: { code: "CLI_SERVER_HTTP_WARNING", message: "HTTP 明文提醒" } })}\n`);
  process.stdout.write(`${JSON.stringify({ works: [{ id: "work_1", title: "潮汐尽头" }] })}\n`);
  process.exit(0);
}

if (group === "work" && action === "get") {
  const workId = positional[2];
  if (workId === "work_fail") fail("WORK_NOT_FOUND", "作品不存在");
  process.stdout.write(`${JSON.stringify({ id: workId, title: "潮汐尽头" })}\n`);
  process.exit(0);
}

if (group === "manuscript" && action === "get") {
  const format = options.get("format") ?? "json";
  if (format === "txt") {
    process.stdout.write("第一章 抵达\n黎明时，林舟抵达北港。\n");
    process.exit(0);
  }
  if (format === "docx" || format === "epub") {
    const output = options.get("output");
    if (!output) fail("CLI_OUTPUT_REQUIRED", `${format} 必须提供输出路径`);
    process.stdout.write(`${JSON.stringify({ format, outputPath: output, bytes: 123 })}\n`);
    process.exit(0);
  }
  process.stdout.write(`${JSON.stringify({ id: positional[2], format })}\n`);
  process.exit(0);
}

if (group === "resource" && (action === "update" || action === "create")) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    fail("CLI_INPUT_INVALID", "输入不是有效 JSON");
  }
  process.stdout.write(`${JSON.stringify({ argv: args, received: input })}\n`);
  process.exit(0);
}

if (group === "schema") {
  process.stdout.write(`${JSON.stringify({ output: "contract" })}\n`);
  process.exit(0);
}

if (group === "slow") {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  process.stdout.write("done\n");
  process.exit(0);
}

fail("CLI_COMMAND_UNKNOWN", `未知命令：${args.join(" ")}`);

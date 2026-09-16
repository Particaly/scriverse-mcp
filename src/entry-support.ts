import { rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { formatCliErrorOutput, runScriverseCli } from "./cli-runner.js";

/**
 * 解析默认 CLI 登录配置文件路径，逻辑与 scriverse CLI 保持一致：
 * 优先 SCRIVERSE_CONFIG，其次 XDG_CONFIG_HOME，最后 ~/.config/scriverse/cli.json。
 */
export function resolveLoginConfigPath(env: NodeJS.ProcessEnv): string {
  const configured = env.SCRIVERSE_CONFIG?.trim();
  if (configured) return configured;
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "scriverse", "cli.json");
}

/**
 * 环境变量自动登录：SCRIVERSE_SERVER 与 SCRIVERSE_API_KEY 同时提供时，
 * 调用一次 `scriverse auth login` 生成临时配置文件（由 CLI 以 0600 权限写入），
 * 返回该路径供后续所有工具调用通过 --config 使用。
 *
 * 只提供其中一个环境变量、登录失败时抛出带中文说明的错误。
 * 未提供环境变量时返回 undefined，走 CLI 自身的登录配置。
 */
export async function loginWithEnvironment(
  cliEntryScript: string,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const serverUrl = env.SCRIVERSE_SERVER?.trim();
  const apiKey = env.SCRIVERSE_API_KEY?.trim();
  if (Boolean(serverUrl) !== Boolean(apiKey)) {
    throw new Error("环境变量 SCRIVERSE_SERVER 与 SCRIVERSE_API_KEY 必须同时提供，或同时省略");
  }
  if (!serverUrl || !apiKey) return undefined;
  const temporaryConfigPath = join(tmpdir(), `scriverse-mcp-config-${process.pid}-${Date.now()}.json`);
  // CLI 的 auth login 只允许一种 Key 来源，需从子进程环境中移除 SCRIVERSE_API_KEY。
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv.SCRIVERSE_API_KEY;
  const run = await runScriverseCli({
    cliEntryScript,
    args: ["auth", "login", "--server", serverUrl, "--api-key", apiKey, "--config", temporaryConfigPath],
    env: childEnv,
    timeoutMs: 30_000
  });
  if (run.timedOut || run.code !== 0) {
    throw new Error(`使用 SCRIVERSE_SERVER/SCRIVERSE_API_KEY 自动登录失败：${formatCliErrorOutput(run.stderr)}`);
  }
  return temporaryConfigPath;
}

/**
 * 删除环境变量登录产生的临时配置文件；删除失败静默忽略，
 * 临时目录由操作系统兜底回收。
 */
export function removeTemporaryConfig(path: string | undefined): void {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // 进程退出阶段的清理失败不影响主流程。
  }
}

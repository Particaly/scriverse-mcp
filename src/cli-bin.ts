import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * 解析 scriverse CLI 的入口脚本绝对路径。
 *
 * 优先级：
 * 1. 环境变量 SCRIVERSE_CLI_PATH 指定的入口文件（便于测试或使用自定义构建）。
 * 2. 当前包依赖 @musnows/scriverse 的 package.json 中 bin.scriverse 指向的文件。
 *
 * 返回的是 JS 入口文件路径，由调用方用 `process.execPath` 直接执行，避免依赖
 * npm 在 Windows 上生成的 .cmd 垫片。
 */
export function resolveCliEntryScript(env: NodeJS.ProcessEnv): string {
  const override = env.SCRIVERSE_CLI_PATH?.trim();
  if (override) {
    const resolved = isAbsolute(override) ? override : resolve(override);
    if (!existsSync(resolved)) {
      throw new Error(`环境变量 SCRIVERSE_CLI_PATH 指向的文件不存在：${resolved}`);
    }
    return resolved;
  }
  const require = createRequire(import.meta.url);
  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve("@musnows/scriverse/package.json");
  } catch {
    throw new Error("未找到依赖包 @musnows/scriverse，请先执行 npm install 安装依赖");
  }
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const binField = manifest.bin;
  const relativeEntry = typeof binField === "string" ? binField : binField?.scriverse;
  if (!relativeEntry) {
    throw new Error(`依赖包 @musnows/scriverse 的 package.json 缺少 bin.scriverse 字段：${packageJsonPath}`);
  }
  const entryPath = join(dirname(packageJsonPath), relativeEntry);
  if (!existsSync(entryPath)) {
    throw new Error(`依赖包 @musnows/scriverse 缺少 CLI 入口文件：${entryPath}，请重新安装依赖`);
  }
  return entryPath;
}

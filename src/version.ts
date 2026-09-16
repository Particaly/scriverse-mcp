import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 读取本包 package.json 中的版本号，用于 MCP Server 握手信息。
 * 通过相对 import.meta.url 定位，源码与构建产物下均指向项目根目录的 package.json。
 */
export const PACKAGE_VERSION: string = (() => {
  const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  return typeof manifest.version === "string" ? manifest.version : "0.0.0";
})();

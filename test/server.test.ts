import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createScriverseMcpServer } from "../src/server.js";
import { defineCliTools } from "../src/cli-tools.js";
import { resolveCliEntryScript } from "../src/cli-bin.js";
import { loginWithEnvironment, removeTemporaryConfig, resolveLoginConfigPath } from "../src/entry-support.js";

const stubCli = fileURLToPath(new URL("./fixtures/stub-cli.mjs", import.meta.url));

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function connectStubServer() {
  const { server } = createScriverseMcpServer({ cliEntryScript: stubCli, timeoutMs: 10_000 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<TextResult> {
  return await client.callTool({ name, arguments: args }) as unknown as TextResult;
}

describe("scriverse-mcp server", () => {
  it("注册全部 CLI 工具且名称以 scriverse_ 开头", async () => {
    const { client, server } = await connectStubServer();
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((item) => item.name).sort();
      const expected = defineCliTools().map((item) => item.name).sort();
      expect(names).toEqual(expected);
      expect(names.length).toBe(11);
      for (const name of names) {
        expect(name.startsWith("scriverse_")).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("work list 返回 CLI JSON 并附加 CLI 警告", async () => {
    const { client, server } = await connectStubServer();
    try {
      const result = await callText(client, "scriverse_work", { action: "list" });
      expect(result.isError).toBeFalsy();
      const text = result.content[0]?.text ?? "";
      expect(text).toContain("潮汐尽头");
      expect(text).toContain("[CLI 警告]");
      expect(JSON.parse(text.split("\n[CLI 警告]")[0] ?? "{}")).toEqual({
        works: [{ id: "work_1", title: "潮汐尽头" }]
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("manuscript txt 纯文本直接透传", async () => {
    const { client, server } = await connectStubServer();
    try {
      const result = await callText(client, "scriverse_manuscript", { workId: "work_1", format: "txt" });
      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toContain("黎明时，林舟抵达北港。");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("resource update 通过 stdin 传递 JSON 请求体", async () => {
    const { client, server } = await connectStubServer();
    try {
      const result = await callText(client, "scriverse_resource", {
        type: "character",
        action: "update",
        id: "char_1",
        changeNote: "同步第三章结尾状态",
        input: { currentState: { location: "北港议会" } }
      });
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
        argv: string[];
        received: Record<string, unknown>;
      };
      expect(payload.received).toEqual({ currentState: { location: "北港议会" } });
      expect(payload.argv).toEqual(expect.arrayContaining(["--change-note", "同步第三章结尾状态"]));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("CLI 非零退出映射为 isError 并带错误码", async () => {
    const { client, server } = await connectStubServer();
    try {
      const result = await callText(client, "scriverse_work", { action: "get", workId: "work_fail" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("[WORK_NOT_FOUND]");
      expect(result.content[0]?.text).toContain("作品不存在");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("缺少必填参数时返回参数错误", async () => {
    const { client, server } = await connectStubServer();
    try {
      const result = await callText(client, "scriverse_work", { action: "get" });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("workId");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("entry-support", () => {
  it("resolveLoginConfigPath 与 CLI 逻辑一致", () => {
    expect(resolveLoginConfigPath({ SCRIVERSE_CONFIG: "D:/cfg/cli.json" })).toBe("D:/cfg/cli.json");
    expect(resolveLoginConfigPath({})).toContain(join("scriverse", "cli.json"));
  });

  it("SCRIVERSE_SERVER 与 SCRIVERSE_API_KEY 必须成对出现", async () => {
    await expect(loginWithEnvironment(stubCli, { SCRIVERSE_SERVER: "http://127.0.0.1:13210" }))
      .rejects.toThrow(/同时提供/);
  });

  it("环境变量登录成功时生成临时配置文件", async () => {
    const temporary = await loginWithEnvironment(stubCli, {
      SCRIVERSE_SERVER: "http://127.0.0.1:13210",
      SCRIVERSE_API_KEY: "scrv_test"
    });
    expect(temporary).toBeDefined();
    try {
      expect(existsSync(temporary!)).toBe(true);
      const config = JSON.parse(readFileSync(temporary!, "utf8")) as { defaultServer: string | null };
      expect(config.defaultServer).toBe("http://127.0.0.1:13210");
    } finally {
      removeTemporaryConfig(temporary);
    }
    expect(existsSync(temporary!)).toBe(false);
  });

  it("登录失败时抛出带错误码的异常", async () => {
    await expect(loginWithEnvironment(stubCli, {
      SCRIVERSE_SERVER: "http://127.0.0.1:13210",
      SCRIVERSE_API_KEY: "bad-key"
    })).rejects.toThrow(/API_KEY_INVALID/);
  });

  it("removeTemporaryConfig 对 undefined 安全", () => {
    expect(() => removeTemporaryConfig(undefined)).not.toThrow();
  });
});

describe("resolveCliEntryScript", () => {
  it("依赖包缺省时定位到 @musnows/scriverse 的 CLI 入口", () => {
    const entry = resolveCliEntryScript({});
    expect(entry).toContain(join("@musnows", "scriverse"));
    expect(existsSync(entry)).toBe(true);
  });

  it("SCRIVERSE_CLI_PATH 指向不存在文件时报错", () => {
    expect(() => resolveCliEntryScript({ SCRIVERSE_CLI_PATH: "Z:/not-exists/cli.js" })).toThrow(/不存在/);
  });
});

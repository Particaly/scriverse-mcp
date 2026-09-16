import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { withCompactFlag, runScriverseCli, formatCliErrorOutput } from "../src/cli-runner.js";
import { defineCliTools } from "../src/cli-tools.js";

const stubCli = fileURLToPath(new URL("./fixtures/stub-cli.mjs", import.meta.url));

function tool(name: string) {
  const found = defineCliTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`工具未定义：${name}`);
  return found;
}

describe("withCompactFlag", () => {
  it("为参数追加 --compact 标记且不重复追加", () => {
    expect(withCompactFlag(["work", "list"])).toEqual(["work", "list", "--compact"]);
    expect(withCompactFlag(["work", "list", "--compact"])).toEqual(["work", "list", "--compact"]);
  });
});

describe("formatCliErrorOutput", () => {
  it("解析 CLI 标准错误 JSON 并拼出代码与信息", () => {
    const stderr = `${JSON.stringify({ error: { code: "WORK_NOT_FOUND", message: "作品不存在" } })}\n`;
    expect(formatCliErrorOutput(stderr)).toBe("[WORK_NOT_FOUND] 作品不存在");
  });

  it("带 details 时输出 JSON 详情", () => {
    const stderr = JSON.stringify({ error: { code: "X", message: "m", details: { id: 1 } } });
    expect(formatCliErrorOutput(stderr)).toBe('[X] m；详情：{"id":1}');
  });

  it("非 JSON 输出退回原始文本", () => {
    expect(formatCliErrorOutput("boom")).toBe("boom");
    expect(formatCliErrorOutput("")).toBe("CLI 未返回错误详情");
  });
});

describe("buildArgs", () => {
  it("schema list 与 show", () => {
    expect(tool("scriverse_schema").buildArgs({ action: "list" })).toEqual(["schema", "list"]);
    expect(tool("scriverse_schema").buildArgs({ action: "show", type: "character" }))
      .toEqual(["schema", "show", "character"]);
    expect(() => tool("scriverse_schema").buildArgs({ action: "show" })).toThrow(/type/);
  });

  it("work 各动作", () => {
    const work = tool("scriverse_work");
    expect(work.buildArgs({ action: "list" })).toEqual(["work", "list"]);
    expect(work.buildArgs({ action: "create" })).toEqual(["work", "create", "--input", "-"]);
    expect(work.buildArgs({ action: "get", workId: "work_1" })).toEqual(["work", "get", "work_1"]);
    expect(work.buildArgs({ action: "update", workId: "work_1" })).toEqual(["work", "update", "work_1", "--input", "-"]);
    expect(work.buildArgs({ action: "history", workId: "work_1" })).toEqual(["work", "history", "work_1"]);
    expect(work.buildArgs({ action: "restore", workId: "work_1", version: 3, expectedVersionNo: 7 }))
      .toEqual(["work", "restore", "work_1", "--version", "3", "--expected-version", "7"]);
    expect(() => work.buildArgs({ action: "restore", workId: "work_1" })).toThrow(/version/);
    expect(() => work.buildArgs({ action: "get" })).toThrow(/workId/);
  });

  it("resource 更新携带 change-note", () => {
    const resource = tool("scriverse_resource");
    expect(resource.buildArgs({ type: "character", action: "list", id: "work_1" }))
      .toEqual(["resource", "list", "character", "work_1"]);
    expect(resource.buildArgs({
      type: "chapter", action: "update", id: "chapter_1", changeNote: "增强开场危机感"
    })).toEqual(["resource", "update", "chapter", "chapter_1", "--input", "-", "--change-note", "增强开场危机感"]);
    expect(resource.buildArgs({ type: "chapter-outline", action: "create", id: "chapter_1" }))
      .toEqual(["resource", "create", "chapter-outline", "chapter_1", "--input", "-"]);
  });

  it("manuscript 二进制格式必须提供 outputPath", () => {
    const manuscript = tool("scriverse_manuscript");
    expect(manuscript.buildArgs({ workId: "work_1", format: "txt", outputPath: "D:/out/novel.txt" }))
      .toEqual(["manuscript", "get", "work_1", "--format", "txt", "--output", "D:/out/novel.txt"]);
    expect(() => manuscript.buildArgs({ workId: "work_1", format: "docx" })).toThrow(/outputPath/);
  });

  it("search 组合可选过滤", () => {
    expect(tool("scriverse_search").buildArgs({ workId: "work_1", query: "北港", limit: 20 }))
      .toEqual(["search", "work_1", "--query", "北港", "--limit", "20"]);
  });

  it("writing goal 必须提供 input", () => {
    const writing = tool("scriverse_writing");
    expect(writing.buildArgs({ action: "progress", workId: "work_1" }))
      .toEqual(["writing", "progress", "work_1"]);
    expect(() => writing.buildArgs({ action: "goal", workId: "work_1" })).toThrow(/input/);
  });

  it("chapter 与 annotation 的 id 语义", () => {
    expect(tool("scriverse_chapter").buildArgs({ action: "batch", id: "work_1", input: {} }))
      .toEqual(["chapter", "batch", "work_1", "--input", "-"]);
    expect(tool("scriverse_annotation").buildArgs({ action: "delete", id: "note_1", expectedVersionNo: 2 }))
      .toEqual(["annotation", "delete", "note_1", "--expected-version", "2"]);
  });

  it("ai questions 各动作", () => {
    const questions = tool("scriverse_ai_questions");
    expect(questions.buildArgs({ action: "list", workId: "work_1", status: "pending", limit: 5 }))
      .toEqual(["ai", "questions", "list", "work_1", "--status", "pending", "--limit", "5"]);
    expect(questions.buildArgs({ action: "reject", workId: "work_1", questionId: "q_1" }))
      .toEqual(["ai", "questions", "reject", "work_1", "q_1"]);
    expect(() => questions.buildArgs({ action: "answer", workId: "work_1", questionId: "q_1" })).toThrow(/input/);
  });
});

describe("runScriverseCli", () => {
  it("透传 stdin 并收集 JSON 输出", async () => {
    const run = await runScriverseCli({
      cliEntryScript: stubCli,
      args: ["resource", "update", "character", "char_1", "--input", "-"],
      stdinText: JSON.stringify({ currentState: { location: "北港" } }),
      timeoutMs: 10_000
    });
    expect(run.code).toBe(0);
    expect(run.timedOut).toBe(false);
    const payload = JSON.parse(run.stdout.trim()) as { argv: string[]; received: Record<string, unknown> };
    expect(payload.received).toEqual({ currentState: { location: "北港" } });
    expect(payload.argv).toContain("--compact");
  });

  it("超时强制结束子进程并标记 timedOut", async () => {
    const run = await runScriverseCli({
      cliEntryScript: stubCli,
      args: ["slow"],
      timeoutMs: 300
    });
    expect(run.timedOut).toBe(true);
    expect(run.stdout).not.toContain("done");
  }, 10_000);
});

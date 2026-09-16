import { z } from "zod";
import {
  RESOURCE_TYPES,
  aiAnswerSchema,
  annotationCreateSchema,
  annotationUpdateSchema,
  chapterBatchSchema,
  chapterMoveSchema,
  compactFieldSummary,
  describeResourceQuickReference,
  resourceCreateSchemas,
  resourceUpdateSchemas,
  validateJsonInput,
  workCreateSchema,
  workUpdateSchema,
  writingGoalSchema,
  type ResourceType
} from "./backend-schemas.js";

/**
 * 一个 MCP 工具的完整定义：名称、说明、Zod 输入规范和把输入转换为
 * scriverse CLI argv 的纯函数。
 *
 * buildArgs 做参数组合校验、写操作 input 的字段规范校验（与 Scriverse
 * 服务端 schema 一致，冗余/未知字段直接拒绝）与 argv 映射，抛出的错误会
 * 原样转成 MCP 工具错误结果；权限、版本号等业务校验仍由 CLI 与服务端完成。
 */
export type CliToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  buildArgs: (args: Record<string, unknown>) => string[];
};

function requireText(args: Record<string, unknown>, field: string, label: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`缺少必填参数 ${field}（${label}）`);
  }
  return value;
}

function optionalText(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalNumber(args: Record<string, unknown>, field: string): number | undefined {
  const value = args[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalInput(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = args.input;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** 需要 JSON 请求体的动作要求调用方提供 input 对象。 */
function requireInput(args: Record<string, unknown>): Record<string, unknown> {
  const input = optionalInput(args);
  if (!input) {
    throw new Error("当前动作需要提供 input 对象（JSON 请求体）");
  }
  return input;
}

function flag(name: string, value: string | number): string[] {
  return [`--${name}`, String(value)];
}

const workActionSchema = z.enum(["list", "get", "create", "update", "history", "restore"]);

const resourceActionSchema = z.enum(["list", "get", "create", "update", "history", "restore"]);

const workIdSchema = z.string().min(1).max(200).describe("作品 ID，通常以 work_ 开头");

const jsonInputSchema = z.record(z.string(), z.unknown())
  .describe("JSON 请求体；字段规范先用 scriverse_schema 查询对应资源类型。写入时会按服务端字段规范做 strict 校验：未知/冗余字段会被直接拒绝，不会提交");

const versionSchema = z.number().int().positive().describe("要恢复到的历史版本号");

const expectedVersionSchema = z.number().int().positive()
  .describe("可选乐观锁：当前最新版本号，不匹配时服务端拒绝写入");

/**
 * 全部 MCP 工具定义。
 *
 * 工具与 scriverse CLI 子命令一一对应；serve、connect、auth 等本地配置类命令
 * 不作为工具暴露，认证通过 `scriverse auth login` 或环境变量在启动前完成。
 */
export function defineCliTools(): CliToolDefinition[] {
  return [
    {
      name: "scriverse_schema",
      title: "查看 Scriverse CLI 契约",
      description: [
        "查看 Scriverse CLI 的资源类型、字段说明、请求示例和禁止操作。",
        "在执行任何 create/update/restore 写操作之前，应先用本工具确认字段规范。",
        "action=list 返回整体契约概览；action=show 需要提供 type 返回单个资源类型的详细规范。"
      ].join("")
      ,
      inputSchema: {
        action: z.enum(["list", "show"]).describe("list：整体契约概览；show：单个资源类型详情"),
        type: z.string().min(1).max(64).optional()
          .describe(`action=show 时的资源类型：work 或 ${RESOURCE_TYPES.join(" / ")}`)
      },
      buildArgs: (args) => {
        if (args.action === "show") {
          return ["schema", "show", requireText(args, "type", "资源类型")];
        }
        return ["schema", "list"];
      }
    },
    {
      name: "scriverse_work",
      title: "作品管理",
      description: [
        "管理 Scriverse 作品元数据：list 列出作品，get 读取作品详情，",
        "create/update 创建或更新作品元数据（会生成版本历史），",
        "history 查看作品版本历史，restore 恢复到指定版本。"
      ].join(""),
      inputSchema: {
        action: workActionSchema.describe("作品操作类型"),
        workId: workIdSchema.optional().describe("作品 ID；除 list、create 外必填"),
        input: jsonInputSchema.optional()
          .describe(`create/update 请求体字段：${compactFieldSummary(workCreateSchema)}。update 时字段均可选，changeNote 与 expectedVersionNo 只能放 input 内。* 为必填；冗余字段会被拒绝`),
        version: versionSchema.optional().describe("action=restore 时必填"),
        expectedVersionNo: expectedVersionSchema.optional()
      },
      buildArgs: (args) => {
        const action = requireText(args, "action", "作品操作");
        if (action === "list") return ["work", "list"];
        if (action === "create") {
          validateJsonInput(workCreateSchema, requireInput(args), "work create");
          return ["work", "create", "--input", "-"];
        }
        const workId = requireText(args, "workId", "作品 ID");
        if (action === "get") return ["work", "get", workId];
        if (action === "update") {
          validateJsonInput(workUpdateSchema, requireInput(args), "work update");
          return ["work", "update", workId, "--input", "-"];
        }
        if (action === "history") return ["work", "history", workId];
        if (action === "restore") {
          const version = optionalNumber(args, "version");
          if (version === undefined) throw new Error("action=restore 时必须提供 version（正整数版本号）");
          const expected = optionalNumber(args, "expectedVersionNo");
          return [
            "work", "restore", workId,
            ...flag("version", version),
            ...(expected === undefined ? [] : flag("expected-version", expected))
          ];
        }
        throw new Error(`不支持的作品操作：${action}`);
      }
    },
    {
      name: "scriverse_resource",
      title: "设定库资源管理",
      description: [
        "管理单部作品下的可版本化资源（设定库）：分卷、章节、想法、世界观设定、人物、种族、组织、",
        "时间轴、时间线事件、人物关系、伏笔、章节大纲。",
        "list 时 id 是作品 ID（章节大纲用章节 ID 也可，见 schema）；get/update/history/restore 时 id 是资源 ID；",
        "create 时 id 是归属 ID（多数资源为作品 ID，chapter-outline 为章节 ID）。",
        "update 支持可选 changeNote 写入版本说明（volume 不支持）；写操作前建议先用 scriverse_schema 确认字段。",
        "create/update 的 input 会按服务端字段规范做 strict 校验：未知/冗余字段会被直接拒绝（例如人物扩展属性请写 attributes.details 的 {label, value} 结构）。",
        "",
        describeResourceQuickReference()
      ].join("\n"),
      inputSchema: {
        type: z.enum(RESOURCE_TYPES).describe("资源类型"),
        action: resourceActionSchema.describe("资源操作类型"),
        id: z.string().min(1).max(200).optional().describe("按 action 而定的 ID：作品 ID / 章节 ID / 资源 ID"),
        input: jsonInputSchema.optional()
          .describe("create/update 的 JSON 请求体；写入前按服务端字段规范做 strict 校验，未知/冗余字段会被直接拒绝。各类型必填字段见工具描述末尾速查，完整逐字段格式用 scriverse_schema action=show type=<类型> 获取"),
        changeNote: z.string().max(500).optional()
          .describe("可选版本说明，最多 500 字；仅 update 支持，volume 不支持"),
        version: versionSchema.optional().describe("action=restore 时必填"),
        expectedVersionNo: expectedVersionSchema.optional()
      },
      buildArgs: (args) => {
        const type = requireText(args, "type", "资源类型");
        const action = requireText(args, "action", "资源操作");
        if (action === "list") {
          return ["resource", "list", type, requireText(args, "id", "作品 ID")];
        }
        if (action === "create") {
          const schema = resourceCreateSchemas[type as ResourceType];
          if (!schema) throw new Error(`不支持的资源类型：${type}`);
          validateJsonInput(schema, requireInput(args), `${type} create`);
          return ["resource", "create", type, requireText(args, "id", "归属 ID"), "--input", "-"];
        }
        const id = requireText(args, "id", "资源 ID");
        if (action === "get") return ["resource", "get", type, id];
        if (action === "update") {
          const schema = resourceUpdateSchemas[type as ResourceType];
          if (!schema) throw new Error(`不支持的资源类型：${type}`);
          validateJsonInput(schema, requireInput(args), `${type} update`);
          const changeNote = optionalText(args, "changeNote");
          return [
            "resource", "update", type, id, "--input", "-",
            ...(changeNote === undefined ? [] : flag("change-note", changeNote))
          ];
        }
        if (action === "history") return ["resource", "history", type, id];
        if (action === "restore") {
          const version = optionalNumber(args, "version");
          if (version === undefined) throw new Error("action=restore 时必须提供 version（正整数版本号）");
          const expected = optionalNumber(args, "expectedVersionNo");
          return [
            "resource", "restore", type, id,
            ...flag("version", version),
            ...(expected === undefined ? [] : flag("expected-version", expected))
          ];
        }
        throw new Error(`不支持的资源操作：${action}`);
      }
    },
    {
      name: "scriverse_manuscript",
      title: "导出全书正文",
      description: [
        "读取或导出作品完整正文。format=json 返回结构化 JSON；",
        "format=markdown/txt 默认直接返回纯文本，也可用 outputPath 写入本地文件；",
        "format=docx/epub 为二进制格式，必须提供 outputPath（建议绝对路径）保存到本地后返回文件信息。"
      ].join(""),
      inputSchema: {
        workId: workIdSchema,
        format: z.enum(["json", "markdown", "txt", "docx", "epub"])
          .describe("导出格式，默认 json"),
        outputPath: z.string().min(1).max(1_000).optional()
          .describe("导出文件保存路径；markdown/txt 可选，docx/epub 必填")
      },
      buildArgs: (args) => {
        const workId = requireText(args, "workId", "作品 ID");
        const format = optionalText(args, "format") ?? "json";
        const outputPath = optionalText(args, "outputPath");
        if ((format === "docx" || format === "epub") && !outputPath) {
          throw new Error(`format=${format} 必须提供 outputPath 保存二进制文件`);
        }
        return [
          "manuscript", "get", workId,
          ...flag("format", format),
          ...(outputPath === undefined ? [] : flag("output", outputPath))
        ];
      }
    },
    {
      name: "scriverse_search",
      title: "作品内混合搜索",
      description: "在单部作品内按关键词混合搜索章节、人物、设定等资源，返回相关片段。",
      inputSchema: {
        workId: workIdSchema,
        query: z.string().min(1).max(500).describe("搜索关键词"),
        type: z.string().min(1).max(64).optional()
          .describe("可选资源类型过滤；取值范围见 scriverse_schema 或 CLI 帮助"),
        limit: z.number().int().min(1).max(100).optional().describe("返回条数上限，1 到 100")
      },
      buildArgs: (args) => {
        const workId = requireText(args, "workId", "作品 ID");
        const query = requireText(args, "query", "搜索关键词");
        const type = optionalText(args, "type");
        const limit = optionalNumber(args, "limit");
        return [
          "search", workId,
          ...flag("query", query),
          ...(type === undefined ? [] : flag("type", type)),
          ...(limit === undefined ? [] : flag("limit", limit))
        ];
      }
    },
    {
      name: "scriverse_audit",
      title: "作品审计日志",
      description: "读取单部作品的审计日志，包含操作者、动作与时间，用于回答谁改了什么。",
      inputSchema: {
        workId: workIdSchema
      },
      buildArgs: (args) => ["audit", requireText(args, "workId", "作品 ID")]
    },
    {
      name: "scriverse_writing",
      title: "写作进度与目标",
      description: [
        "action=progress 查询作品写作进度统计；",
        "action=goal 更新写作目标，需要提供 input 请求体。"
      ].join(""),
      inputSchema: {
        action: z.enum(["progress", "goal"]).describe("progress：查询进度；goal：更新目标"),
        workId: workIdSchema,
        input: jsonInputSchema.optional()
          .describe(`action=goal 时必填。字段：${compactFieldSummary(writingGoalSchema)}（* 为必填；冗余字段会被拒绝）`)
      },
      buildArgs: (args) => {
        const action = requireText(args, "action", "写作操作");
        const workId = requireText(args, "workId", "作品 ID");
        if (action === "progress") return ["writing", "progress", workId];
        if (action === "goal") {
          validateJsonInput(writingGoalSchema, requireInput(args), "writing goal");
          return ["writing", "goal", workId, "--input", "-"];
        }
        throw new Error(`不支持的写作操作：${action}`);
      }
    },
    {
      name: "scriverse_chapter",
      title: "章节结构调整",
      description: [
        "action=move 移动单个章节到其他分卷或位置；",
        "action=batch 批量调整整部作品的章节结构。",
        "两者都需要 input 请求体，字段规范先用 scriverse_schema 查询 chapter。"
      ].join(""),
      inputSchema: {
        action: z.enum(["move", "batch"]).describe("move：移动章节；batch：批量结构调整"),
        id: z.string().min(1).max(200).optional()
          .describe("move 时为章节 ID；batch 时为作品 ID"),
        input: jsonInputSchema.optional()
          .describe(`move：${compactFieldSummary(chapterMoveSchema)}。batch：${compactFieldSummary(chapterBatchSchema)}。* 为必填；冗余字段会被拒绝`)
      },
      buildArgs: (args) => {
        const action = requireText(args, "action", "章节操作");
        const id = requireText(args, "id", action === "batch" ? "作品 ID" : "章节 ID");
        const input = requireInput(args);
        if (action === "move") {
          validateJsonInput(chapterMoveSchema, input, "chapter move");
          return ["chapter", "move", id, "--input", "-"];
        }
        if (action === "batch") {
          validateJsonInput(chapterBatchSchema, input, "chapter batch");
          return ["chapter", "batch", id, "--input", "-"];
        }
        throw new Error(`不支持的章节操作：${action}`);
      }
    },
    {
      name: "scriverse_annotation",
      title: "章节批注管理",
      description: [
        "管理章节批注：list 列出单个章节的批注（id 为章节 ID），",
        "list-work 跨章节列出整部作品的批注（id 为作品 ID），",
        "create 在章节上新建批注（id 为章节 ID），update 修改批注（id 为批注 ID），",
        "delete 删除批注（id 为批注 ID，可带 expectedVersionNo 乐观锁）。"
      ].join(""),
      inputSchema: {
        action: z.enum(["list", "list-work", "create", "update", "delete"]).describe("批注操作"),
        id: z.string().min(1).max(200).optional().describe("按 action 而定的 ID"),
        input: jsonInputSchema.optional()
          .describe(`create：${compactFieldSummary(annotationCreateSchema)}。update：${compactFieldSummary(annotationUpdateSchema)}。* 为必填；update 至少提供 note 或 status；冗余字段会被拒绝`),
        expectedVersionNo: expectedVersionSchema.optional().describe("action=delete 时的可选乐观锁")
      },
      buildArgs: (args) => {
        const action = requireText(args, "action", "批注操作");
        if (action === "list") return ["annotation", "list", requireText(args, "id", "章节 ID")];
        if (action === "list-work") return ["annotation", "list-work", requireText(args, "id", "作品 ID")];
        if (action === "create") {
          validateJsonInput(annotationCreateSchema, requireInput(args), "annotation create");
          return ["annotation", "create", requireText(args, "id", "章节 ID"), "--input", "-"];
        }
        const id = requireText(args, "id", "批注 ID");
        if (action === "update") {
          validateJsonInput(annotationUpdateSchema, requireInput(args), "annotation update");
          return ["annotation", "update", id, "--input", "-"];
        }
        if (action === "delete") {
          const expected = optionalNumber(args, "expectedVersionNo");
          return ["annotation", "delete", id, ...(expected === undefined ? [] : flag("expected-version", expected))];
        }
        throw new Error(`不支持的批注操作：${action}`);
      }
    },
    {
      name: "scriverse_ai_rename",
      title: "重命名 AI 对话",
      description: "修改一个 AI 对话的标题。",
      inputSchema: {
        conversationId: z.string().min(1).max(200).describe("AI 对话 ID"),
        title: z.string().min(1).max(200).describe("新标题，最多 200 字")
      },
      buildArgs: (args) => [
        "ai", "rename", requireText(args, "conversationId", "对话 ID"),
        ...flag("title", requireText(args, "title", "新标题"))
      ]
    },
    {
      name: "scriverse_ai_questions",
      title: "AI 用户提问处理",
      description: [
        "处理 AI 写作过程中向用户发起的提问：list 按状态列出提问，get 读取单个提问详情，",
        "answer 回答提问（input 支持 {selectedOption, customAnswer} 或批量 {answers: [...最多 5 项]}），",
        "reject 拒绝提问使其过期。"
      ].join(""),
      inputSchema: {
        action: z.enum(["list", "get", "answer", "reject"]).describe("提问操作"),
        workId: workIdSchema,
        questionId: z.string().min(1).max(200).optional().describe("提问 ID；除 list 外必填"),
        status: z.enum(["pending", "answered", "rejected", "expired"]).optional()
          .describe("action=list 时的状态过滤"),
        conversationId: z.string().min(1).max(200).optional()
          .describe("action=list 时可选，按对话过滤"),
        limit: z.number().int().min(1).max(200).optional().describe("action=list 时的条数上限"),
        input: jsonInputSchema.optional()
          .describe("action=answer 时必填。两种形式之一：{selectedOption?: 整数≥0（预设选项下标，从 0 起）, customAnswer?: 1..3000 字}（至少提供其一，可同时提供）；或批量 {answers: [同上结构]}（1..5 条）。冗余字段会被拒绝")
      },
      buildArgs: (args) => {
        const action = requireText(args, "action", "提问操作");
        const workId = requireText(args, "workId", "作品 ID");
        if (action === "list") {
          const status = optionalText(args, "status");
          const conversationId = optionalText(args, "conversationId");
          const limit = optionalNumber(args, "limit");
          return [
            "ai", "questions", "list", workId,
            ...(status === undefined ? [] : flag("status", status)),
            ...(conversationId === undefined ? [] : flag("conversation-id", conversationId)),
            ...(limit === undefined ? [] : flag("limit", limit))
          ];
        }
        const questionId = requireText(args, "questionId", "提问 ID");
        if (action === "get") return ["ai", "questions", "get", workId, questionId];
        if (action === "answer") {
          validateJsonInput(aiAnswerSchema, requireInput(args), "ai questions answer");
          return ["ai", "questions", "answer", workId, questionId, "--input", "-"];
        }
        if (action === "reject") return ["ai", "questions", "reject", workId, questionId];
        throw new Error(`不支持的提问操作：${action}`);
      }
    }
  ];
}

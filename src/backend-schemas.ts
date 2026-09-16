import { z } from "zod";

/**
 * Scriverse 服务端写入字段规范的镜像与校验层。
 *
 * 所有 schema 逐字段对照 scriverse 服务端（src/app.ts 的 zod 定义）与前端
 * 实际读写约定制定，并统一加 .strict()：input 中出现服务端不认识的冗余字段
 * 时直接拒绝提交——服务端对非 strict 的 create 路由会静默剥离冗余字段，
 * 对 strict 路由会整体报错，提前拦截对两者都是正确行为。
 *
 * 服务端没有约束、但前端约定了真实结构的地方（如 character 的 attributes
 * 扩展属性 details），按前端约定做更深一层的结构校验。
 *
 * 校验只拦截非法 input，不改写内容：通过校验的原始 input 仍原样交给 CLI。
 */

/** CLI v1.0.x 契约中的资源类型，与 `scriverse schema list` 保持一致。 */
export const RESOURCE_TYPES = [
  "volume",
  "chapter",
  "draft",
  "setting",
  "character",
  "race",
  "organization",
  "timeline-track",
  "timeline-event",
  "relationship",
  "foreshadow",
  "chapter-outline"
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

// ---------------------------------------------------------------------------
// 基础约束（与服务端 src/app.ts 顶部的公共定义一致）
// ---------------------------------------------------------------------------

const identifier = z.string().trim().min(1, "不能为空").max(200, "不能超过 200 字");

/** 必填文本：trim 后非空，且不超过 max 字（服务端 nonEmpty.max(N) 的镜像）。 */
const reqString = (max: number) =>
  z.string().trim().min(1, "不能为空").max(max, `不能超过 ${max} 字`);

/** 可选文本：不超过 max 字（服务端 z.string().max(N).optional() 的镜像）。 */
const optString = (max: number) => z.string().max(max, `不能超过 ${max} 字`).optional();

const strings = z.array(z.string()).optional();

const positiveInt = z.number().int().positive("必须为正整数");

const expectedVersionNo = positiveInt.optional()
  .describe("可选乐观锁：当前最新版本号，不匹配时服务端拒绝写入");

const chapterType = z.enum(["正文", "设定", "作者的话", "其他"]);

const changeNoteField = z.string().trim().max(500, "不能超过 500 字").optional()
  .describe("可选版本说明，最多 500 字，会写入版本历史");

// ---------------------------------------------------------------------------
// character 的深层结构（服务端是自由 JSON，真实结构由前端读写约定确定）
// ---------------------------------------------------------------------------

const characterDetail = z.object({
  label: z.string().trim().min(1, "label 不能为空").describe("属性名，如「身高」"),
  value: z.string().trim().min(1, "value 不能为空").describe("属性值，如「176cm」")
}).strict()
  .describe("扩展属性条目；仅含 label 与 value 两个必填字符串");

const characterAttributes = z.object({
  identity: z.string().trim().max(20_000, "不能超过 20000 字").optional()
    .describe("身份与定位（单行文本）"),
  species: z.string().min(1, "不能为空").optional()
    .describe("种族名（遗留字段，服务端会转换为种族引用；建议改用顶层 raceId）"),
  details: z.array(characterDetail).optional()
    .describe("扩展属性列表，如 [{\"label\":\"身高\",\"value\":\"176cm\"}]；身高、体重等结构化属性写在这里")
}).strict()
  .describe("结构化属性；仅允许 identity、species、details 三个字段");

const characterProfile = z.object({
  motivation: optString(20_000).describe("人物动机"),
  summary: optString(20_000).describe("人物简介"),
  personaSummary: optString(20_000).describe("人物侧写与性格摘要")
}).strict()
  .describe("人物档案；仅允许 motivation、summary、personaSummary（sections 由服务端管理，不允许写入）");

const safeStateKey = z.string().refine(
  (key) => key !== "__proto__" && key !== "constructor" && key !== "prototype",
  { message: "禁止使用该键名" }
);

const characterCurrentState = z.record(safeStateKey, z.unknown())
  .describe("当前状态键值对，如 {\"location\":\"北港\",\"condition\":\"受伤\"}；值建议用字符串");

// ---------------------------------------------------------------------------
// 各资源类型字段（create 为服务端 POST schema；update 为对应 PATCH schema，
// changeNote 一律不在 input 内：resource update 走顶层 changeNote 参数）
// ---------------------------------------------------------------------------

const volumeShape: z.ZodRawShape = {
  title: reqString(200).describe("分卷标题"),
  kind: z.enum(["main", "prequel", "extra", "epilogue", "appendix"]).optional()
    .describe("分卷类型：main|prequel|extra|epilogue|appendix"),
  description: optString(5_000).describe("分卷简介"),
  keywords: z.array(reqString(100)).max(100, "最多 100 项").optional().describe("分卷关键词"),
  storyOrder: z.number().int().min(0).max(1_000_000).optional().describe("故事时间线顺序")
};
const volumeUpdateShape: z.ZodRawShape = {
  ...partial(volumeShape),
  sortOrder: z.number().int().min(0).optional().describe("书架/目录排序（仅 update 支持）"),
  expectedVersionNo
};

const chapterShape: z.ZodRawShape = {
  volumeId: identifier.describe("所属分卷 ID"),
  title: reqString(300).describe("章节标题"),
  content: z.string().max(2_000_000, "不能超过 200 万字").optional().describe("章节正文"),
  chapterType: chapterType.optional().describe("章节类型：正文|设定|作者的话|其他")
};
const chapterUpdateShape: z.ZodRawShape = {
  ...partial(chapterShape),
  lineIds: z.array(identifier.nullable()).max(100_000, "最多 100000 项").optional()
    .describe("逐行 ID 数组（行级批注锚定用），元素可为 null"),
  excludedFromAnalysis: z.boolean().optional().describe("是否排除出 AI 分析"),
  source: z.enum(["manual", "auto"]).optional().describe("修改来源；CLI 通道建议保持缺省"),
  expectedVersionNo
};

const draftShape: z.ZodRawShape = {
  draftType: z.enum(["prose", "setting"]).describe("草稿类型：prose（正文）|setting（设定）"),
  volumeId: identifier.nullable().optional().describe("所属分卷 ID"),
  settingModule: z.enum(["settings", "characters", "races", "organizations", "timeline", "relationships", "outlines"])
    .nullable().optional().describe("设定草稿所属模块；draftType=setting 时使用"),
  title: reqString(200).describe("草稿标题"),
  content: z.string().max(200_000, "不能超过 200000 字").describe("草稿内容")
};
const draftUpdateShape: z.ZodRawShape = { ...partial(draftShape), expectedVersionNo };

const settingShape: z.ZodRawShape = {
  title: reqString(200).describe("设定标题"),
  category: reqString(100).describe("设定分类，如「地理」「势力」"),
  content: reqString(200_000).describe("设定正文（Markdown）"),
  tags: strings.describe("标签列表"),
  status: z.enum(["draft", "pending", "confirmed", "deprecated"]).optional()
    .describe("状态：draft|pending|confirmed|deprecated"),
  locked: z.boolean().optional().describe("是否锁定"),
  evidence: z.array(z.unknown()).optional().describe("证据引用数组，元素结构自由"),
  scope: z.record(z.string(), z.unknown()).optional().describe("作用范围对象，结构自由"),
  authorNote: optString(20_000).describe("作者备注")
};
const settingUpdateShape: z.ZodRawShape = { ...partial(settingShape), expectedVersionNo };

const characterShape: z.ZodRawShape = {
  name: reqString(200).describe("人物主名"),
  gender: z.enum(["male", "female", "none", "unknown"]).optional()
    .describe("性别"),
  isDead: z.boolean().optional().describe("是否已死亡"),
  code: z.string().trim().max(200, "不能超过 200 字").optional().describe("代号/编号"),
  aliases: z.array(z.string().trim().min(1, "别名不能为空").max(200, "单个别名不能超过 200 字"))
    .max(100, "最多 100 个").optional().describe("别名列表"),
  raceId: identifier.nullable().optional().describe("种族 ID"),
  organizationIds: z.array(identifier).max(100, "最多 100 项").optional().describe("所属组织 ID 列表"),
  attributes: characterAttributes.optional(),
  profile: characterProfile.optional(),
  currentState: characterCurrentState.optional(),
  lockedFields: strings.describe("AI 硬约束的字段名列表"),
  firstChapterId: identifier.nullable().optional().describe("首次出场章节 ID")
};
const characterUpdateShape: z.ZodRawShape = { ...partial(characterShape), expectedVersionNo };

const knowledgeSection = z.object({
  title: reqString(200).describe("小节标题"),
  contentMarkdown: optString(200_000).describe("小节内容（Markdown）"),
  summary: optString(100_000).describe("小节摘要"),
  sortOrder: z.number().int().min(0).max(100_000).optional().describe("排序序号")
}).strict().describe("设定知识小节");

const knowledgeSections = z.array(knowledgeSection).max(200, "最多 200 个小节").superRefine(
  (sections, ctx) => {
    const total = sections.reduce(
      (sum, section) => sum + (section.contentMarkdown?.length ?? 0) + (section.summary?.length ?? 0),
      0
    );
    if (total > 4_000_000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Markdown 章节总长度不能超过 4000000 个字符" });
    }
  }
).describe("设定知识小节列表");

function raceLikeShape(nameLabel: string): z.ZodRawShape {
  return {
    name: reqString(200).describe(nameLabel),
    settings: z.array(z.string().trim().min(1, "不能为空").max(20_000, "单条不能超过 20000 字"))
      .max(200, "最多 200 条").optional().describe("设定条目列表（每条一段文字）"),
    settingsMarkdown: optString(200_000).describe("设定正文（Markdown 整体）"),
    settingsSections: knowledgeSections.optional(),
    memberIds: z.array(identifier).max(1000, "最多 1000 项").optional().describe("成员 ID 列表")
  };
}
const raceShape: z.ZodRawShape = {
  ...raceLikeShape("种族名"),
  isExtinct: z.boolean().optional().describe("是否已灭绝"),
  parentRaceId: identifier.nullable().optional().describe("上级种族 ID"),
  description: optString(100_000).describe("种族简介")
};
const raceUpdateShape: z.ZodRawShape = { ...partial(raceShape), expectedVersionNo };
const organizationShape: z.ZodRawShape = {
  ...raceLikeShape("组织名"),
  isDissolved: z.boolean().optional().describe("是否已解散"),
  description: optString(100_000).describe("组织简介")
};
const organizationUpdateShape: z.ZodRawShape = { ...partial(organizationShape), expectedVersionNo };

const timelineTrackShape: z.ZodRawShape = {
  name: reqString(200).describe("时间轴名称"),
  description: optString(20_000).describe("时间轴说明"),
  sortOrder: z.number().int().min(0).optional().describe("排序序号")
};
const timelineTrackUpdateShape: z.ZodRawShape = { ...partial(timelineTrackShape), expectedVersionNo };

const timelineEventShape: z.ZodRawShape = {
  name: reqString(300).describe("事件名称"),
  trackId: identifier.nullable().optional().describe("所属时间轴 ID，可为 null"),
  description: optString(100_000).describe("事件详情"),
  eventType: optString(100).describe("事件类型标签"),
  timeLabel: optString(300).describe("时间显示文本，如「第三年春」"),
  timeSort: z.number().finite().nullable().optional().describe("时间排序数值"),
  chapterIds: strings.describe("关联章节 ID 列表"),
  participantIds: strings.describe("参与者人物 ID 列表"),
  location: optString(500).describe("事件地点"),
  causes: strings.describe("起因（文本列表）"),
  impactScope: z.enum(["personal", "organization", "regional", "world", "galaxy"]).optional()
    .describe("影响范围：personal|organization|regional|world|galaxy"),
  evidence: z.array(z.unknown()).optional().describe("证据引用数组，元素结构自由"),
  status: z.enum(["candidate", "pending", "confirmed", "deprecated"]).optional()
    .describe("状态：candidate|pending|confirmed|deprecated")
};
const timelineEventUpdateShape: z.ZodRawShape = { ...partial(timelineEventShape), expectedVersionNo };

const relationshipShape: z.ZodRawShape = {
  fromCharacterId: identifier.describe("关系主体人物 ID"),
  toCharacterId: identifier.describe("关系客体人物 ID"),
  category: z.enum(["family", "social", "emotional", "conflict", "uncertain"])
    .describe("关系大类：family|social|emotional|conflict|uncertain"),
  subtype: optString(100).describe("关系细类，如「师徒」"),
  keywords: z.array(z.string().trim().min(1, "不能为空").max(100, "单个不能超过 100 字"))
    .max(30, "最多 30 个").optional().describe("关系关键词"),
  directed: z.boolean().optional().describe("是否有方向性"),
  currentStatus: optString(100).describe("当前关系状态"),
  timeRange: z.record(z.string(), z.unknown()).optional().describe("时间范围对象，结构自由"),
  confidence: z.number().min(0, "不能小于 0").max(1, "不能大于 1").optional().describe("置信度 0..1"),
  evidence: z.array(z.unknown()).optional().describe("证据引用数组，元素结构自由"),
  confirmationStatus: z.enum(["pending", "confirmed", "rejected"]).optional()
    .describe("确认状态：pending|confirmed|rejected"),
  locked: z.boolean().optional().describe("是否锁定")
};
const relationshipUpdateShape: z.ZodRawShape = { ...partial(relationshipShape), expectedVersionNo };

const foreshadowOccurrence = z.object({
  chapterId: identifier.describe("发生章节 ID"),
  role: z.enum(["setup", "reminder", "payoff"]).describe("角色：setup（埋设）|reminder（提醒）|payoff（回收）"),
  note: optString(100_000).describe("备注"),
  evidence: z.array(z.unknown()).optional().describe("证据引用数组，元素结构自由")
}).strict().describe("伏笔发生记录；仅允许 chapterId、role、note、evidence");

const foreshadowShape: z.ZodRawShape = {
  title: reqString(300).describe("伏笔标题"),
  description: optString(100_000).describe("伏笔说明"),
  status: z.enum(["planned", "planted", "resolved", "abandoned"]).optional()
    .describe("状态：planned|planted|resolved|abandoned"),
  importance: z.enum(["low", "medium", "high"]).optional().describe("重要度：low|medium|high"),
  plannedPayoffChapterId: identifier.nullable().optional().describe("计划回收章节 ID"),
  resolutionNote: optString(100_000).describe("回收说明"),
  occurrences: z.array(foreshadowOccurrence).max(500, "最多 500 条").optional().describe("发生记录列表")
};
const foreshadowUpdateShape: z.ZodRawShape = { ...partial(foreshadowShape), expectedVersionNo };

const chapterOutlineShape: z.ZodRawShape = {
  goal: optString(100_000).describe("章节目标"),
  conflict: optString(100_000).describe("核心冲突"),
  turningPoint: optString(100_000).describe("转折点"),
  notes: optString(100_000).describe("备注"),
  status: z.enum(["draft", "ready", "completed"]).optional().describe("状态：draft|ready|completed")
};
const chapterOutlineUpdateShape: z.ZodRawShape = { ...partial(chapterOutlineShape), expectedVersionNo };

function partial(shape: z.ZodRawShape): z.ZodRawShape {
  const result: z.ZodRawShape = {};
  for (const [key, value] of Object.entries(shape)) {
    result[key] = value.optional();
  }
  return result;
}

function strictObject(shape: z.ZodRawShape): z.ZodTypeAny {
  return z.object(shape).strict();
}

/** resource create 的 input schema，键与 RESOURCE_TYPES 一一对应。 */
export const resourceCreateSchemas: Record<ResourceType, z.ZodTypeAny> = {
  volume: strictObject(volumeShape),
  chapter: strictObject(chapterShape),
  draft: strictObject(draftShape),
  setting: strictObject(settingShape),
  character: strictObject(characterShape),
  race: strictObject(raceShape),
  organization: strictObject(organizationShape),
  "timeline-track": strictObject(timelineTrackShape),
  "timeline-event": strictObject(timelineEventShape),
  relationship: strictObject(relationshipShape),
  foreshadow: strictObject(foreshadowShape),
  "chapter-outline": strictObject(chapterOutlineShape)
};

/** resource update 的 input schema；字段全部可选并追加 expectedVersionNo。 */
export const resourceUpdateSchemas: Record<ResourceType, z.ZodTypeAny> = {
  volume: strictObject(volumeUpdateShape),
  chapter: strictObject(chapterUpdateShape),
  draft: strictObject(draftUpdateShape),
  setting: strictObject(settingUpdateShape),
  character: strictObject(characterUpdateShape),
  race: strictObject(raceUpdateShape),
  organization: strictObject(organizationUpdateShape),
  "timeline-track": strictObject(timelineTrackUpdateShape),
  "timeline-event": strictObject(timelineEventUpdateShape),
  relationship: strictObject(relationshipUpdateShape),
  foreshadow: strictObject(foreshadowUpdateShape),
  "chapter-outline": strictObject(chapterOutlineUpdateShape)
};

// ---------------------------------------------------------------------------
// 其余写操作的 input schema（与 CLI 透传的服务端 body schema 一致）
// ---------------------------------------------------------------------------

const workShape: z.ZodRawShape = {
  title: reqString(200).describe("作品名"),
  author: optString(200).describe("作者名"),
  description: optString(10_000).describe("作品简介"),
  language: optString(30).describe("语言代码，如 zh-CN"),
  coverUrl: z.string().url("必须是合法 URL").nullable().optional().describe("封面图片 URL"),
  tags: strings.describe("标签列表"),
  editorAutoIndentEnabled: z.boolean().optional().describe("编辑器自动缩进开关"),
  editorTypewriterModeEnabled: z.boolean().optional().describe("编辑器打字机模式开关")
};

/** work create 的 input（服务端 POST /api/works）。 */
export const workCreateSchema = strictObject(workShape);

/**
 * work update 的 input（服务端 PATCH /api/works/:workId）。
 * work 更新没有对应的 --change-note/--expected-version 命令行参数，
 * changeNote 与 expectedVersionNo 只能放在 input 内。
 */
export const workUpdateSchema = strictObject({
  ...partial(workShape),
  expectedVersionNo,
  changeNote: changeNoteField
});

/** chapter move 的 input（服务端 POST /api/chapters/:chapterId/move）。 */
export const chapterMoveSchema = strictObject({
  volumeId: identifier.describe("目标分卷 ID"),
  sortOrder: z.number().int().min(0).describe("在分卷内的排序序号"),
  expectedVersionNo
});

const batchAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("move"), volumeId: identifier }).strict()
    .describe("移动到目标分卷（需 volumeId）"),
  z.object({ type: z.literal("setType"), chapterType }).strict()
    .describe("批量修改章节类型（需 chapterType：正文|设定|作者的话|其他）"),
  z.object({ type: z.literal("setAnalysisExclusion"), excludedFromAnalysis: z.boolean() }).strict()
    .describe("批量设置是否排除出 AI 分析（需 excludedFromAnalysis）"),
  z.object({
    type: z.literal("renumberTitles"),
    template: z.string().min(1, "不能为空").max(50, "不能超过 50 字").refine(
      (value) => value.split("{n}").length === 2 && !/[\u0000-\u001f\u007f]/u.test(value),
      "标题格式必须且只能包含一个 {n} 占位符，且不能包含换行或控制字符"
    ).describe("标题模板，如「第{n}章」"),
    numberStyle: z.enum(["arabic", "chinese"]).describe("编号风格：arabic|chinese"),
    startAt: z.number().int().min(1, "不能小于 1").max(999_999, "不能超过 999999").describe("起始编号")
  }).strict().describe("批量重命名章节标题"),
  z.object({ type: z.literal("delete") }).strict().describe("批量删除章节")
]).describe("批量动作；type=move|setType|setAnalysisExclusion|renumberTitles|delete");

/** chapter batch 的 input（服务端 POST /api/works/:workId/chapters/batch）。 */
export const chapterBatchSchema = strictObject({
  chapters: z.array(z.object({
    id: identifier.describe("章节 ID"),
    expectedVersionNo: positiveInt.describe("该章节当前版本号")
  }).strict()).min(1, "至少选择 1 章").max(200, "最多 200 章")
    .describe("要操作的章节及其当前版本号"),
  action: batchAction
});

/** writing goal 的 input（服务端 PUT /api/works/:workId/writing-goal）。 */
export const writingGoalSchema = strictObject({
  dailyGoal: z.number().int().min(0, "不能小于 0").max(1_000_000, "不能超过 1000000")
    .describe("每日字数目标"),
  targetTotal: z.number().int().min(0, "不能小于 0").max(100_000_000, "不能超过 100000000")
    .describe("全书总字数目标"),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "必须为 YYYY-MM-DD 格式").refine(
    (value) => {
      const date = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    },
    "不是有效的日历日期"
  ).nullable().describe("截止日期，YYYY-MM-DD")
});

/** annotation create 的 input（服务端 POST /api/chapters/:chapterId/annotations）。 */
export const annotationCreateSchema = strictObject({
  kind: z.enum(["note", "todo"]).describe("批注类型：note|todo"),
  startLine: positiveInt.describe("起始行号（从 1 开始）"),
  endLine: positiveInt.describe("结束行号（从 1 开始）"),
  note: z.string().trim().min(1, "不能为空").max(2000, "不能超过 2000 字").describe("批注内容")
}).superRefine((value, ctx) => {
  if (value.endLine < value.startLine) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endLine"], message: "结束行不能早于开始行" });
  }
});

/** annotation update 的 input（服务端 PATCH /api/chapter-annotations/:annotationId）。 */
export const annotationUpdateSchema = strictObject({
  note: z.string().trim().min(1, "不能为空").max(2000, "不能超过 2000 字").optional()
    .describe("新的批注内容"),
  status: z.enum(["open", "resolved"]).optional().describe("批注状态：open|resolved"),
  expectedVersionNo
}).superRefine((value, ctx) => {
  if (value.note === undefined && value.status === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "至少需要修改一项（note 或 status）" });
  }
});

const aiAnswerItem = strictObject({
  selectedOption: z.number().int().min(0, "不能小于 0").optional()
    .describe("选择的预设选项下标（从 0 开始）"),
  customAnswer: z.string().trim().min(1, "自定义回答不能为空").max(3000, "自定义回答不能超过 3000 字")
    .optional().describe("自定义回答文本")
}).superRefine((value, ctx) => {
  if (value.selectedOption === undefined && value.customAnswer === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "必须选择预设选项或填写自定义回答" });
  }
});

/** ai questions answer 的 input（服务端 answerAiUserQuestionSchema 的镜像）。 */
export const aiAnswerSchema = z.union([
  z.object({ answers: z.array(aiAnswerItem).min(1, "至少 1 条").max(5, "最多 5 条") }).strict(),
  aiAnswerItem
]);

// ---------------------------------------------------------------------------
// 校验执行与错误格式化
// ---------------------------------------------------------------------------

/**
 * 校验写操作的 input；失败时抛出带中文字段路径与原因的 Error，
 * 由 server.ts 转为 isError 工具结果返回给模型。
 */
export function validateJsonInput(schema: z.ZodTypeAny, input: unknown, label: string): void {
  const result = schema.safeParse(input);
  if (result.success) return;
  const details = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "input";
    return `${path}：${issueText(issue)}`;
  });
  throw new Error(`「${label}」input 校验失败（与 Scriverse 服务端字段规范一致）：${details.join("；")}`);
}

function issueText(issue: z.ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.join("、");
    return `未知字段 ${keys}（冗余字段会被拒绝；可用字段先用 scriverse_schema 查询）`;
  }
  if (issue.code === "invalid_type") {
    return issue.received === "undefined"
      ? `缺少必填字段（需要 ${issue.expected} 类型）`
      : `需要 ${issue.expected} 类型，实际为 ${issue.received}`;
  }
  if (issue.code === "invalid_enum_value") {
    return `取值必须是 ${issue.options.join("|")} 之一，实际为 ${String(issue.received)}`;
  }
  if (issue.code === "invalid_union") {
    return "不匹配任何允许的结构";
  }
  return issue.message;
}

// ---------------------------------------------------------------------------
// 字段格式说明生成（附加到 scriverse_schema 的返回结果，告知 AI 合法格式）
// ---------------------------------------------------------------------------

/** 递归展示层数上限：资源字段（1）→ 嵌套对象/数组元素字段（2）→ 更深一层（3）。 */
const MAX_DESCRIBE_DEPTH = 3;

/** 生成 scriverse_schema action=list 时附加的整体写入校验说明。 */
export function describeContractOverview(): string {
  return [
    "[scriverse-mcp 写入校验] 所有 create/update 的 input 都按 Scriverse 服务端字段规范做 strict 校验，",
    "未知/冗余字段、类型或取值不符会直接拒绝，不会发送到服务端。",
    `支持校验的类型：work，以及 ${RESOURCE_TYPES.join("、")}。`,
    "用 action=show type=<类型> 可查看该类型逐字段的合法格式。",
    "注意：resource update 的版本说明用顶层 changeNote 参数（input 内不允许 changeNote）；",
    "expectedVersionNo 写在 input 内可启用乐观锁。"
  ].join("\n");
}

/** 生成 scriverse_schema action=show 时附加的指定类型写入格式说明；未知类型返回 undefined。 */
export function describeResourceWriteContract(type: string): string | undefined {
  if (type === "work") {
    return [
      "[scriverse-mcp 写入校验] work 字段规范（冗余/未知字段会被拒绝）",
      describeSection("create", workCreateSchema),
      describeSection("update", workUpdateSchema),
      "说明：work update 的 changeNote 与 expectedVersionNo 只能放在 input 内（没有对应命令行参数）。"
    ].join("\n");
  }
  const create = resourceCreateSchemas[type as ResourceType];
  const update = resourceUpdateSchemas[type as ResourceType];
  if (!create || !update) return undefined;
  return [
    `[scriverse-mcp 写入校验] ${type} 字段规范（按 Scriverse 服务端真实 schema 制定，冗余/未知字段会被拒绝）`,
    describeSection("create", create),
    describeSection("update", update),
    "说明：resource update 的版本说明用顶层 changeNote 参数传递（input 内不允许 changeNote）；",
    "expectedVersionNo 写在 input 内可启用乐观锁。"
  ].join("\n");
}

function describeSection(action: "create" | "update", schema: z.ZodTypeAny): string {
  const object = effectsInner(schema);
  if (!(object instanceof z.ZodObject)) return `—— ${action} ——`;
  const required = Object.entries(object.shape as z.ZodRawShape)
    .filter(([, field]) => !unwrapWrappers(field).optional)
    .map(([name]) => name);
  const lines = describeFields(object.shape as z.ZodRawShape, 1, "");
  return [
    `—— ${action}（必填：${required.length > 0 ? required.join("、") : "无"}）——`,
    ...lines
  ].join("\n");
}

function describeFields(shape: z.ZodRawShape, depth: number, indent: string): string[] {
  return Object.entries(shape).flatMap(([name, field]) => describeField(name, field, depth, indent));
}

function describeField(name: string, field: z.ZodTypeAny, depth: number, indent: string): string[] {
  const { type, optional, nullable } = unwrapWrappers(field);
  const inner = effectsInner(type);
  const wrapped = inner !== type;
  const { label, children } = typeLabel(inner, depth, indent);
  const parts = [optional ? "可选" : "必填", label + (wrapped ? "（含附加校验）" : "")];
  if (nullable) parts.push("可为 null");
  const description = field.description;
  const line = `${indent}- ${name}（${parts.join("，")}）${description ? `：${description}` : ""}`;
  return [line, ...children];
}

function typeLabel(type: z.ZodTypeAny, depth: number, indent: string): { label: string; children: string[] } {
  if (type instanceof z.ZodString) return { label: stringLabel(type), children: [] };
  if (type instanceof z.ZodNumber) return { label: numberLabel(type), children: [] };
  if (type instanceof z.ZodBoolean) return { label: "boolean", children: [] };
  if (type instanceof z.ZodEnum) return { label: `枚举：${type._def.values.join("|")}`, children: [] };
  if (type instanceof z.ZodLiteral) return { label: `固定值 ${JSON.stringify(type._def.value)}`, children: [] };
  if (type instanceof z.ZodRecord) return { label: "自由键值对象（键值结构不限）", children: [] };
  if (type instanceof z.ZodArray) return arrayLabel(type, depth, indent);
  if (type instanceof z.ZodObject) return objectLabel(type, depth, indent);
  if (type instanceof z.ZodUnion || type instanceof z.ZodDiscriminatedUnion) {
    return { label: "多选一结构（见字段说明）", children: [] };
  }
  return { label: "任意 JSON", children: [] };
}

function objectLabel(
  type: z.ZodObject<z.ZodRawShape>,
  depth: number,
  indent: string
): { label: string; children: string[] } {
  const strict = type._def.unknownKeys === "strict";
  const children = depth < MAX_DESCRIBE_DEPTH
    ? describeFields(type.shape as z.ZodRawShape, depth + 1, `${indent}    `)
    : [];
  return { label: strict ? "object（仅允许列出的字段）" : "object", children };
}

function arrayLabel(
  type: z.ZodArray<z.ZodTypeAny>,
  depth: number,
  indent: string
): { label: string; children: string[] } {
  const parts: string[] = [];
  const minLength = type._def.minLength?.value;
  const maxLength = type._def.maxLength?.value;
  if (typeof minLength === "number") parts.push(`至少 ${minLength} 项`);
  if (typeof maxLength === "number") parts.push(`最多 ${maxLength} 项`);
  const element = effectsInner(unwrapWrappers(type.element).type);
  const brief = elementBrief(element);
  const children = element instanceof z.ZodObject && depth < MAX_DESCRIBE_DEPTH
    ? describeFields(element.shape as z.ZodRawShape, depth + 1, `${indent}    `)
    : [];
  return { label: `数组（元素：${brief}${parts.length > 0 ? `；${parts.join("，")}` : ""}）`, children };
}

function elementBrief(type: z.ZodTypeAny): string {
  if (type instanceof z.ZodString) return stringLabel(type);
  if (type instanceof z.ZodNumber) return numberLabel(type);
  if (type instanceof z.ZodBoolean) return "boolean";
  if (type instanceof z.ZodEnum) return `枚举：${type._def.values.join("|")}`;
  if (type instanceof z.ZodObject) return "object";
  return "任意 JSON";
}

function stringLabel(type: z.ZodString): string {
  const parts: string[] = [];
  let min: number | undefined;
  let max: number | undefined;
  for (const check of type._def.checks) {
    if (check.kind === "min" && typeof check.value === "number") min = check.value;
    if (check.kind === "max" && typeof check.value === "number") max = check.value;
    if (check.kind === "trim") parts.push("自动去首尾空格");
    if (check.kind === "url") parts.push("URL 格式");
  }
  if (min !== undefined) parts.push(`至少 ${min} 字`);
  if (max !== undefined) parts.push(`最多 ${max} 字`);
  return `string${parts.length > 0 ? `（${parts.join("，")}）` : ""}`;
}

function numberLabel(type: z.ZodNumber): string {
  const parts: string[] = [];
  for (const check of type._def.checks) {
    if (check.kind === "int") parts.push("整数");
    if (check.kind === "min" && typeof check.value === "number") {
      parts.push(`${check.inclusive ? "≥" : "＞"}${check.value}`);
    }
    if (check.kind === "max" && typeof check.value === "number") {
      parts.push(`${check.inclusive ? "≤" : "＜"}${check.value}`);
    }
  }
  return `number${parts.length > 0 ? `（${parts.join("，")}）` : ""}`;
}

function unwrapWrappers(schema: z.ZodTypeAny): { type: z.ZodTypeAny; optional: boolean; nullable: boolean } {
  let type = schema;
  let optional = false;
  let nullable = false;
  for (let guard = 0; guard < 8; guard += 1) {
    if (type instanceof z.ZodOptional) {
      optional = true;
      type = type._def.innerType;
      continue;
    }
    if (type instanceof z.ZodNullable) {
      nullable = true;
      type = type._def.innerType;
      continue;
    }
    break;
  }
  return { type, optional, nullable };
}

function effectsInner(schema: z.ZodTypeAny): z.ZodTypeAny {
  let type = schema;
  for (let guard = 0; guard < 8; guard += 1) {
    if (type instanceof z.ZodEffects) {
      type = type._def.schema;
      continue;
    }
    break;
  }
  return type;
}

// ---------------------------------------------------------------------------
// 单行字段速查（写入工具的 input 参数描述与资源类型速查，tools/list 即可见）
// ---------------------------------------------------------------------------

/**
 * 生成单行字段速查文本，例如 `title*（string（至少 1 字，最多 200 字））：作品名`，
 * 多个字段以「；」连接，* 表示必填；嵌套对象与数组元素展开两层。
 * 用于各写操作工具的 input 参数描述，让模型在 tools/list 阶段就拿到字段格式。
 */
export function compactFieldSummary(schema: z.ZodTypeAny): string {
  const object = effectsInner(schema);
  if (!(object instanceof z.ZodObject)) return "";
  return Object.entries(object.shape as z.ZodRawShape)
    .map(([name, field]) => compactField(name, field, 1))
    .join("；");
}

function compactField(name: string, field: z.ZodTypeAny, depth: number): string {
  const { type, optional, nullable } = unwrapWrappers(field);
  const inner = effectsInner(type);
  const parts = [compactTypeLabel(inner, depth)];
  if (nullable) parts.push("可为 null");
  const description = field.description;
  return `${name}${optional ? "" : "*"}（${parts.join("，")}）${description ? `：${description}` : ""}`;
}

function compactTypeLabel(type: z.ZodTypeAny, depth: number): string {
  if (type instanceof z.ZodString) return stringLabel(type);
  if (type instanceof z.ZodNumber) return numberLabel(type);
  if (type instanceof z.ZodBoolean) return "boolean";
  if (type instanceof z.ZodEnum) return `枚举 ${type._def.values.join("|")}`;
  if (type instanceof z.ZodLiteral) return `固定值 ${JSON.stringify(type._def.value)}`;
  if (type instanceof z.ZodRecord) return "自由键值对象";
  if (type instanceof z.ZodArray) {
    const parts: string[] = [];
    const minLength = type._def.minLength?.value;
    const maxLength = type._def.maxLength?.value;
    if (typeof minLength === "number") parts.push(`至少 ${minLength} 项`);
    if (typeof maxLength === "number") parts.push(`最多 ${maxLength} 项`);
    const element = effectsInner(unwrapWrappers(type.element).type);
    const elementLabel = element instanceof z.ZodObject && depth < 2
      ? `[{${compactObject(element, depth)}}]`
      : `(${elementBrief(element)})`;
    parts.unshift(elementLabel);
    return `数组 ${parts.join("，")}`;
  }
  if (type instanceof z.ZodObject) {
    return depth < 2 ? `object {${compactObject(type, depth)}}` : "object";
  }
  if (type instanceof z.ZodUnion || type instanceof z.ZodDiscriminatedUnion) {
    return "多选一结构（见字段说明）";
  }
  return "任意 JSON";
}

function compactObject(type: z.ZodObject<z.ZodRawShape>, depth: number): string {
  return Object.entries(type.shape as z.ZodRawShape)
    .map(([name, field]) => compactField(name, field, depth + 1))
    .join("，");
}

/**
 * 生成 scriverse_resource 工具描述末尾的类型速查：
 * 逐类型列出必填字段，并强调 character 扩展属性的正确写法。
 */
export function describeResourceQuickReference(): string {
  const entries = RESOURCE_TYPES.map((type) => {
    const object = effectsInner(resourceCreateSchemas[type]);
    if (!(object instanceof z.ZodObject)) return `${type}: ?`;
    const required = Object.entries(object.shape as z.ZodRawShape)
      .filter(([, field]) => !unwrapWrappers(field).optional)
      .map(([name]) => name);
    return `${type}: ${required.length > 0 ? required.join(" + ") : "无必填"}`;
  });
  return [
    "各类型必填字段速查（update 时字段全部可选，均支持 input 内 expectedVersionNo 乐观锁；",
    "完整逐字段格式用 scriverse_schema action=show type=<类型> 获取）：",
    entries.join("；") + "。",
    "人物扩展属性必须写 attributes.details=[{label,value}]（label/value 均为必填非空字符串，",
    "如 [{\"label\":\"身高\",\"value\":\"176cm\"}]），attributes/profile/currentState 内不得自造其他键。"
  ].join("\n");
}

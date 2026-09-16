import { describe, expect, it } from "vitest";
import {
  aiAnswerSchema,
  annotationCreateSchema,
  annotationUpdateSchema,
  chapterBatchSchema,
  chapterMoveSchema,
  compactFieldSummary,
  describeContractOverview,
  describeResourceQuickReference,
  describeResourceWriteContract,
  resourceCreateSchemas,
  resourceUpdateSchemas,
  validateJsonInput,
  workCreateSchema,
  workUpdateSchema,
  writingGoalSchema
} from "../src/backend-schemas.js";

/** 以 JSON.parse 构造 input，保证能构造 __proto__ 等自有键。 */
function parse(json: string): unknown {
  return JSON.parse(json);
}

function expectInvalid(schema: Parameters<typeof validateJsonInput>[0], input: unknown, pattern: RegExp): void {
  expect(() => validateJsonInput(schema, input, "test")).toThrow(pattern);
}

describe("validateJsonInput：character", () => {
  const create = resourceCreateSchemas.character;

  it("合法 payload 通过校验", () => {
    expect(() => validateJsonInput(create, {
      name: "沈逐溪",
      gender: "male",
      aliases: ["阿溪"],
      raceId: "race_1",
      organizationIds: ["org_1"],
      attributes: {
        identity: "船户出身的凡人",
        details: [{ label: "身高", value: "176cm" }, { label: "体重", value: "60kg" }]
      },
      profile: { motivation: "寻仙访道", summary: "水乡船户人家出身" },
      currentState: { location: "千湖泽", condition: "健康" }
    }, "character create")).not.toThrow();
  });

  it("attributes 中的冗余字段（height）被拒绝", () => {
    expectInvalid(create, parse(`{
      "name": "沈逐溪",
      "attributes": { "height": "176cm" }
    }`), /未知字段 height/);
  });

  it("details 元素缺少 value 被拒绝", () => {
    expectInvalid(create, parse(`{
      "name": "沈逐溪",
      "attributes": { "details": [{ "label": "身高" }] }
    }`), /value：缺少必填字段/);
  });

  it("details 元素的冗余字段被拒绝", () => {
    expectInvalid(create, parse(`{
      "name": "沈逐溪",
      "attributes": { "details": [{ "label": "身高", "value": "176cm", "unit": "cm" }] }
    }`), /未知字段 unit/);
  });

  it("profile 的冗余字段被拒绝（sections 由服务端管理）", () => {
    expectInvalid(create, parse(`{
      "name": "沈逐溪",
      "profile": { "summary": "s", "sections": [] }
    }`), /未知字段 sections/);
  });

  it("currentState 的原型链键名被拒绝", () => {
    expectInvalid(create, parse(`{
      "name": "沈逐溪",
      "currentState": { "__proto__": { "polluted": true } }
    }`), /禁止使用该键名/);
  });

  it("gender 非法取值被拒绝", () => {
    expectInvalid(create, { name: "沈逐溪", gender: "man" }, /取值必须是 male\|female/);
  });

  it("update 顶层 changeNote 引导使用顶层参数；expectedVersionNo 放行", () => {
    const update = resourceUpdateSchemas.character;
    expectInvalid(update, { changeNote: "x" }, /未知字段 changeNote/);
    expect(() => validateJsonInput(update, {
      currentState: { location: "北港" },
      expectedVersionNo: 3
    }, "character update")).not.toThrow();
  });
});

describe("validateJsonInput：其余资源类型", () => {
  it("work create 缺 title 被拒绝；update 允许 changeNote/expectedVersionNo", () => {
    expectInvalid(workCreateSchema, { author: "x" }, /title：/);
    expect(() => validateJsonInput(workUpdateSchema, {
      title: "新书名",
      changeNote: "改标题",
      expectedVersionNo: 2
    }, "work update")).not.toThrow();
  });

  it("volume create 不接受 sortOrder（仅 update 支持）", () => {
    expectInvalid(resourceCreateSchemas.volume, { title: "第一卷", sortOrder: 1 }, /未知字段 sortOrder/);
    expect(() => validateJsonInput(resourceUpdateSchemas.volume, {
      title: "第一卷", sortOrder: 1, expectedVersionNo: 4
    }, "volume update")).not.toThrow();
  });

  it("chapter create 必须带 volumeId", () => {
    expectInvalid(resourceCreateSchemas.chapter, { title: "第一章" }, /volumeId：/);
  });

  it("setting create 的冗余字段被拒绝", () => {
    expectInvalid(resourceCreateSchemas.setting, parse(`{
      "title": "千湖泽",
      "category": "地理",
      "content": "泽国水乡",
      "color": "#fff"
    }`), /未知字段 color/);
  });

  it("race 仅 name 必填：settingsSections 为可选", () => {
    expect(() => validateJsonInput(resourceCreateSchemas.race, { name: "人族" }, "race create"))
      .not.toThrow();
    expect(() => validateJsonInput(resourceCreateSchemas.organization, { name: "观澜宗" }, "organization create"))
      .not.toThrow();
    expectInvalid(resourceCreateSchemas.race, parse(`{
      "name": "人族",
      "settingsSections": [{ "title": "概况", "note": "x" }]
    }`), /未知字段 note/);
    expect(() => validateJsonInput(resourceCreateSchemas.race, {
      name: "人族",
      settingsSections: [{ title: "概况", contentMarkdown: "…", sortOrder: 0 }]
    }, "race create")).not.toThrow();
  });

  it("foreshadow occurrences 的 role 必须为枚举值", () => {
    expectInvalid(resourceCreateSchemas.foreshadow, parse(`{
      "title": "祖剑之谜",
      "occurrences": [{ "chapterId": "ch_1", "role": "twist" }]
    }`), /role：/);
  });

  it("chapter-outline create 可为空对象，update 允许 expectedVersionNo", () => {
    expect(() => validateJsonInput(resourceCreateSchemas["chapter-outline"], {}, "chapter-outline create"))
      .not.toThrow();
    expect(() => validateJsonInput(resourceUpdateSchemas["chapter-outline"], {
      goal: "抵达观澜宗", status: "ready", expectedVersionNo: 1
    }, "chapter-outline update")).not.toThrow();
  });
});

describe("validateJsonInput：其余写操作", () => {
  it("chapter move 合法；batch 校验动作结构", () => {
    expect(() => validateJsonInput(chapterMoveSchema, { volumeId: "vol_1", sortOrder: 2 }, "chapter move"))
      .not.toThrow();
    expect(() => validateJsonInput(chapterBatchSchema, {
      chapters: [{ id: "ch_1", expectedVersionNo: 1 }],
      action: { type: "renumberTitles", template: "第{n}章", numberStyle: "arabic", startAt: 1 }
    }, "chapter batch")).not.toThrow();
    expectInvalid(chapterBatchSchema, parse(`{
      "chapters": [{ "id": "ch_1", "expectedVersionNo": 1 }],
      "action": { "type": "renumberTitles", "template": "第章", "numberStyle": "arabic", "startAt": 1 }
    }`), /标题格式必须且只能包含一个/);
  });

  it("annotation create 校验行号顺序；update 至少修改一项", () => {
    expectInvalid(annotationCreateSchema, { kind: "note", startLine: 5, endLine: 3, note: "x" }, /结束行不能早于开始行/);
    expectInvalid(annotationUpdateSchema, { expectedVersionNo: 1 }, /至少需要修改一项/);
    expect(() => validateJsonInput(annotationUpdateSchema, { status: "resolved" }, "annotation update"))
      .not.toThrow();
  });

  it("writing goal 校验日期格式并允许 null", () => {
    expect(() => validateJsonInput(writingGoalSchema, {
      dailyGoal: 2000, targetTotal: 1_000_000, deadline: null
    }, "writing goal")).not.toThrow();
    expectInvalid(writingGoalSchema, {
      dailyGoal: 2000, targetTotal: 1_000_000, deadline: "2026-13-01"
    }, /不是有效的日历日期/);
    expectInvalid(writingGoalSchema, {
      dailyGoal: 2000, targetTotal: 1_000_000, deadline: "明年"
    }, /YYYY-MM-DD/);
  });

  it("ai answer 支持单个与批量两种形式", () => {
    expect(() => validateJsonInput(aiAnswerSchema, { selectedOption: 0 }, "ai questions answer")).not.toThrow();
    expect(() => validateJsonInput(aiAnswerSchema, {
      answers: Array.from({ length: 5 }, () => ({ selectedOption: 1 }))
    }, "ai questions answer")).not.toThrow();
    expectInvalid(aiAnswerSchema, { answers: [{}] }, /必须选择预设选项或填写自定义回答/);
    expectInvalid(aiAnswerSchema, { customAnswer: "" }, /自定义回答不能为空/);
    expectInvalid(aiAnswerSchema, {
      answers: Array.from({ length: 6 }, () => ({ selectedOption: 1 }))
    }, /最多 5 条/);
  });
});

describe("字段格式说明生成", () => {
  it("character 说明包含扩展属性结构与身高等示例指引", () => {
    const doc = describeResourceWriteContract("character");
    expect(doc).toBeDefined();
    expect(doc).toContain("写入校验");
    expect(doc).toContain("—— create（必填：name）——");
    expect(doc).toContain("attributes");
    expect(doc).toContain("identity");
    expect(doc).toContain("details");
    expect(doc).toContain("label");
    expect(doc).toContain("身高");
    expect(doc).toContain("—— update（必填：无）——");
    expect(doc).toContain("changeNote");
  });

  it("volume 的 update 说明包含 sortOrder（仅 update 支持）", () => {
    const doc = describeResourceWriteContract("volume");
    expect(doc).toContain("sortOrder");
  });

  it("work 说明提示 changeNote 只能放 input 内", () => {
    const doc = describeResourceWriteContract("work");
    expect(doc).toContain("没有对应命令行参数");
  });

  it("未知类型返回 undefined；总览列出全部类型", () => {
    expect(describeResourceWriteContract("review")).toBeUndefined();
    const overview = describeContractOverview();
    expect(overview).toContain("strict 校验");
    expect(overview).toContain("character");
    expect(overview).toContain("chapter-outline");
  });
});

describe("单行字段速查（tools/list 可见的格式说明）", () => {
  it("compactFieldSummary 用 * 标注必填并带约束与描述", () => {
    const summary = compactFieldSummary(workCreateSchema);
    expect(summary).toContain("title*（string");
    expect(summary).toContain("最多 200 字");
    expect(summary).toContain("：作品名");
    expect(summary).toContain("coverUrl（string");
    expect(summary).toContain("可为 null");
    expect(summary).not.toContain("description*");
  });

  it("嵌套结构展开两层：batch 的 chapters 数组与 action 多选一", () => {
    const move = compactFieldSummary(chapterMoveSchema);
    expect(move).toContain("volumeId*");
    expect(move).toContain("sortOrder*（number（整数，≥0）");
    const batch = compactFieldSummary(chapterBatchSchema);
    expect(batch).toContain("chapters*（数组 [{id*");
    expect(batch).toContain("expectedVersionNo*（number（整数，＞0）");
    expect(batch).toContain("action*（多选一结构");
  });

  it("annotation 与 writing goal 的速查包含关键约束", () => {
    expect(compactFieldSummary(annotationCreateSchema)).toContain("endLine*（number（整数，＞0）");
    expect(compactFieldSummary(annotationUpdateSchema)).toContain("status（枚举 open|resolved）");
    const goal = compactFieldSummary(writingGoalSchema);
    expect(goal).toContain("dailyGoal*");
    expect(goal).toContain("deadline*（string，可为 null）：截止日期");
  });

  it("类型速查逐类型列出必填字段并强调扩展属性写法", () => {
    const quick = describeResourceQuickReference();
    expect(quick).toContain("character: name");
    expect(quick).toContain("chapter: volumeId + title");
    expect(quick).toContain("race: name");
    expect(quick).toContain("organization: name");
    expect(quick).toContain("chapter-outline: 无必填");
    expect(quick).toContain("relationship: fromCharacterId + toCharacterId + category");
    expect(quick).toContain("attributes.details=[{label,value}]");
    expect(quick).toContain("身高");
  });
});

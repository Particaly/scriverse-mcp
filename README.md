# scriverse-mcp

把 [Scriverse](https://github.com/musnows/Scriverse) 的命令行工具封装为 MCP（Model Context Protocol）stdio Server，让 Claude Desktop、ZCode 等 AI Agent 能够直接操控已部署的 Scriverse 服务。

本包不修改 Scriverse 服务端，也不依赖其内部 API：所有工具都通过子进程调用官方 npm 包 `@musnows/scriverse` 提供的 `scriverse` CLI，并解析其 JSON 输出。CLI 能做什么，Agent 就能做什么。

## 工作原理

```text
AI Agent（MCP 客户端）
   |  stdio（JSON-RPC）
   v
scriverse-mcp（本包，本地进程）
   |  子进程调用 scriverse <command> --compact
   v
@musnows/scriverse CLI（HTTP + API Key）
   |
   v
已部署的 Scriverse 服务 /api/*
```

## 前置条件

- Node.js >= 22.5.0
- 一个可访问的已部署 Scriverse 服务
- 一个属于你账号的 API Key（`scrv_` 开头，在 Scriverse 网页端的用户设置中生成或重置）

## 安装

```bash
npm install --global scriverse-mcp
```

## 认证

任选其一：

方式一：CLI 登录配置文件（推荐，密钥不进入 MCP 配置文件）

```bash
npx scriverse auth login --server https://your-scriverse.example.com --api-key-file ./api-key.txt
```

登录状态保存在 `~/.config/scriverse/cli.json`（或 `SCRIVERSE_CONFIG` 指定路径），scriverse-mcp 自动复用。

方式二：环境变量自动登录

在 MCP 配置中同时提供 `SCRIVERSE_SERVER` 与 `SCRIVERSE_API_KEY`，scriverse-mcp 启动时自动执行一次 `scriverse auth login` 生成临时配置文件（权限 0600，进程退出即删除）。

## MCP 客户端配置示例

已通过方式一登录时：

```json
{
  "mcpServers": {
    "scriverse": {
      "command": "scriverse-mcp"
    }
  }
}
```

使用方式二时：

```json
{
  "mcpServers": {
    "scriverse": {
      "command": "scriverse-mcp",
      "env": {
        "SCRIVERSE_SERVER": "https://your-scriverse.example.com",
        "SCRIVERSE_API_KEY": "scrv_xxxxxxxxxxxx"
      }
    }
  }
}
```

## 工具清单

| 工具 | 对应 CLI 命令 | 说明 |
| --- | --- | --- |
| `scriverse_schema` | `schema list` / `schema show` | 查看资源字段规范与示例；写操作前先查 |
| `scriverse_work` | `work ...` | 作品列表、详情、创建、更新、版本历史与回滚 |
| `scriverse_resource` | `resource ...` | 设定库资源：分卷、章节、想法、设定、人物、种族、组织、时间轴、事件、关系、伏笔、章节大纲的增改查与版本回滚 |
| `scriverse_manuscript` | `manuscript get` | 全书正文导出；json/markdown/txt 直接返回文本，docx/epub 保存到本地文件 |
| `scriverse_search` | `search` | 作品内混合搜索 |
| `scriverse_audit` | `audit` | 作品审计日志 |
| `scriverse_writing` | `writing progress` / `writing goal` | 写作进度查询与目标更新 |
| `scriverse_chapter` | `chapter move` / `chapter batch` | 章节移动与批量结构调整 |
| `scriverse_annotation` | `annotation ...` | 章节批注管理 |
| `scriverse_ai_rename` | `ai rename` | 重命名 AI 对话 |
| `scriverse_ai_questions` | `ai questions ...` | 查看、回答、拒绝 AI 发起的用户提问 |

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `SCRIVERSE_SERVER` | 服务端地址，与 `SCRIVERSE_API_KEY` 成对提供时启动自动登录 |
| `SCRIVERSE_API_KEY` | API Key；仅用于启动登录，不会写入日志或工具结果 |
| `SCRIVERSE_CONFIG` | 指定 CLI 登录配置文件路径 |
| `SCRIVERSE_CLI_PATH` | 指定 scriverse CLI 入口文件路径（默认从依赖包解析） |
| `SCRIVERSE_MCP_TIMEOUT_MS` | 单次 CLI 调用超时毫秒数（默认 120000） |

## 安全边界

- 能力面与 `scriverse` CLI 完全一致：用户管理、作品成员管理、系统管理、AI 供应商管理、永久删除等操作不在契约内，本包也不提供。
- 所有写操作走服务端版本机制，支持 `changeNote` 版本说明与 `expectedVersionNo` 乐观锁，可随时通过 history/rollback 回滚。
- 服务端使用 HTTP 时，CLI 的明文传输告警会原样透传给 Agent。
- 环境变量登录产生的临时配置文件权限为 0600，进程退出即删除。

## 开发

```bash
npm install
npm run check
```

测试通过 `test/fixtures/stub-cli.mjs` 模拟 CLI 行为，不需要真实服务与凭据；`SCRIVERSE_CLI_PATH` 可将 Server 指向任意 CLI 入口用于联调。

## 许可证

AGPL-3.0-only，与上游 Scriverse 项目一致。

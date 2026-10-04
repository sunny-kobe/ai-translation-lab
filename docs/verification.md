# V1 验证记录

日期：2026-10-01（Asia/Shanghai）。下面结果均来自本轮实际执行。可重复命令及本地证据位于 README 与 `output/`。

## 覆盖口径

- 数据库：项目专属真实 PostgreSQL 17；本机无可用 Docker daemon，使用 embedded-postgres 的本地二进制。
- 单元与 API：Vitest + Fastify inject + 隔离 PostgreSQL schema，不是 mock DB。
- 重启：测试脚本对自身 API 进程发送 SIGKILL 后重新启动，验证持久化任务恢复。
- 浏览器：隔离 Chrome + Playwright，真实页面与 API；不读取个人浏览器 profile。
- 模型：仅 Fake，不调用任何外部模型，不计语义准确率。
- Git：不初始化/提交/推送；当前业务仓库保持不变。

## 已修正的问题

1. 浏览器结果列表不能跟随总任务状态提前停止轮询。结果列表按自身行状态轮询到结束。
2. React 19 与 Ant Design 5 存在兼容提示；固定 React 18.3.1 使用原生支持组合。
3. smoke 使用稳定的语言单元格定位行，避免编辑结果后原译文 selector 失效。

4. 无 body 的 POST 不发送 JSON Content-Type；Fastify 的非法 JSON/空 JSON 请求保持 400，避免误报 500。已补浏览器 API 客户端通过真实 HTTP 的回归测试。

5. 移动视口中 grid 的默认最小宽度会让表格撑宽页面；已设置 min-width: 0 / minmax(0, 1fr)，smoke 增加 390px 页面不溢出断言。

## 未覆盖

Docker 实际容器启动、真实供应商 SDK、语义翻译质量、生产身份认证、多实例调度、供应商计费幂等与公网部署。

## 最终结果

| 检查                            | 实际结果                                                               |
| ------------------------------- | ---------------------------------------------------------------------- |
| `npm run check`                 | 格式、TypeScript、20 个 Vitest 测试、Vite 生产构建通过                 |
| `npm run smoke`                 | 8 个浏览器步骤通过，console errors 为 0；桌面/移动截图与下载 JSON 留存 |
| `npm run smoke:restart`         | 强制结束脚本自建 API 后重启，16/16 持久化结果完成；中断项至少尝试两次  |
| `docker compose config --quiet` | Compose 配置静态验证通过；Docker daemon 未就绪，未跑容器               |

构建仍有单 JS chunk 超过 500 KB 的提示（约 1.08 MB，gzip 339 KB）。当前本地闭环可用；包体优化留在性能学习阶段，没有通过调整阈值隐藏提示。

本地证据：`output/playwright/smoke.json`、`desktop.png`、`mobile.png`、`zh.json`；崩溃证据：`output/restart-smoke.json` 与日志。自动化测试产物被忽略，不假定已经发布或跨机器可访问。

当前服务从此项目启动：PostgreSQL 54329、API 4310、Vite 5178。具体进程和启动命令保存在 `.local/services.json`。数据持久化在 `.local/postgres`，服务保持运行供验收。

## 智谱接入验证（2026-10-01）

在用户授权后，后端从本机个人配置取智谱 key，并写入仅本用户可读写的 `.env`；未使用浏览器凭据或公司接口，未新增依赖，未修改数据库 schema。当前运行实例为 `zhipu / glm-4.7`，Fake 仍为未配置时的默认值。

最初真实请求在 10 秒超时后重试，出现限流。依据官方对话补全文档关闭思考，并将真实 provider 超时调整为 60 秒、增加 2 秒/4 秒退避后，重试同一任务成功：`Hello {name}, welcome to Nova!` → `你好 {name}，欢迎来到 Nova！`。占位符和术语校验通过。

- `npm run check`：格式、类型、35 个测试（含真实 PG）、生产构建通过；大 chunk 提示仍存在。
- `npm run smoke`：使用真实智谱，中法两个结果均首次成功；记录人工编辑前的模型输出，验证审核阻止未就绪导出、人工编辑/审核、JSON 下载、刷新持久化、390px 无页面溢出；console errors 为 0。
- 独立 Fake 浏览器 smoke：使用本任务创建的唯一 schema、4312/5179 端口，8 个步骤通过（含部分成功、失败重试、成功结果保留）；结束后关闭其服务并只清理其 schema。主服务保持运行。
- `npm run smoke:restart`：Fake 隔离 schema 下实际 SIGKILL/重启，16/16 结果恢复完成。

真实证据：`output/playwright/smoke.json` 中保留 provider、model、jobId 和人工编辑前的 modelResults；截图与下载同目录。Fake 证据在 `output/fake-playwright/`，重启证据沿用 `output/restart-smoke.json`。供应商异常响应、取消请求、缺凭据、永久错误不自动重试等边界由确定性测试验证，未刻意在真实供应商制造鉴权或限流错误。

这只证明小样本真实调用与操作闭环；没有完成所有语言的语义盲评、生产容量、全局速率/费用预算或公网部署验收。原有 Fake 任务与数据保留。

## 模型选择与学习准备（2026-10-01）

默认真实模型已改为 `glm-5.3-flash`，并核对运行实例的 health。依据官方模型文档设置必须开启的思考模式、`reasoning_effort=low` 和 8192 输出 token 上限；保留 4.7 的非思考参数。过滤无关术语，并拒绝供应商明确标记截断的结果，避免原样重复自动重试。

- `npm run check`：格式、类型、40 个测试（含真实 PostgreSQL）、生产构建通过；原有大 chunk 提示保留。
- `npm run smoke`：运行中的 5.3-Flash 完成真实中法翻译、审核前阻止导出、人工编辑/审核、下载、刷新持久化与移动宽度检查；console errors 为 0。
- `npm run smoke:restart`：隔离 Fake worker 实际崩溃后恢复 16/16 结果。
- 四语言模型比较：5.3-Flash 的 4 个样例全部通过机械检查，耗时约 1.0–1.7 秒，按官方标准价保守估算合计 ¥0.0008892；免费 4.7-Flash 的 4 次请求全部返回 429。没有拿限流失败作为模型质量结论，没有把费用估算当账户账单。

比较证据在 `output/model-comparison.json`；复现入口为 `scripts/compare-models.ts`，必须显式设置 `MODEL_COMPARE_ENABLED=1` 才调用真实模型。模型价格、参数依据和后续优化顺序见 `docs/model-selection.md`；第一课的操作和阅读顺序已补入 `docs/learning.md`。本轮没有变更共享契约、数据库 schema 或依赖，没有记录未知的个人学习时长。

## 多 key、多语言常规回归（2026-10-01，旧串行基线）

在当时的串行 worker 下，将 50 keys × 4 语言边界加入 `tests/api.integration.test.ts`：真实 PostgreSQL 唯一 schema 与现有 FakeTranslator 完成 200 个结果；按每个 key/语言检查唯一性、源文和输出对应关系；审核前四种语言均禁止导出，仅审核中文后导出恰好 50 个对应 key，其他语言保持未审核。

`npm run check` 实际通过：41 个测试、格式、类型和生产构建。新增边界测试约 22.2 秒，仅使用 Fake；不代表真实模型的批量吞吐或语义准确率。测试只清理自己创建的 schema，主服务与已有任务保留。该段是升级前的串行基线；升级后证据见下面的 key-level 批量章节。

## 按 key 的多语言批量升级（2026-10-02）

用户明确要求一次请求按一个 key 翻译全部所选语言，已将实现从逐语言 provider 调用改为 key-level provider 调用。语言目录现在包含 50 个稳定代码；页面支持 searchable multi-select、全选 50 种和清空。结果表仍按 `(job_id, source_key, language)` 逐项保存，所以审核、导出和人工修改不需要改成一条大 JSON。

- 追加 `sql/002_key_requests.sql`：任务 provider/model/prompt 快照、`translation_calls` 请求级历史、结果/尝试关联、`next_attempt_at` 和 worker cooldown 表。旧任务 metadata 为 NULL，表示 unknown。
- `Worker` 默认同时处理 2 个 key，配置范围 1–4；一次 claim 锁定一个 job/key 的所有 queued 语言并只调用 provider 一次。等待模型不持有 SQL 事务；每个语言按 revision 条件写回。
- provider 请求返回 `{ key, translations[] }`，严格拒绝额外/重复/不属于请求的语言；缺语言、占位符、术语和输出结构错误按语言记录。成功语言不因同 key 其他语言失败而丢弃。
- 50 keys × 50 languages 的真实 PostgreSQL + Fake 回归通过：2500 条唯一结果、50 条 `translation_calls`、中文审核后导出 50 条。4 个 key × 50 语言并发测试观察峰值为 2，调用数为 4，未超过配置。
- 真实智谱 smoke 通过：一个 key 的中文和法语在一次模型请求中完成；provider/model/prompt 快照出现在任务详情；人工审核、导出和刷新持久化通过，console errors 为 0。
- `npm run smoke:restart` 通过：Fake 隔离 schema 进程 SIGKILL 后 16/16 结果恢复。`npm run check` 当前通过 48 个测试、类型检查和构建。

当前并发是**同一 worker 内最多 2 个 key 请求**，不是 2 × 50 个语言请求；一个 key 的 50 种语言共享一次模型请求。真实账户的并发上限、语义翻译质量、供应商 exactly-once 计费和 Batch API 仍需独立验证。

## 真实一 key × 50 语言验收（2026-10-02）

使用当前本机智谱 key 创建 1 个 key、50 个语言的真实任务：最终 50/50 成功，唯一语言数 50，`translation_calls` 只有 1 条。模型为 `glm-5.3-flash`，prompt version 为 `key-multilingual-v2`，usage 为输入 976、输出 1156、总计 2132 tokens，耗时 17.6 秒。证据为 `output/real-key-50-languages.json`。这里只证明请求数、返回完整性和机械约束；没有完成 50 种语言的人工语义评审。

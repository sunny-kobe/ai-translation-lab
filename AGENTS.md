# AI Translation Lab

独立的个人学习项目。以可运行前后端闭环、数据契约和可靠性证据为目标。

- Node.js 24，npm + package-lock.json。React 18 / TypeScript / Vite / Ant Design / TanStack Query；Fastify / TypeBox / OpenAPI；PostgreSQL + pg。
- `shared/contracts.ts` 是请求和响应契约；`sql/` 是按序 SQL 迁移。不修改已经执行过的迁移来掩盖 schema 演进。
- 所有任务和结果必须持久化。一个 worker 持有 PostgreSQL session advisory lock；每次变更先锁 job，再锁 result。
- 模型适配器只做翻译，不写数据库。Fake 是默认 provider；显式配置 `TRANSLATOR_PROVIDER=zhipu` 后，可用后端 `ZHIPU_API_KEY` 调用智谱官方 API。未经明确配置，不使用任何凭据或外部模型。
- 保留人工编辑和审核结果；写回校验 revision，过期结果丢弃。导出只允许该语言全部成功并审核的结果。
- 项目数据库必须是本地 `translation_lab` 或 `translation_lab_test`；不要使用公司数据库、公司代码、浏览器凭据或已有业务实现。
- 不删除已有数据、`.local/postgres` 或 Compose 数据卷。不终止其他任务的进程，不提交/推送，除非明确请求。
- 核心验证：`npm run check`（格式、类型、Vitest、真实 PG 集成测试、构建）；服务启动后 `npm run smoke` 和 `npm run smoke:restart`。
- smoke 产物在 `output/`，数据库/运行记录在 `.local/`，均不提交。测试只清理自己创建的唯一 schema。
- 模型语义质量与工程可靠性分开报告。Fake 通过不能声称真实翻译准确；代码产出也不能等同用户已掌握能力。
- 详细设计和实验步骤见 `docs/architecture.md`、`docs/learning.md`、`docs/verification.md`。

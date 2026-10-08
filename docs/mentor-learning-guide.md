# AI Translation Lab 导师式学习指南

## 学习目标

你要掌握的不是“会调用一个翻译接口”，而是能独立解释并复现这条业务链路：

```text
批量 Key + 英文文案
  → API 契约
  → 持久化任务
  → worker 调用模型
  → 输出校验
  → 逐语言保存
  → 人工编辑与审核
  → 语言 JSON 导出
```

GoAdmin 已经证明这条业务有真实使用场景。当前项目的作用，是把原来被 `gclt.GenTranslateLang` 和后台逻辑隐藏的部分拆开，变成可以独立学习和验证的实现。

## 先读哪些文档

按这个顺序阅读，不要从依赖教程开始：

1. [README.md](../README.md)：项目边界、启动方式、输入输出和代码阅读顺序。
2. [当前轮次验证报告](verification-2026-10-05.md)：哪些结果是本轮实际证明的。
3. [架构说明](architecture.md)：任务、数据库、worker、版本保护和质量契约。
4. [实验手册](learning.md)：每个实验的操作和个人验收标准。
5. [面试材料](interview.md)：设计取舍和高频追问。
6. [模型选择记录](model-selection.md)：真实模型、成本和语义评测边界。
7. `shared/contracts.ts`、`sql/001_initial.sql`、`server/worker.ts`、`server/quality.ts`：完成前五步后再精读。

GoAdmin 对照代码建议只看四处：

- `gosh_admin_fe/src/pages/tool/aiTranslate/components/BatchTranslateForm.tsx`
- `gosh_admin_fe/src/services/tool/translate.ts`
- `gosh_admin/biz/handler/translate.go` 的 `NewTransLang`
- `gosh_admin/biz/service/translate.go` 的 `TranslateNewLangV2`

## 现在就按这个顺序开始

你刚才已经跑通了一次真实智谱任务，所以第一遍学习不需要从 Fake 开始。页面当前如果显示 `智谱 · glm-5.3`，就按下面的步骤观察；如果显示 `Fake Translator`，先检查项目 `.env` 和 API health。

### 步骤 0：确认运行实例

打开：

```text
http://127.0.0.1:4310/api/health
```

应该看到 `provider: zhipu` 和当前模型。然后打开前端页面，确认页面提示“已连接智谱真实翻译”。

你要看懂的代码是 [server/main.ts](../server/main.ts)：

```text
读取环境配置
→ createProvider()
→ PostgreSQL migrate()
→ buildApp()
→ Worker.initialize()
→ worker.start()
```

完成标准：能说清楚 API、worker、数据库和模型 provider 是在什么顺序启动的。

### 步骤 1：用一条真实 Key 追完整链路

输入一条简单文案：

```json
{ "lesson.save": "Save" }
```

只选择中文，点击创建任务。记录任务 ID，然后依次观察：

1. 浏览器发送 `POST /api/jobs`；
2. API 返回 `202` 和任务 ID；
3. 数据库先出现 `queued` 结果；
4. worker 将结果变成 `running`；
5. 智谱返回 JSON；
6. 校验通过后结果变成 `succeeded`；
7. 页面继续轮询结果；
8. 审核前导出按钮仍然不可用。

对应代码：

- 前端提交和轮询：`web/App.tsx`、`web/api.ts`；
- HTTP 路由：`server/app.ts`；
- 创建数据库记录：`server/store.ts` 的 `create()`；
- 领取和执行：`server/worker.ts` 的 `claimKey()`、`execute()`；
- 智谱请求：`server/providers.ts` 的 `ZhipuTranslator.translateKey()`。

完成标准：你能解释为什么“接口返回成功”不等于“翻译已经完成”。

### 步骤 2：观察一 Key 多语言和批量结果

输入三条接近真实后台的 Key：

```json
{
  "common.save": "Save",
  "common.welcome": "Welcome, {name}! Nova",
  "common.insufficient_balance": "Insufficient balance. Please try again."
}
```

选择中文、法语、西班牙语，填写术语：

```json
[{ "source": "Nova", "targets": { "zh": "Nova", "fr": "Nova", "es": "Nova" } }]
```

这次重点观察：3 个 Key × 3 种语言会保存 9 行结果，但当前 key-level provider 是每个 Key 一次模型请求，所以成功路径是 3 次模型请求，而不是 9 次。

完成标准：能区分“业务结果数量”“数据库结果行数”和“模型请求数量”。

### 步骤 3：从数据库反查模型调用

在 API docs 或 PostgreSQL 中查看：

- `translation_jobs`：任务、语言、provider/model 快照；
- `translation_results`：每个 Key × language 的最终状态；
- `translation_calls`：每次模型请求、prompt version、usage、耗时；
- `translation_attempts`：每一次尝试、失败码和 discarded 记录。

你应该能把一条结果连回一次模型调用：

```text
translation_results.call_id
→ translation_calls.id
→ provider / model / usage / duration_ms
```

完成标准：能回答“这条译文由哪个模型生成、用了多少 token、耗时多久”。

### 步骤 4：审核、编辑、导出

先不要审核，尝试导出 JSON，确认返回 409。然后：

1. 编辑中文译文；
2. 保留 `{name}`；
3. 勾选审核；
4. 再次导出中文 JSON；
5. 刷新页面，确认人工结果仍在。

然后故意删除 `{name}` 再保存，观察 `PLACEHOLDER_MISMATCH`。使用旧 revision 保存，观察 `409 Result changed`。

完成标准：能说明审核为什么不是 UI 装饰，而是导出前的业务门槛。

### 步骤 5：再学习 Fake 故障实验

只有理解真实成功路径后，才切换到 Fake 做可重复故障实验：

```text
transient → 临时错误和重试
malformed  → 输出结构错误
partial    → 某语言失败、其他语言保留
```

Fake 用来验证控制流，不用来评价翻译质量。完成后切回 `TRANSLATOR_PROVIDER=zhipu`，重启 API。

### 步骤 6：学习 worker 和崩溃恢复

运行：

```bash
npm run smoke:restart
```

再按顺序阅读：

```text
recoverInterrupted()
→ claimKey()
→ execute()
→ 条件 UPDATE
→ refreshJob()
```

完成标准：能解释为什么服务崩溃后可能重复调用模型，因此系统只能保证结果完整性，不能保证供应商 exactly-once 计费。

### 步骤 7：最后做真实翻译评测

准备 20 条真实业务文案，分别记录：

```text
源文
目标语言
模型输出
人工是否准确
术语是否正确
占位符是否保留
是否自然
是否需要修改
```

先做人工盲评，再决定是否调整 prompt、模型或术语表。不要用“9/9 结构通过”替代“翻译质量合格”。

## 六节课，覆盖最重要的 80%

### 第一课：从真实业务输入追到导出

目标：知道一个 Key 从哪里来，最后如何变成语言 JSON。

操作：

1. 用 2 个 Key、中文和法语创建任务。
2. 记录 `POST /api/jobs` 返回的 `202` 和任务 ID。
3. 查询 `/api/jobs/:id`、`/api/jobs/:id/items`。
4. 不审核时尝试导出，确认被拒绝。
5. 修改中文结果、审核、导出并刷新页面。

完成标准：能解释“任务创建成功、模型翻译完成、人工审核完成、导出完成”是四个不同事件。

代码路径：`web/api.ts → server/app.ts → server/store.ts → server/worker.ts`。

### 第二课：数据契约和数据库为什么这样设计

目标：理解一条结果为什么按 `(job_id, source_key, language)` 保存。

重点：

- `shared/contracts.ts` 的 TypeBox 运行时校验；
- `translation_jobs`、`translation_results`、`translation_attempts` 的关系；
- 唯一约束、状态字段、`revision`、`approved`、`human_edited`；
- 为什么 API 和数据库都要校验，不能只相信 TypeScript 类型。

练习：改变语言、重复 Key、空文案和非法占位符，观察 400 或 422，并指出是哪一层拒绝的。

完成标准：能画出任务、结果、尝试三张表的关系，并说明每个状态字段由谁更新。

### 第三课：worker、重试和崩溃恢复

目标：理解异步任务系统，而不是只理解 Promise。

重点：

- PostgreSQL advisory lock 为什么限制 worker 所有权；
- claim 时为什么要短事务；
- 等待模型时为什么不能持有数据库事务；
- `attempts`、`next_attempt_at`、错误码和退避如何协同；
- 进程崩溃后为什么可能重复调用模型，不能声称 exactly-once。

练习：运行 `npm run smoke:restart`，再阅读 `server/worker.ts` 的 `recoverInterrupted`、`claimKey` 和 `execute`。

完成标准：能回答“模型已经成功但进程在数据库提交前崩溃，会发生什么”。

### 第四课：模型输出不是可信数据

目标：理解 AI 工程的核心边界：模型是外部不可靠服务。

重点：

- 输出 JSON schema；
- Key 和语言集合校验；
- 缺失语言、重复语言、额外语言；
- 占位符多重集合；
- 术语表；
- 截断、429、鉴权失败和永久错误的分类。

练习：使用 Fake 的 `malformed`、`partial`、`transient` 场景，观察哪些错误重试，哪些错误直接失败。

完成标准：能解释为什么 HTTP 200、合法 JSON 和机械校验通过，都不能单独证明翻译正确。

### 第五课：人工审核、并发冲突和导出门槛

目标：理解 AI 结果如何与人协作。

重点：

- `revision` 的乐观并发控制；
- 人工修改后 `human_edited` 和 `approved` 的保护；
- 晚到模型结果如何被记录为 discarded；
- 为什么只允许“同一语言全部成功且审核后”导出。

练习：在模型请求进行时编辑同一结果，验证人工内容不会被晚到结果覆盖；使用旧 revision 保存，观察 409。

完成标准：能设计一个不会覆盖人工修改的条件 UPDATE。

### 第六课：真实模型评测和面试表达

目标：把工程可靠性和翻译语义质量分开。

准备 20～50 条样本，覆盖：

- 普通 UI 文案；
- 占位符和重复占位符；
- 专有名词和术语；
- 否定句、多义词、长文；
- 数字、日期和长度敏感文案。

每条记录：源文、目标语言、预期语义、模型输出、人工结论、术语结论、格式结论、失败原因和修改结果。

完成标准：能分别报告“结构通过率”和“语义评审结果”，不把 Fake 通过率或 HTTP 成功率说成翻译准确率。

## 最小执行计划

如果每天只有 60～90 分钟：

1. 第 1 天：完成第一课，画出一条请求时序图。
2. 第 2 天：读契约和 SQL，完成第二课实验。
3. 第 3 天：完成 partial、malformed、transient 实验。
4. 第 4 天：完成重启恢复和晚到结果冲突实验。
5. 第 5 天：用 20 条真实样本完成第一版评测表。
6. 第 6 天：写一页 Case Study，回答下面的面试题。

## 面试题清单

1. 为什么创建接口返回 202，而不是等待模型完成？
2. 一个 Key 多语言请求和每语言单独请求如何取舍？
3. 为什么结果按 Key × language 保存，而不是只保存一串模型 JSON？
4. 模型返回 200 后，系统还要校验什么？
5. 某种语言失败时，为什么保留其他语言成功结果？
6. 重试次数如何定义，如何避免多调用一次？
7. 进程崩溃后为什么可能重复计费？
8. advisory lock、行锁和 revision 分别解决什么问题？
9. 如何防止晚到模型结果覆盖人工编辑？
10. 为什么全部翻译成功仍然不能直接导出？
11. 如何评测真实翻译质量？
12. 当前项目和 GoAdmin 真实后台的差异是什么？
13. 如果部署到生产，还缺什么：认证、租户、幂等、限流、监控还是成本预算？

## 暂时不学

暂时跳过 Agent 框架、RAG、MCP、多 Agent、LangGraph 和通用 AI 基础设施。等你能独立完成上述六课，并能解释一次失败的完整因果链，再把其中的 provider、校验、评测和观察能力抽象出去。

# AI Translation Lab

从零学习前端、后端、PostgreSQL、后台任务与 AI 可靠性的独立项目。支持 Fake Translator 和智谱真实翻译。Fake 输出带 `[模拟/语言]` 前缀，只验证系统流程；真实结果也需人工审核。

## 本地启动

使用 Node.js 24。项目绑定本机回环地址，专属数据库端口为 54329。

```bash
cd /Users/lan/Desktop/code/ai-translation-lab
npm ci
# 仅首次配置时执行；已有 .env 时保留其中的配置和密钥。
cp -n .env.example .env
```

数据库选择一种方式，不要同时启动：

```bash
# 常规方式：Docker Desktop 已正常运行时
# 本机 Docker CLI 可能在 /Applications/Docker.app/Contents/Resources/bin/docker
docker compose up -d db

# 没有 Docker daemon 时的本机备用方式：真实 PostgreSQL 17 二进制
npm run db:local
```

`db:local` 使用 npm 安装的 embedded-postgres 包启动真实 PostgreSQL。持久化数据在 `.local/postgres/`，只监听 127.0.0.1；端口占用会退出，不终止已有进程。该包装包是 beta 版本，仅用于本地实验。Compose 使用独立命名卷 `ai-translation-lab_lab_pgdata`，同样不会访问既有数据库。

再打开终端：

```bash
npm run db:migrate
npm run dev:api
```

另一个终端：

```bash
npm run dev:web
```

- 页面：<http://127.0.0.1:5178/>
- API 健康检查：<http://127.0.0.1:4310/api/health>
- OpenAPI / Swagger UI：<http://127.0.0.1:4310/api/docs>

迁移脚本有迁移记录与事务锁，可重复执行。API 启动也会检查迁移。数据库两种启动方式的数据相互独立。不要使用 `docker compose down -v` 或删除本地数据目录来重启项目。

## 验证

数据库需先启动，常规测试会创建唯一 test schema，并只清理自己创建的 schema。不会修改页面上的任务。

```bash
npm run check
# API 和 Vite 均已运行；需要本机 Chrome
npm run smoke
# 用专用 schema、临时 4311 端口及本脚本创建的进程验证崩溃恢复
npm run smoke:restart
```

smoke 只使用隔离浏览器，不加载个人浏览器 profile / 凭据；失败即退出。证据放在 `output/`。`smoke:restart` 强制结束自己的测试 API 进程，验证数据库中途任务恢复；不会停止当前验收服务。

## 可以做什么

输入最多 50 个英文 key/value，选择最多 50 种目标语言，创建任务，查看逐语言状态与错误，人工编辑与审核，按语言导出 JSON。模型请求以 key 为单位：一个 key 一次请求返回全部目标语言，再按语言逐项持久化。任务按结果聚合：全部成功是 `succeeded`，成功与失败并存是 `partial`，全部失败是 `failed`；排队和运行状态单独保留。

Fake 模式的高级实验中的 `normal`、`transient`、`malformed`、`partial` 可观察正常完成、首次网络失败、首次输出类型错误、法语永久失败。每项最多尝试 3 次；只重试失败项；已经人工编辑或审核的结果受到保护。

可填写术语表：

```json
[{ "source": "Nova", "targets": { "zh": "Nova", "fr": "Nova" } }]
```

术语匹配按大小写敏感的字符串包含关系检查，缺少目标语言配置时保留原术语。支持简单 `{name}`、`{{name}}`、`%s`、`%d` 与 `%1$s` 等占位符，连同重复次数必须保持；不支持 ICU plural/select、HTML、自动语言识别或复杂术语词形变化。

## 智谱真实翻译

在后端 `.env` 中配置 `TRANSLATOR_PROVIDER=zhipu` 和 `ZHIPU_API_KEY`；模型由 `ZHIPU_MODEL` 指定，默认 `glm-5.3-flash`。当前本机已配置个人智谱 key。密钥只存在被忽略的 `.env`，不使用 `VITE_` 前缀，不传给浏览器。更改 `.env` 后重新启动 API。

适配器直接使用智谱官方 HTTPS 对话补全 API，无新增 SDK 依赖。请求使用 JSON 输出：5.3 系列按官方要求开启思考并设 `reasoning_effort=low`，4.7 系列关闭思考；超时 60 秒；临时错误最多尝试 3 次，自动重试间隔为 2 秒、4 秒。鉴权、余额和请求参数错误直接失败；模型输出仍须通过 key、语言、占位符和术语校验。页面显示当前 provider 和模型，真实模式只展示术语设置。

`npm run smoke` 使用当前服务：智谱模式验证真实中法翻译、编辑/审核和导出，并保留人工修改前的模型结果；Fake 模式额外验证故障实验。`npm run smoke:restart` 始终在唯一 schema 中使用 Fake，不消耗模型调用。

模型选择、官方标准价与本轮四语言实测见 [模型选择与优化记录](docs/model-selection.md)。重新做比较需要主动授权真实调用：

```bash
# 8 次真实请求：5.3-Flash 与 4.7-Flash，各 4 个相同样例
MODEL_COMPARE_ENABLED=1 npx tsx scripts/compare-models.ts
```

接口参数依据 [智谱对话补全文档](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)。单次样例成功不能代表所有语言的语义准确率。

## 代码阅读顺序

1. `sql/001_initial.sql`：任务、逐语言结果、尝试历史及约束。
2. `shared/contracts.ts`：运行时 schema 与 TypeScript 类型。
3. `server/app.ts` → `store.ts`：HTTP 到 SQL 事务。
4. `server/worker.ts`：领取、执行、重试、恢复与版本保护。
5. `server/providers.ts` → `quality.ts`：供应商边界与输出验收。
6. `web/App.tsx` → `web/api.ts`：轮询、缓存、编辑冲突与导出。
7. `tests/`、`scripts/`：用测试证据检验设计。

设计细节见 [架构说明](docs/architecture.md)，个人学习验收见 [实验手册](docs/learning.md)，真实覆盖见 [验证记录](docs/verification.md)。本轮实际验证见 [2026-10-05 验证报告](docs/verification-2026-10-05.md)，导师式课程安排见 [学习指南](docs/mentor-learning-guide.md)。默认配置仍为 Fake，只有显式配置智谱后才读取密钥并发远程模型请求。

面试中的设计取舍和追问见 [面试材料](docs/interview.md)。当前批量模型请求以 key 为单位：一个 key 一次请求翻译全部所选语言，支持 50 种语言；结果仍按语言逐项持久化。worker 默认同时处理 2 个 key，可配置 1–4。

这是本地单用户实验，不具备生产身份认证、分布式调度、成本预算或线上 SLA。它提供可靠性机制的练习场景，不能代替生产验收或个人能力考核。

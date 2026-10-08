# 当前轮次验证报告

日期：2026-10-05（Asia/Shanghai）。本报告记录本轮实际执行的验证，不把历史 `docs/verification.md` 当作本轮结果。

## 验证环境

- Node.js 24.15.0、npm 11.12.1。
- Docker daemon 不可用，使用项目自带 embedded PostgreSQL，地址为 `127.0.0.1:54329`。
- 数据库是项目专属 `translation_lab`，没有访问公司数据库，也没有删除项目数据。
- 当前没有 `.env`，所以服务使用 Fake provider；本轮没有调用真实模型。

## 实际通过的检查

| 检查                      | 结果 | 证明范围                                                                 |
| ------------------------- | ---- | ------------------------------------------------------------------------ |
| `npm run check`           | 通过 | Prettier、TypeScript、48 个 Vitest 测试、Vite 构建                       |
| `npm run smoke`           | 通过 | 真实浏览器创建任务、异步轮询、审核、导出、刷新持久化、部分成功、失败重试 |
| `npm run smoke:restart`   | 通过 | 实际 SIGKILL 自己启动的 API 后，16/16 结果恢复完成                       |
| 20 Key × 3 语言 HTTP 验证 | 通过 | 真实 HTTP + PostgreSQL 保存 60 条结果，审核中文后导出 20 个 Key          |

20 Key 验证的结果是：60/60 条结果成功、失败 0、每条首次尝试，中文审核 20 条，导出 JSON 的 Key 数为 20。Fake 输出只证明流程和机械契约，不能证明译文语义质量。

## 本轮发现并修正的问题

1. key-level 多语言协议已经替代旧的逐语言 provider，但浏览器 smoke 仍断言旧错误码 `PROVIDER_UNAVAILABLE`。当前 partial 实验实际应显示 `LANGUAGE_MISSING`，已更新 smoke 断言。
2. worker 领取记录时先递增 `attempts`，写回时却使用领取前的计数，导致失败项实际调用 4 次、历史记录从 0 开始。已改为按当前调用次数计算，最多 3 次，尝试历史为 `[1, 2, 3]`，并补充回归断言。

## 当前仍未证明

- 智谱真实模型的语义准确率、自然度和跨语言术语质量。
- GoAdmin Dify workflow 与当前 Zhipu provider 的译文一致性。
- 生产身份认证、多租户、多实例调度、全局限流、供应商计费幂等和公网部署。
- Docker 容器实际启动；本轮只验证了 Compose 工具存在和 embedded PostgreSQL 流程。

## 证据文件

- `output/playwright/smoke.json`
- `output/playwright/zh.json`
- `output/playwright/desktop.png`
- `output/playwright/mobile.png`
- `output/restart-smoke.json`

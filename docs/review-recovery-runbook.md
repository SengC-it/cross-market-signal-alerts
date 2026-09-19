# Review Recovery Runbook

本 runbook 用于处理历史信号和 Paper 运行的复盘积压。复盘恢复只更新 review 字段，不创建新信号、不修改交易策略、不发送交易信号邮件。

## 上线前检查

在生产环境启用前确认：

1. PR 已完成代码审查并部署到 Vercel Production；不要对 Preview URL 做历史回填。
2. Vercel Production 的 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`CRON_SECRET` 已配置，且 GitHub Actions 的 `CRON_SECRET` 与生产一致。
3. `cr_sent_alerts`、`cr_paper_model_runs` 和运行日志表可读写；必要的 review 字段迁移已经完成。
4. 使用受保护的 status 接口确认服务可用，并确认普通 Signal Scanner 的手动运行仍能单独执行。
5. GitHub Actions 使用默认分支上的 `.github/workflows/signal-cron.yml`。每日调度为 `19:30 UTC`，即北京时间次日 `03:30`。

## 首次历史回填

两个脚本默认 dry-run。先执行 dry-run 并保存输出：

```bash
node scripts/backfill-alert-reviews.js
node scripts/backfill-funding-carry-v2-reviews.js
```

确认输出中的 `before`、待复盘原因和最老时间符合预期后，先只处理 20 条：

```bash
CONFIRM_REVIEW_BACKFILL=YES node scripts/backfill-alert-reviews.js --apply --max-records 20
CONFIRM_REVIEW_BACKFILL=YES node scripts/backfill-funding-carry-v2-reviews.js --apply --max-records 20
```

Windows PowerShell 使用：

```powershell
$env:CONFIRM_REVIEW_BACKFILL = "YES"
node scripts/backfill-alert-reviews.js --apply --max-records 20
node scripts/backfill-funding-carry-v2-reviews.js --apply --max-records 20
```

观察 20 条结果和线上状态正常后，再分批执行 100 条，最后才可执行不带 `--max-records` 的全量回填：

```bash
CONFIRM_REVIEW_BACKFILL=YES node scripts/backfill-alert-reviews.js --apply --max-records 100
CONFIRM_REVIEW_BACKFILL=YES node scripts/backfill-funding-carry-v2-reviews.js --apply --max-records 100

CONFIRM_REVIEW_BACKFILL=YES node scripts/backfill-alert-reviews.js --apply
CONFIRM_REVIEW_BACKFILL=YES node scripts/backfill-funding-carry-v2-reviews.js --apply
```

每次执行都检查 `mode`、`recovery.checked`、`reviewed`、`pending`、`failed`、`maxRecords` 和 `truncated`。脚本使用低并发处理（普通信号串行，Paper 最多 2 个并发），不会改变信号生成或邮件逻辑。

`--apply` 没有 `CONFIRM_REVIEW_BACKFILL=YES` 时会停止，并输出：

```text
Refusing to apply review backfill without CONFIRM_REVIEW_BACKFILL=YES
```

## 日常恢复

GitHub Actions 的 scheduled event 每天北京时间 03:30 只执行：

```text
/api/cron?group=review
```

它不会触发普通 Signal Scanner，也不会包含 `--apply`。需要手动运行时，在 Actions 页面选择 `workflow_dispatch`，`job=review` 执行复盘恢复；`job=signal` 才执行原有 Signal Scanner。

恢复结果会记录：

```text
reviewRecovery.ordinarySignals: { checked, reviewed, pending, failed, skippedUntilRetry }
reviewRecovery.paperRuns:      { checked, reviewed, pending, failed, skippedUntilRetry }
reviewRecovery.oldestPendingAt
reviewRecovery.durationMs
reviewRecovery.hasMore: { ordinary, paper }
reviewRecovery.health: healthy | backlog | degraded
```

`healthy` 表示本轮无错误且队列已耗尽；`backlog` 表示时间预算结束但仍有待处理记录，下一次调度继续；`degraded` 表示 Supabase、Binance、复盘或运行日志出现错误。数据错误仍保持 `pending`，沿用 5、15、30、60、120 分钟退避，不删除记录、不把错误伪装成 reviewed。

## 验证与故障处理

首次回填和每日恢复后确认：

- 已复盘数量增加，待复盘数量和 `oldestPendingAt` 按预期变化；
- `failed` 与 `degraded` 时查看错误信息、Supabase 可用性和 Binance 数据源；
- 没有新增交易信号、重复信号或交易信号邮件；
- `data_error` 记录仍为 pending，并等待下一次退避重试；
- `backlog` 可等待下一次 03:30 调度，只有在确认资源和数据源正常后再手动分批回填。

如果出现 `degraded`、异常写入或重复邮件迹象，暂停手动 `--apply`，保留原始 pending 数据，先修复依赖或回滚本次应用版本，再重新执行 dry-run 验证。

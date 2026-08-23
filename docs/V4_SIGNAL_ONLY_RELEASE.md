# V4 SIGNAL-ONLY Production Release

本版本是“合约市场信号提醒与人工决策辅助系统”，不是自动交易系统。

系统只扫描市场、发现机会、生成信号、提供方向/理由/参考价格/风险信息，并通过 Web 和 Email 提醒、记录信号及后续表现。系统不自动开仓、不自动下单、不自动设置仓位、不自动平仓，也不管理真钱账户。

## 生产信号队列

- `TRADE_WATCH`：高质量人工关注信号，可发送 Email + Web；仍需用户自行判断。
- `OBSERVATION`：观察级信号，默认 Web 记录，可通过显式配置选择 Email；明确不代表建议开仓。
- `SHADOW_ONLY`：已知负 edge 或实验策略，只记录，不发送普通交易提醒。
- `RESEARCH_ONLY`：冻结研究候选，只保留研究结果，不进入生产 scanner alert candidates。

动态强势策略可进入 `OBSERVATION` 或现有质量层的 `TRADE_WATCH`，不宣称已验证盈利。动态弱势策略为 `SHADOW_ONLY`。V4-M3.7 三个 `REJECTED_CANDIDATE` family 均为 `RESEARCH_ONLY`。

邮件和页面将参考价、当前价、价格漂移、触发原因、失效条件、历史样本状态和参考 TP/SL 展示为人工决策信息。TP/SL/RR 标记为 `REFERENCE ONLY`，最终是否交易、仓位、止盈止损和平仓均由用户人工决定。

## Release gate

- `autoTrading=false`
- `orderPlacement=false`
- `positionManagement=false`
- 相同 `signalKey` 不重复发送
- 已处理 candle 不重复扫描/发信
- current-price drift guard 开启
- dynamic weakness 不发送普通 production alert
- M3.7 rejected family 不发送 production alert
- 只调用 Binance market-data 读取接口，不调用交易/账户下单路径

正式 Research artifact 冻结在 `15c3cdfe901bdaa633b23f4ba1c67b6f5a492598`；本 release 不重跑研究、不修改策略参数、不进入 M4 及后续 milestone。

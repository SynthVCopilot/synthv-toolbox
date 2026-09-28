# Agent SynthV 操作审批

内置 Agent 通过 `sv_command`、`sv_ui`、`sv_status` 调用 SynthV Bridge。Solo 模式下所有调用直接执行；Edit 模式只对高风险调用要求审批,其余读取、UI 变更照常直接执行。

## 风险判定

判定由桥接组件自身给出（`EmbeddedBridge.classify(name, input)`），Electron 不维护硬编码名单：

| 调用 | risk = high 的条件 |
| --- | --- |
| `sv_command` | action 的命令策略分类为 delete 或 transaction；或参数中 `sharedGroupPolicy` 等价于 allowAllReferences |
| `sv_ui` | 从不为 high |
| `sv_status` | `operation === "reload"` |
| 其余 | 从不为 high |

Edit 模式只拦截 risk = high 的调用。桥接组件自带按整张动作目录遍历的策略测试，新增的破坏性动作若未正确分类会使该测试失败。

## 异步审批流程

调用被拦截时不会阻塞、不会抛错，立即返回：

```json
{ "outcome": "approval_pending", "approvalId": "...", "action": "...", "expiresAtUtc": "..." }
```

桌面 UI 显示审批卡片（工具、action、分类、参数预览、倒计时），Approve/Deny 由用户决定。审批 2 分钟未决定自动过期。批准后由 broker 通过内置 Bridge 执行调用。

每个结果（执行成功/失败、拒绝、过期、取消）只交付给唯一一条通道，不会重复：

- 若有 `sv_await_approval` 正在等待这条结果，直接作为该调用的返回值交付，不再走下面两条路径；
- 否则，若发起会话当前有运行中的回合，作为 steer 消息注入该回合；
- 否则排队，在该会话下一次运行的首轮上下文中一次性交付。

执行失败时交付给模型的是 Bridge 自身的失败信息（`phase`/`wrote`/`undoRequired`/`retry`/`error.code`），不会被重新包装成"未写入"；只有拒绝、过期、取消才使用固定文案。

Agent 可调用 `sv_await_approval({ approvalIds?, timeoutSec? <= 120 })` 等待指定审批或本会话全部待决审批完成或超时；`request_input` 始终可用。等待超时时，仍处于待决或执行中的 id 返回 `{ id, resolution: "pending", expiresAtUtc }`；未知、属于其他会话或已过 5 分钟保留期的 id 返回 `{ id, resolution: "unknown" }`，不会被误报为 pending。已批准但仍在执行中的调用，在完成检查（completion guard）和 `sv_await_approval` 的默认等待列表中都算作待决。

待决审批在运行结束后仍然有效，直到过期；运行结束后被批准的调用照常执行，结果排队给下一次运行。

Stop 会取消该会话全部待决审批（`cancelConversation`），不会执行任何调用。

## 会话记录

设置项 `agentTranscriptsEnabled`（默认关闭）控制 Agent 会话记录是否落盘；关闭时会话只保留在内存中，重启后不可恢复。会话记录可能包含歌词与音符数据，落盘位置为 Pi Agent 目录。

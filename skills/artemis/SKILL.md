---
name: artemis
description: Use when driving a real Android device through the artemis_* tools (dsh-plugin-artemis) — routing a task to Flash or Pro, waiting for an asynchronous ARTEMIS run, reading a trace to explain a failure, and knowing what to do when the environment is not ready
---

# 用 ARTEMIS 驱动安卓设备

这组工具背后不是一个 adb 薄壳，而是 **Google ARTEMIS**：一个自带感知（无障碍树 + OCR + 截图）、规划与校验的移动自动化 agent。你给一句话任务，它自己在手机上分步执行。

## 先分清：什么时候用它

- **用 `artemis_run_task`**：跨多个步骤、需要看懂界面再决定下一步、跨 App、需要重试与恢复的任务（"把设置里的电池页面打开，读电量"、"在微信里给某人发一条指定消息"、"复现这个崩溃前的操作路径"）。
- **不用它**：单点操作（只想点一下、截一张图）用更直接的 adb 工具；纯信息查询也先用 `artemis_device_state`。

## 三个必须记住的约定

1. **`artemis_run_task` 会等**。它内部轮询到任务结束才返回，默认等 120 秒。返回 `status: "running"` 说明只是等超时了，任务**还在跑**：用 `artemis_task` 的 `status`（可以带 `wait_seconds`）去收结果，**不要重新提交**，否则手机会被两个任务抢。
2. **Flash vs Pro 是路由决策，不是偏好**。默认 Flash：路径清晰、确定性高、每步 3–5 秒。遇到探索性、多分支、需要 100+ 步、需要校验清单或书面报告、需要 adb/log 诊断时用 Pro（每步 30 秒左右，慢但更可靠）。
3. **失败先 `artemis_doctor`**。任何 `artemis_*` 报错、任务起不来、找不到设备，先跑诊断；它返回的 `next_steps` 里 `[REQUIRED]` 是阻塞项，`Run:` 开头的命令可以直接执行，`Guidance:` 的需要用户配合。修完再跑一次，直到 `verdict` 是 `ready`。

## 任务描述怎么写

ARTEMIS 只执行一次，描述必须自包含：

- 哪个 App（不确定包名就先 `artemis_device_state` 看前台）；
- 具体做什么，包括必要的输入内容；
- 怎么算成功（"页面上出现 X"、"读到电量数值"）。

反例："看看那个页面"。正例："打开设置 → 电池，读出当前电量百分比并告诉我"。

多设备时显式传 `device_serial`；只有一台设备可以省略。

## 解释失败

任务 `failed` 时按顺序看：

1. `artemis_run_task` / `artemis_task` 返回里的 `error`；
2. `artemis_trace` 的 `view_summary` —— 每一步的思考与动作，通常一眼能看出卡在哪；
3. 需要看某一步到底点了哪里：`view_step_screenshots`（before / overlay / after）；
4. `stderr_log` 路径里的 Python traceback，是真 bug 的证据。

## 安全边界（重要）

ARTEMIS 是一个真的有手有脚的 agent。**付款、下单、删除、注销、给真人发消息**这类不可逆动作，动手前先用 `ask_user_question` 或文字向用户确认，说明你要让它做什么。用户说"只是模拟"时，把任务描述停在提交前的一步，把金额/内容报回来。

不要把 API key 贴进对话：`artemis_doctor` 只报告"哪个 provider 配了"，从不回显密钥。

## 工具速查

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `artemis_run_task` | 派任务并等待 | `task`、`model`、`device_serial`、`wait_seconds` |
| `artemis_task` | 收结果 / 停止 / 中途指导 | `action`、`trace_id`、`instruction`、`release_loop` |
| `artemis_device_state` | 看屏幕（hierarchy 便宜，screenshot 直观） | `view_type`、`device_serial` |
| `artemis_trace` | 回放执行记录 | `action`、`trace_id`、`step_number` |
| `artemis_doctor` | 环境自检与自愈 | `attempt_fix`、`probe_device`、`launch_avd` |

## 一个完整的长任务

```
1. artemis_doctor()                                  // 先确认 ready
2. artemis_device_state({ view_type: "hierarchy" })   // 看看当前在哪个 App
3. artemis_run_task({ task: "打开设置→电池，读出电量", model: "Flash" })
   // 返回 completed + result，或 running + trace_id
4. artemis_task({ action: "status", trace_id, wait_seconds: 180 })   // 若上一步是 running
5. artemis_trace({ action: "view_summary", trace_id })               // 失败或需要证据时
```

# dsh-plugin-artemis

Give [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) a **dedicated Android automation agent**: hand it one natural-language task, and [Google ARTEMIS](https://github.com/google/artemis) — the open-source mobile agent that reports 99%+ on Google Research's AndroidWorld — drives the phone, plans, verifies, and hands back the result, the screenshots and a step-by-step trace.

> 把 Google ARTEMIS 接进 DSH。你说一句话，ARTEMIS 在真机/模拟器上自己分步执行，DSH 拿回结果、截图和执行轨迹。

```
你: 打开设置 → 电池，读出当前电量
DSH → artemis_run_task("打开设置→电池，读出电量")
      └─ ARTEMIS: 截图 → 无障碍树 → 点设置 → 点电池 → 读数值 → 校验
DSH: 电量 53%，共 6 步，用时 41s（trace 可回放）
```

---

## 为什么不是"又一个 adb 工具"

裸 adb 工具（截图 + 点坐标）把"看懂屏幕、决定点哪、点错了怎么办"全丢给主模型，短任务够用，跨 App / 多分支 / 长流程就会飘。ARTEMIS 把这三件事做成了系统：无障碍树 + OCR + 视觉兜底的元素定位、Flash/Pro 两档执行策略、执行前校验、检查点验证、历史压缩与回放。本插件负责把它接进 DSH，并补上**一次调用等到底**的交互。

两者不冲突：轻量点按继续用 adb 工具，需要"交给一个专职司机"时用本插件。

## 前置条件

| 需要 | 说明 |
|---|---|
| ARTEMIS 源码 | `git clone https://github.com/google/artemis.git`，见下方配置 |
| Python 3.12+ 与 [uv](https://docs.astral.sh/uv/) | ARTEMIS 用 uv 管理环境（也支持已装好依赖的 `python -m mcp_server`） |
| adb + 一台安卓设备 | 真机开 USB 调试，或已启动的模拟器（`adb devices -l` 能看到 `device` 状态） |
| 一个模型 key | ARTEMIS 自己调用模型：把 `GEMINI_API_KEY`（或其他 provider）写进 ARTEMIS 的 `.env` |
| Node 20+ | DSH 本身的要求 |

## 安装

已发布到 npm：**[dsh-plugin-artemis@0.1.0](https://www.npmjs.com/package/dsh-plugin-artemis)**

```bash
dsh plugin --profile desktop add dsh-plugin-artemis
```

然后在 DSH 设置页（或 profile 的 `cordis.patch.yml`）把 `artemisPath` 指向 ARTEMIS 源码目录：

```yaml
- insert:
    - id: dsh-artemis
      name: 'dsh-plugin-artemis'
      config:
        artemisPath: 'D:\Projects\artemis'
```

重启后对模型说"用 artemis 看看设备"即可，或者直接调 `artemis_doctor` 验证环境。

## 五个工具

| 工具 | 做什么 | 关键参数 |
|---|---|---|
| `artemis_run_task` | 派任务，**并在同一次调用里等到结束** | `task`、`model`（Flash/Pro）、`device_serial`、`wait_seconds` |
| `artemis_task` | 收结果 / 中止 / 中途指导 | `action`、`trace_id`、`instruction`、`release_loop` |
| `artemis_device_state` | 看设备：`hierarchy` 元素树或 `screenshot` 截图 | `view_type`、`device_serial` |
| `artemis_trace` | 回放：step 摘要、关键词搜索、单步详情、动作叠加图 | `action`、`trace_id`、`step_number` |
| `artemis_doctor` | 环境自检（本地 + ARTEMIS `mobile_diagnose`），可自愈 | `attempt_fix`、`probe_device`、`launch_avd`、`restart_server` |

改完 ARTEMIS 的 `.env` 后，用 `artemis_doctor({ restart_server: true })` 重连即可让新 key 生效——不用重启 DSH。

## 和直接用 ARTEMIS 的 MCP 有什么不同

ARTEMIS 的 MCP 是**异步**的：`mobile_run_task` 立刻返回 `trace_id`，任务在后台跑，规范要求调用方自己设定时器每 1 分钟轮一次状态。这对 IDE 里的人类节奏没问题，但让一个工具调用循环反复轮询很浪费。

本插件把这段补上了：

- `artemis_run_task` 内部轮询 `mobile_manage_task`，默认等 120 秒（可配 `defaultWaitSeconds` / `maxWaitSeconds`），结束就把 `result` / `error` / 断言计数 / 进度一起返回；
- 等超时则返回 `status:"running"` + `trace_id`，模型用 `artemis_task` 继续收，**不会重复提交**；
- 支持 `exec.signal` 取消：用户中断时停止轮询；
- 截图走 DSH 的 attachment store，直接进模型上下文（`file://` URI 由插件读盘后转存）；
- 自带 `skills/artemis/SKILL.md`，安装即生效，教模型 Flash/Pro 路由、等待语义、失败排查顺序和安全边界。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `artemisPath` | `''` | ARTEMIS 源码目录（含 `mcp_server/`、`pyproject.toml`） |
| `command` / `args` | `''` / `[]` | 显式启动命令；留空则按 `uv run artemis mcp` → `python -m mcp_server` 依次尝试 |
| `env` | `{}` | 传给 MCP 服务进程的额外环境变量（例如 `GEMINI_API_KEY`） |
| `defaultModel` | `Flash` | 默认执行档 |
| `defaultDeviceSerial` | `''` | 默认设备 |
| `defaultWaitSeconds` / `maxWaitSeconds` | `120` / `600` | 等待预算 |
| `pollIntervalMs` | `3000` | 轮询间隔 |
| `callTimeoutMs` / `startupTimeoutMs` | `120000` / `180000` | 单次调用 / 首次握手预算（首次 `uv run` 可能建环境） |
| `provideSkill` | `true` | 是否注册自带 skill |

## 排障

1. 任何报错先跑 `artemis_doctor`。它把本地检查（artemisPath、uv、python、adb、`.env` 里的 provider）和 ARTEMIS 自己的诊断合并，`next_steps` 里 `[REQUIRED]` 是阻塞项，`Run:` 可直接执行。
2. 任务起不来但环境显示 ready：`artemis_doctor({ probe_device: true })`，它会真的驱动一次设备（截图 + 层级）。
3. 任务失败：`artemis_trace({ action: "view_summary", trace_id })` 看每步思考与动作；再不行看返回里的 `stderr_log`。

常见问题：

| 现象 | 原因 / 处理 |
|---|---|
| `could not start the ARTEMIS MCP server` | `artemisPath` 没配，或 uv/python 不在 PATH；`artemis_doctor` 会列出每个候选启动器的失败原因 |
| 诊断显示 5/5 ready，任务却报 `Planner requires GOOGLE_API_KEY` | ARTEMIS 的凭证探针会把 `.env` 里**空的 key 行**也算作"已配置"；以 `.env` 里有非空值为准，改完要重启 MCP 服务（本插件在服务进程退出后会自动重启它） |
| 任务 `failed` 但 `error` 是 `null` | ARTEMIS 的前置检查（缺 key、配置非法）把提示打进 `stdout.log`，不写进 `status.json`；插件会把这条提示直接转述给你，或直接看返回里的 `stdout_log` |
| 任务报认证/配额错误 | ARTEMIS 的 `.env` 缺 key 或 key 无效；改完要重启 MCP 服务（重启 DSH 或再次触发连接） |
| 没有可用设备 | 开模拟器，或 `artemis_doctor({ launch_avd: "<avd 名>" })` 让 ARTEMIS 后台启动 |
| 中文输入失败 | Flash 的文本输入走 adb；部分输入法需要 ADBKeyboard 或改用 Pro |

## 已知限制

- **Android only**：ARTEMIS 目前没有 iOS 支持，插件同样没有。
- **成本**：任务由 ARTEMIS 自己的模型驱动，token 花在 ARTEMIS 侧，不在 DSH 侧；Pro 每步约 30 秒。
- **进程生命周期**：插件退出时终止 MCP 服务进程；`uv run` 在 Windows 上是包装进程，极端情况下需要手动结束残留的 python 进程。
- **并发**：一个 DSH profile 共享一个 MCP 服务进程；多设备并发由 ARTEMIS 的设备锁负责，插件不额外排队。

## 已验证

在 Windows 11 + Android 模拟器（`emulator-5556`，Android 13）+ DSH `0.2.1-rc.2` 上实测：

| 项 | 结果 |
|---|---|
| 安装（npm，2026-10-30） | `dsh plugin --profile desktop add dsh-plugin-artemis` 从 registry 拉取 0.1.0，装完 `artemis_*` 工具正常加载 |
| 安装（干净 profile，仅装本包） | `dsh --profile <name> --dump-config` 正确组合出插件行与默认配置 |
| MCP 握手 / 工具发现 | 自动选中 `.venv` 里的 python，5 个工具全部发现 |
| `artemis_device_state` | hierarchy 1522 字符融合树；screenshot 经 attachment 进入模型上下文 |
| `artemis_run_task`（真机） | 华为 BRA-AL00（Android 12）上跑通「设置 → 电池 → 读电量」：**5 步 / 28.1s / completed**，由 DeepSeek 驱动（非 Gemini 配置见下节） |
| `artemis_run_task`（模拟器） | 真实派发、轮询到终态并回传 trace 与日志路径 |
| `artemis_trace` | 真实 trace 返回 ARTEMIS 的 Markdown 执行摘要 |
| 失败路径 | ARTEMIS 缺模型 key 时，错误原文与 `stdout_log` 一并返回，不吞异常 |

## 许可

MIT。ARTEMIS 本体是 Apache-2.0，由 Google 维护，本插件只通过 MCP 调用它，不包含其代码。

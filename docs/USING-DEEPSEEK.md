# 用非 Gemini 的模型（实测 DeepSeek）

本文件只在仓库里维护，不出现在 npm 页面的 README 中。

ARTEMIS 默认按 Gemini 生态调优，官方 99% 的 AndroidWorld 成绩也来自 Gemini（尤其是 `object_detector` 用的 ER 模型）。想换成 OpenAI 兼容的模型（例如 `https://api.deepseek.com` + `deepseek-flash`），要动 `config/artemis.jsonc` 六处，并注意两个坑：

| 位置 | 改成 | 原因 |
|---|---|---|
| `default` | `openai / deepseek-flash` | 全局路由 |
| `nodes.object_detector` | `openai / deepseek-flash` | 没有 ER 模型可用了 |
| `nodes.hopper` | `openai / deepseek-flash` | 否则仍要 Gemini |
| `flash.explorer_mode`、`pro.explorer.mode`、`explorer.default_version` | `"pro"` | `flash` 档直接走 ER 检测器；`pro` 档用多轮 ReAct（UI 树 + 截图）定位 |
| `memory.chunking.model` | `deepseek-flash` | 历史压缩也在调模型 |
| `video_analyzer`（顶层 + `pro`） | `enabled: false` | 录屏分析走 Gemini Files API |

`.env` 里对应设置：

```
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.deepseek.com
```

两个坑（都踩过）：

1. **`agent.flash.step_summarizer` 只接受模型名，内部固定建 Gemini 客户端**。改成非 Gemini 模型名后会报
   `ValidationError: ChatGoogleGenerativeAI ... API key required`，而且报错里带着你填的 DeepSeek 模型名，很容易误判成路由没生效。换非 Gemini 时必须把它 `enabled: false`。
2. **常驻 daemon 用启动时的环境拉起 runner**。改完 `.env` 加 key 后，如果任务走的是 daemon，仍会报缺 key（`status.json` 里 `error` 还是 null，提示在 `stdout.log`）。单机使用建议直接在插件里设 `env: { ARTEMIS_STANDALONE: '1' }` 绕开 daemon，或重启 daemon。

改完全 DeepSeek 后，真机上「设置 → 电池」这类任务约 28 秒、5 步完成；坐标精度低于 Gemini ER 是预期内的，长任务可能需要更多步。

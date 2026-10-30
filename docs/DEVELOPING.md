# 开发与测试

本文件只在仓库里维护，不出现在 npm 页面的 README 中。

```bash
node tests/unit.test.js         # 16 项：协议编解码、配置解析、.env 解析、adb 解析、URI 处理
node tests/integration.test.js  # 10 项：对着一个真实的子进程 MCP 服务（tests/mock-mcp-server.js）
                                # 跑握手、工具发现、任务轮询、等待超时、取消、截图 URI、
                                # 调用超时、服务器崩溃后自动重连
```

集成测试用 `tests/mock-mcp-server.js` 模拟 ARTEMIS 的五个工具，所以不需要设备、不需要 API key 也能验证传输层与轮询逻辑。

代码结构：`lib/index.js`（插件入口）、`lib/mcp-client.js`（stdio JSON-RPC）、`lib/artemis.js`（服务与轮询）、`lib/tools.js`（工具定义）、`lib/doctor.js`（本地自检）、`lib/render.js`（模型可见投影）、`skills/artemis/SKILL.md`（玩法说明）。

## 发布脚本自测

`tests/fake-npm/npm.cmd` 是一个假 npm，用来在没有 registry 的情况下验证 `publish.ps1` 的各条分支（未登录、2FA、E403、成功）：

```bat
set PATH=%CD%\tests\fake-npm;%PATH%
set FAKE_FAIL=otp
publish.cmd -CheckOnly
```

`tests/probe-login.ps1` 单独验证"未登录时不能抛异常"这条不变式。

## 发布

见 [RELEASING.md](./RELEASING.md)。

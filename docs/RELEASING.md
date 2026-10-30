# 发布到 npm（维护者）

本文件只在仓库里维护，不出现在 npm 页面的 README 中。

```bat
REM 双击也可以；不需要 PowerShell 7
publish.cmd                  REM 完整发布：测试 → 打包 → npm login（如需）→ npm publish
publish.cmd -CheckOnly       REM 只跑测试和打包检查，不发布
publish.cmd -Otp 123456      REM 带上 2FA 动态码发布（npm 要求时）
```

Windows 自带 PowerShell（`powershell.exe` 5.1）即可运行；装了 PowerShell 7 也可以用
`powershell -ExecutionPolicy Bypass -File publish.ps1 -CheckOnly`。**不要用 `pwsh`**——它属于 PowerShell 7，Windows 默认没有安装。

脚本会依次跑单测、集成测试、`npm pack --dry-run`，未登录时先 `npm login`，最后 `npm publish`。内部用 `npm.cmd` 而不是 `npm`，因为 Windows 执行策略会拦住 `npm.ps1`。

发布失败时，完整的 npm 输出会写到 `publish.log`，脚本还会按错误码给出结论：`EOTP`（要动态码，用 `-Otp`）、`E403`（包名被占或无权限）、`ENEEDAUTH`（未登录）、`EPUBLISHCONFLICT`（版本已存在）、网络错误。

首次发布须知：

- 需要 npm 账号（https://www.npmjs.com/signup）；
- **npm 对发布强制 2FA**。没开 2FA 会收到 `403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required`，两种解法：
  - **A. 每次带动态码**：`publish.cmd -Otp 123456`（验证器上当前的 6 位，约 30 秒过期，现取现用）；
  - **B. 用可绕过 2FA 的细粒度 token**（适合反复发布）：npmjs.com → Access Tokens → Generate New Token → Granular Access Token，权限选 *Read and write*，勾选 *Bypass 2FA*，然后写进 `%USERPROFILE%\.npmrc`：
    ```
    //registry.npmjs.org/:_authToken=你的token
    ```
    该文件等同于发布权限，别提交到仓库。
- 未登录时脚本会打印 `Not logged in to npm (ENEEDAUTH).` 并自动进入 `npm login`，不需要手动处理；
- 版本号发布后不可覆盖，改代码请先改 `package.json` 的 `version`。

## 已发布记录

| 版本 | 日期 | 说明 |
|---|---|---|
| 0.1.0 | 2026-10-30 | 首个版本：5 个工具、MCP stdio 客户端、DeepSeek 配置实测通过 |
| 0.1.1 | 2026-10-30 | 精简 npm 页面 README；维护类文档移入 `docs/` |

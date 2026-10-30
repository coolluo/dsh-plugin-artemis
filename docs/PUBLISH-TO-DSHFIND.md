# 把 dsh-plugin-artemis 收录进 dshfind

[dshfind](https://dshfind.com) 是 DSH 的社区插件目录。它的收录方式**不是**从 npm 抓包，而是每天定时同步 GitHub 上带 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题的公开仓库。

- 同步时间：每天 **02:17 UTC**（北京时间 10:17）
- 收录延迟：打上话题后约 **1 天**
- 不需要提 issue、不需要 PR

所以前提只有一个：**有一个公开的 GitHub 仓库，并给它加上 `dsh-plugin` 话题**。

---

## 0. 当前状态

| 项 | 状态 |
|---|---|
| npm 包 | ✅ `dsh-plugin-artemis@0.1.0` 已发布（latest） |
| 本地 git 仓库 | ✅ 已 `git init` + 首次提交（`main` 分支） |
| GitHub 远端 | ❌ 还没有 |
| GitHub topic | ❌ 还没加 |

仓库里已排除 `node_modules/`、`*.tgz`、`*.log`、`.env`、`traces/`（见 `.gitignore`），不会误传依赖或密钥。

---

## 1. 创建 GitHub 仓库并推送

### 方式 A：网页创建（不用装工具）

1. 打开 https://github.com/new
2. Repository name 填 `dsh-plugin-artemis`
3. 选 **Public**（私有仓库不会被收录）
4. **不要**勾选 "Add a README file"（本地已有内容，勾了会冲突）
5. Create repository
6. 回到本地执行：

```bat
cd C:\person_project\dsh-plugin-artemis
git remote add origin https://github.com/<你的用户名>/dsh-plugin-artemis.git
git push -u origin main
```

### 方式 B：装了 GitHub CLI 的话

```bat
cd C:\person_project\dsh-plugin-artemis
gh repo create dsh-plugin-artemis --public --source=. --remote=origin --push
```

---

## 2. 加话题（决定能不能被收录）

仓库页面 → 右侧 **About** 旁的齿轮 ⚙ → **Topics** 输入框，添加：

```
dsh-plugin
```

建议一起加这几个，便于分类检索：

```
dsh-plugin  deepseek-harness  artemis  android  mcp  mobile-automation
```

用 gh CLI 的话：

```bat
gh repo edit --add-topic dsh-plugin,deepseek-harness,artemis,android,mcp,mobile-automation
```

> `dsh-plugin` 是**唯一必须**的一个，其余是搜索加分项。

---

## 3. 等同步并验证

第二天北京时间 10:17 之后，访问：

- https://dshfind.com/zh/plugins?q=artemis
- 或直接搜 `artemis`

能搜到即说明收录成功。

**如果两次同步（约 48 小时）后仍然没有**，去 https://github.com/hikariming/dshfind/issues 开一个 issue 说明仓库地址——常见原因是仓库被判定为私有/归档/离题而被过滤。

---

## 4. 可选：让卡片更好看

dshfind 的插件卡片会用到包里的展示元信息（DSH 插件规范里的可选字段）。当前包还没有，加上的话需要发一个 `0.1.1`：

```
dsh-plugin-artemis/
  locale/
    en.json     { "meta": { "title": "ARTEMIS Mobile Agent", "description": "..." } }
    zh.json     { "meta": { "title": "ARTEMIS 手机自动化",   "description": "..." } }
  icon.svg      256 KiB 以内、自包含的 SVG/PNG/JPEG/WebP
```

并在 `package.json` 的 `files` 与 `exports` 里加上 `locale/*.json` 和 `icon`（参照 DSH 插件展示元信息规范）。

不加也能被收录，只是卡片上显示的是 `package.json` 的 description。

---

## 5. 检查清单

- [ ] 仓库是 **public**
- [ ] 已 push 到 `main`
- [ ] 仓库有 `dsh-plugin` topic
- [ ] 仓库根目录有 `README.md`（dshfind 会展示简介）
- [ ] 没有提交 `.env`、token、`node_modules`
- [ ] 等过至少一次 02:17 UTC 同步
- [ ] 搜索 `artemis` 能在 dshfind 插件超市看到

---

## 6. 发布后续版本时

代码改动完成后：

1. 改 `package.json` 的 `version`（如 `0.1.1`）
2. `publish.cmd`（脚本会跑测试、打包、发布；token 权限已配好，`2026-11-29` 到期）
3. `git add -A && git commit -m "chore: 0.1.1" && git push`

dshfind 每天重新同步仓库信息，版本更新不需要重新提交收录。

# GitHub Actions 发布

本项目通过版本标签触发 `.github/workflows/release.yml`，生成供使用方集成的 npm 基座包，并发布到 GitHub Release。不发布到 npm Registry，不连接业务服务器，不需要飞书或模型凭据。

## 触发发布

1. 更新并核对 `package.json`、根 `package-lock.json` 中的版本与 CHANGELOG，提交代码，等待 main 的 CI 通过。
2. 在包含发布工作流的目标提交上创建并推送 `v<版本>` 标签；标签必须与 `package.json` 的版本完全一致。

例如，发布当前 `0.1.0-alpha.3` 版本：

```sh
git tag -a v0.1.0-alpha.3 -m "发布 0.1.0-alpha.3"
git push origin v0.1.0-alpha.3
```

命令由维护者确认目标提交后执行。普通分支推送和 PR 继续走原有 CI，不创建 Release。`alpha`、`beta`、`rc` 等带预发布后缀的版本自动标记为预发布；无后缀版本发布为普通 Release。

## 产物与校验

发布工作流在 Ubuntu 22.04 / Node.js 22.19.0 上安装锁定依赖、运行源码/许可/文档检查和 Node/Python 测试，再执行 `npm pack`。它还会解包检查路径、包版本及飞书 SDK，确认 SDK 不借用构建目录中的依赖。

Release 附件包含：

- `dsh-feishu-<版本>.tgz`：包含 `package/` 根目录、基座源码和打包的飞书 SDK 依赖，不包含完整 DSH runtime。
- `SHA256SUMS`：基座包的 SHA-256，下载两个附件后可执行 `sha256sum --check SHA256SUMS`。

使用方仍需安装与包内 peerDependencies 匹配的 DSH runtime。模型/飞书真实调用、审批和投递不在发布流水线中执行；Linux 测试若因缺少用户 systemd 会话跳过，也不能视作线上验收通过。

`npm run pack:release` 是另一条独立部署包制作路径，会打入完整 Linux runtime，不是本工作流发布的 npm 基座包，两种压缩包不可互换。源码的 `private: true` 保持不变，避免意外执行 npm publish。

## 权限与失败处理

构建 job 只有仓库读取权限；独立发布 job 使用 GitHub 自动提供的 GITHUB_TOKEN，并仅授予 contents: write。仓库或组织策略必须允许该发布权限，无需配置个人访问令牌。

上传完成前 Release 保持草稿，附件上传成功后才公开。工作流不覆盖已有同名 Release 或附件；不要移动已发布标签或重新构建后覆盖同名包。修复应发布新版本。

若首次上传失败并遗留草稿，由维护者检查草稿和附件后决定是否删除草稿，再重跑失败的发布 job，使用原构建产物。中间 Actions artifact 保留 7 天，长期下载使用 Release 附件。

使用方应固定版本、下载位置和 SHA-256；重新构建的同版本包不保证摘要与旧包一致，变更依赖需显式审核，不能自动刷新锁定摘要。

# DSH Feishu

可独立运行的 DSH 飞书/Lark Bot 基座，提供持久化会话、群话题、附件、审批卡片和可选通用飞书工具。

[English](README.md) · [配置](docs/configuration.md) · [扩展](docs/extensions.md) · [运维](docs/operations.md) · [安全边界](SECURITY.md)

## 当前状态

当前源码预览为 `0.1.0-alpha.3`。支持的部署组合为 Ubuntu 22.04 Linux x64、Node.js 22.19+、Python 3.10+、bubblewrap 与用户级 systemd；DSH 固定 `0.2.1-rc.5`，SDK 固定 `1.76.0`。其他系统和架构尚未作为部署目标验证。

默认具备工作区文件读写和隔离 Shell。普通工作区操作无需逐次确认；飞书工具的外部写入通过当前发起人的卡片确认。Shell 网络请求不等同于飞书业务工具审批，共享工作区也不等于多租户文件隔离。浏览器、专用业务流程、身份与内部资料由使用方扩展。

## 从源码构建

先准备 Node.js、Python、bubblewrap、C/C++ 构建工具链和用户 systemd 会话。Ubuntu 系统依赖包括 `build-essential`、`python3`、`pkg-config`、`bubblewrap`。

```sh
git clone https://github.com/ycp424c/dsh-feishu.git
cd dsh-feishu
npm ci --ignore-scripts --legacy-peer-deps
npm --prefix runtime ci
python3 scripts/prepare-runtime.py
python3 scripts/package-release.py
```

runtime 安装使用完整锁文件，并执行固定原生依赖的安装脚本，需在 Linux 运行。不要在 macOS 执行 Linux runtime，也不要只固定 CLI 后重新解析其 RC 依赖。

`dist/release.json` 给出本地构建包和 SHA-256。此源码仓库不代表已发布 npm 包或二进制附件；`private: true` 用于避免误发 npm。

## 配置和安装

在飞书开放平台创建应用、启用机器人、配置长连接消息事件和卡片回调。把 `examples/basic-bot/config.example.json` 复制到仓库外，替换 app ID、同应用下的用户 open ID、模型与 API 地址。权限与可选工具见[配置文档](docs/configuration.md)。

完整可复制的解包、安装和启动命令见[英文 README 的安装段落](README.md#configure-and-install)。安装默认不启动，需私下填写实例 `state/secrets.json` 的飞书与模型凭据，保留 `600` 权限，再运行 doctor 和用户服务。实例数据放在仓库外，不能提交到 Git。

管理 Web 默认只监听回环地址并使用 DSH 鉴权，通过 SSH 隧道访问。登录链接保存在私有 `state/web-login-url`；不要把链接、原始会话或未脱敏日志贴到 issue。

## 能力和限制

- 按应用、聊天和话题隔离持久化会话，支持 `/status`、`/new`、当前发起人的 `/cancel`。
- 接收图片/文件、处理表情、话题续聊、最终回复。图片需要模型支持；普通附件交由工具处理。
- 支持工作区子目录中的脚本与相对文件操作，保持原只读授权，不扩大权限。
- 16 个通用飞书工具按 `toolGroups` 选择；默认示例只启用发文件所需的 `message` 组，其他组按权限开启。
- 写入使用发起人确认、共享回执与回读，状态未知时不自动重试。
- 通过契约版本 1 扩展；必需扩展未就绪时不接收消息，失效后需修复并重启。

基座不自带 Office 解析器、OCR 或音视频转写。应用 scope 与单篇资源权限是不同条件。一个实例对应一个应用；本机占用锁不能检测其他主机的同应用消费者。

## 参与开发

```sh
npm test
python3 -m unittest discover -s test -p '*_test.py'
python3 scripts/license-inventory.py --check
python3 scripts/check-public-source.py --history
python3 scripts/check-doc-links.py
```

部分集成测试依赖 Linux bubblewrap 或用户 systemd 会话，环境不满足时会明确跳过。开发要求见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。

项目自有代码采用 MIT，第三方依赖保留各自许可，不能将全部依赖统称为 MIT。来源、依赖清单和公开检查见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)、[依赖许可](docs/dependency-licenses.md)、[公开审核](docs/open-source-audit.md)。

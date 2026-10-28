# Third-party notices

The root [MIT license](LICENSE) covers this project's original code. It does not replace the licenses of adapted source or installed dependencies.

## Adapted source

| Source | Fixed reference | License and retained notice |
| --- | --- | --- |
| [sugarforever/dsh-lark](https://github.com/sugarforever/dsh-lark) | `155df87e283bfdc90a79fb4ad5debc417cbe9082` | MIT; [LICENSE.upstream](LICENSE.upstream). Session-composition reference and adaptation. |
| [OpenClaw Feishu tools](https://github.com/openclaw/openclaw/tree/v2026.7.1/extensions/feishu) | `@openclaw/feishu@2026.7.1` | MIT; [vendored LICENSE](src/business/vendor/LICENSE), [source hashes](src/business/vendor/SOURCE.json), and the [upstream tag license](https://github.com/openclaw/openclaw/blob/v2026.7.1/LICENSE). |

The adapted workplace-tool regions replace their original runtime/account/media/schema bindings with this project's adapter. This repository does not include the OpenClaw gateway or application identity.

## Host and SDK

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84), fixed DSH `0.2.0-rc.2`: MIT, copyright 2026 DeepSeek. Retained text: [licenses/DeepSeek-MIT.txt](licenses/DeepSeek-MIT.txt). Source and lock provenance: [upstream.lock.json](upstream.lock.json).
- [Feishu Node SDK](https://github.com/larksuite/node-sdk), `@larksuiteoapi/node-sdk@1.74.0`: MIT. Retained text: [licenses/Lark-SDK-MIT.txt](licenses/Lark-SDK-MIT.txt). Its dependencies retain their individual notices.

## Installed and redistributed dependencies

The [generated inventory](docs/dependency-licenses.json) records the licenses declared by the two committed lockfiles, including platform-specific optional packages. Read the [inventory notes](docs/dependency-licenses.md).

The SDK tree includes MIT, BSD-3-Clause, and Apache-2.0 declarations. The host runtime tree additionally includes MPL-2.0, LGPL-3.0-or-later, and other licenses. For example, LibreOffice-kit and libvips components are not relicensed as MIT by this repository.

The Git repository contains source and lock metadata, not installed `node_modules` or generated runtime archives. Offline distributions include third-party code and must retain package LICENSE/NOTICE files and satisfy the relevant source/redistribution requirements. A local build command is not a blanket license clearance for publishing every generated binary artifact.

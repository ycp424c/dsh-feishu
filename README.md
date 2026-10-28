# DSH Feishu

A community DSH integration for Feishu/Lark bots, with durable conversations, group topics, attachments, approval cards, and optional workplace tools.

[简体中文](README.zh-CN.md) · [Configuration](docs/configuration.md) · [Extensions](docs/extensions.md) · [Operations](docs/operations.md) · [Security](SECURITY.md)

## Status and scope

This is an **alpha source preview**. The supported baseline is Ubuntu 22.04, Linux x64, Node.js 22.19+, Python 3.10+, bubblewrap, and user-level systemd. DSH is pinned to `0.2.0-rc.2`; the Feishu SDK is pinned to `1.74.0`. Other operating systems and architectures are not validated deployment targets.

The bot can read and write its workspace and run isolated shell commands by default. It is more than a text chat relay. Generic Feishu tools can be enabled by group; external writes through those tools require the current requester's approval. Browser automation, domain-specific workflows, organization identity, and internal knowledge belong in consumer projects.

One instance serves one Feishu application. A shared workspace is **not** per-user file isolation, and shell network side effects are not automatically converted into Feishu approval cards. See the [trust boundaries](SECURITY.md).

## Build from source on Linux

Prerequisites: Node.js 22.19+, npm, Python 3.10+, a C/C++ build toolchain for native dependencies, bubblewrap, and a working user systemd session. On Ubuntu, the relevant OS packages include `build-essential`, `python3`, `pkg-config`, and `bubblewrap`.

```sh
git clone https://github.com/ycp424c/dsh-feishu.git
cd dsh-feishu
npm ci --ignore-scripts --legacy-peer-deps
npm --prefix runtime ci
python3 scripts/prepare-runtime.py
python3 scripts/package-release.py
```

The runtime install uses its committed lockfile and runs the pinned native packages' installation scripts. Do this on the target Linux platform; do not execute a copied Linux runtime on macOS. Do not replace this step with an unreviewed RC dependency resolution.

`dist/release.json` identifies the resulting archive and SHA-256. There is no published npm package or downloadable binary release implied by this source repository. `package.json` remains private to prevent accidental npm publication.

## Configure and install

1. Create a Feishu/Lark application, enable its bot capability, and configure long-connection message events and interactive-card callbacks.
2. Copy `examples/basic-bot/config.example.json` outside the source checkout. Replace the application ID, allowed sender open IDs, provider, model, and endpoint. Open IDs must belong to the same application.
3. Follow [Configuration](docs/configuration.md) for permissions, group topics, model input types, and optional tool groups.

Install an archive you built and verified:

```sh
export DSH_FEISHU_INSTANCE="$HOME/.local/share/dsh-feishu"
export DSH_FEISHU_CONFIG="$HOME/dsh-feishu-config.json"
export DSH_FEISHU_ARCHIVE="$PWD/dist/$(node -p 'require("./dist/release.json").file')"
export DSH_FEISHU_RELEASE="$(basename "$DSH_FEISHU_ARCHIVE" .tar.gz)"
mkdir -p "$DSH_FEISHU_INSTANCE/releases/$DSH_FEISHU_RELEASE"
# Compare sha256sum output with dist/release.json before extracting.
sha256sum "$DSH_FEISHU_ARCHIVE"
tar -xzf "$DSH_FEISHU_ARCHIVE" -C "$DSH_FEISHU_INSTANCE/releases/$DSH_FEISHU_RELEASE"
python3 "$DSH_FEISHU_INSTANCE/releases/$DSH_FEISHU_RELEASE/scripts/install.py"   --root "$DSH_FEISHU_INSTANCE"   --release "$DSH_FEISHU_INSTANCE/releases/$DSH_FEISHU_RELEASE"   --config "$DSH_FEISHU_CONFIG" --service dsh-feishu
```

Installation does not start the service. Privately fill `state/secrets.json` with `DSH_FEISHU_APP_SECRET` and `DSH_MODEL_API_KEY`; retain mode `600`. Keep instance state outside the source repository. Then:

```sh
node "$DSH_FEISHU_INSTANCE/current/scripts/doctor.mjs" "$DSH_FEISHU_INSTANCE"
systemctl --user enable --now dsh-feishu.service
```

The doctor exercises the configured sandbox, not just its version. Administrator web access is loopback-only by default and uses DSH authentication; use an SSH tunnel. The private login URL is saved in `state/web-login-url`.

## Capabilities

- Durable sessions separated by application, conversation, and topic; `/status`, `/new`, and requester-owned `/cancel`.
- Input images and files, processing reactions, topic replies, and final message delivery. Images require an image-capable model; ordinary files remain raw attachments for the agent's tools to process.
- Workspace file generation and isolated shell commands, including explicit subdirectories and preserved read-only grants.
- Sixteen generic Feishu tools selected through `toolGroups`: documents, wiki, drive, chats/discussions, Bitable, scope diagnostics, messages/media, and minutes.
- Requester-bound approval cards, write receipts, readback, duplicate suppression, and no automatic retry of uncertain writes.
- A versioned extension contract for trusted application code. Required extensions must become ready before channel connection.

There is no built-in Office parser, OCR, or audio transcription service. Resource permissions still apply; an application scope alone does not grant access to every document or recording.

## Development and contribution

After Linux dependencies are prepared:

```sh
npm test
python3 -m unittest discover -s test -p '*_test.py'
python3 scripts/license-inventory.py --check
python3 scripts/check-public-source.py --history
python3 scripts/check-doc-links.py
```

Some integration tests require Linux bubblewrap or an active user systemd session and report skips when unavailable. See [CONTRIBUTING.md](CONTRIBUTING.md) for development requirements and [CHANGELOG.md](CHANGELOG.md) for the public preview.

## License and provenance

Project code is MIT-licensed. Adapted source retains its upstream notices. Runtime dependencies have their own licenses, including MPL/LGPL components; the root MIT license does not relicense them. This Git repository excludes installed dependencies, credentials, state, and generated distributions.

See [LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), the [dependency inventory](docs/dependency-licenses.md), and the [publication audit](docs/open-source-audit.md).

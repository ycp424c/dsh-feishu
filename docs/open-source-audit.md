# Source publication review

Review date: 2026-10-28 (Asia/Shanghai). This review concerns the public Git source/history and documentation, not a binary release or a guarantee against all vulnerabilities.

## Content and history

The reviewed tree contains generic transport, tools, tests, examples, fixed dependency metadata, and project documentation. It excludes consumer business identity/data, application credentials, state, raw conversations, installed dependencies, personal proxy settings, and generated runtime archives. Git content and commit messages are scanned for common credential patterns. The public branch starts at the reviewed snapshot and uses the GitHub noreply identity; earlier local prototype commits are retained locally rather than published.

The checker reports locations/categories without printing suspected secret values. Its regressions cover a credential-shaped fixture, a deleted value remaining in history, and a forced private-state file. Pattern scanning is complemented by manual review of configuration values, source provenance, file lists, and examples; it is not an exhaustive secret-detection guarantee.

## Provenance and licenses

- The retained dsh-lark MIT text matches the fixed upstream commit byte for byte.
- The OpenClaw tool source hashes match its official npm archive. The retained MIT notice matches the official v2026.7.1 source tag; package metadata alone was not used to infer that license.
- The installed Feishu SDK files match the official 1.74.0 archive; registry integrity was verified.
- DeepSeek's MIT text is retained at the fixed source commit. All 737 dependency-lock entries have declared license metadata, including optional/platform-specific packages.
- SDK download locations and integrity metadata were filled from the official registry without changing any of its 52 locked package versions. Host runtime dependency versions and lock digest remain unchanged.

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and the [dependency inventory](dependency-licenses.md). The root MIT license does not replace MPL/LGPL or other dependency terms. This publication contains no installed runtime or binary distribution.

## Documentation and verification

Public documents include English/Chinese entry points, configuration, Linux build/install/operations, the extension contract, contribution guidance, private vulnerability reporting, a changelog, and CI. GitHub CI actions use fixed official commits and read-only repository permissions.

The README sequence was executed in a clean Ubuntu 22.04 Linux x64 directory with Node.js 22.23.1 and Python 3.10.12, separate from any running bot. Both npm installs used the committed locks; dependency directories were not copied from a consumer or prior runtime. Lock bytes were unchanged after installation.

Results before publication:

- 82 JavaScript tests and 13 Python tests passed on Linux, including actual bubblewrap, user-systemd, startup-preflight, and publication-gate regressions.
- Source/history credential-pattern checks, all 737 license inventory entries, and repository-relative documentation links passed.
- Offline packaging and its doctor passed. A newly initialized synthetic host reached ready with Feishu disabled and only the selected message tool, then was stopped.
- No npm package, binary asset, model request, or Feishu message was published by this verification.
 Real model/Feishu credentials and manual message/card/media acceptance are not required by the synthetic source test suite and are not represented as CI proof.

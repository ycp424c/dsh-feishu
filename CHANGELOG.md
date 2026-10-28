# Changelog

## 0.1.0-alpha.2 — 2026-10-28

- Require the current confirmed bot topic ID for implicit group replies; quoting an older bot message in the main chat does not grant topic admission.
- Keep bot topics silent when a message only mentions other members or everyone, while preserving explicit bot mentions and configured mention-free groups.
- Preserve topic ownership only after successful delivery when an explicit bot mention on a main-chat quote creates a new topic.

## 0.1.0-alpha.1 — 2026-10-28

Initial public source preview:

- Durable Feishu/Lark conversations, group topics, attachments, reactions, final delivery, and approval cards.
- Optional generic workplace tools and a trusted extension contract.
- Workspace file/shell execution with private-state masking and preserved subdirectory/read-only behavior.
- Linux installation, actual sandbox preflight, compatible upgrade/rollback, and local channel leases.
- Public contribution/security guidance, upstream notices, dependency inventory, and CI.

This preview does not imply an npm publication, hosted service, or published binary release.

# Changelog

## Unreleased

- Extend native orchestration to shared group topics while retaining per-requester task ownership, private approvals, cancellation, durable origin recovery, and strict topic text/image delivery.
- Keep claimed native input ownership visible during prompt assembly and retain output ownership across image uploads and chunked cancellation, including partial send receipts.
- Extract reusable native main/worker orchestration into an opt-in conversation backend, with generic presets, explicit attachment handoff, internal messaging, cancellation, durable reply receipts, and local image delivery.
- Preserve requester-bound approvals, stable workflow capabilities, child usage metadata, and the existing workspace/shell boundary. Add the public conversation factory contract and independent native session namespace.

## 0.1.0-alpha.3 — 2026-11-02

- Upgrade the pinned DSH runtime and host peers to the official npm `latest`, `0.2.1-rc.5`, and the Feishu SDK to `1.76.0`. Regenerate the runtime lock from the official package graph and refresh provenance and license inventory.
- Constrain the DSH working-directory tool to the business workspace, check relative file/search paths against the effective Session directory with physical symlink/parent traversal, and show that directory on shell approval cards.
- Derive release metadata and compatible-upgrade checks from the declared runtime/contract versions. Reject engine or state-format transitions before accessing a live instance; this release does not authorize an in-place engine migration.

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

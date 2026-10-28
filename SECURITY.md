# Security policy

## Reporting

Report exploitable vulnerabilities through [GitHub private vulnerability reporting](https://github.com/ycp424c/dsh-feishu/security/advisories/new). Do not post credentials, live login URLs, private conversation content, or exploitable details in a public issue. Include the version, supported-platform details, a minimal redacted reproduction, and the affected boundary.

This is an alpha project. Reports are handled on a best-effort basis; there is no response-time or maintenance SLA.

## Trust boundaries

- The host OS account, administrators, model provider, configured extensions, and enabled tools are trusted components. Extensions run in the bot process and can access host services and credentials.
- The default agent can write its workspace and execute shell commands. Treat incoming content and generated code as untrusted. Use a dedicated OS user and workspace for the bot.
- Bubblewrap gives shell subprocesses a restricted filesystem/PID view. Private application state and model/application secrets are excluded from the default child environment. This does not isolate malicious same-process plugins or a compromised host.
- The workspace is shared by admitted users. Topic/session separation does not provide per-user filesystem tenancy. Keep private information out of the shared workspace.
- Feishu workplace writes use requester-bound approval cards. This does not turn every arbitrary shell network request into an approval-controlled operation.
- Application scopes and resource permissions both matter. A trusted sender ID must come from the actual channel, not from instructions inside a message or file.
- Web administration uses DSH authentication and loopback access by default. Local authenticated diagnostics are privileged operator surfaces.
- A local application lease is not a distributed lock. Normal shutdown and controlled recovery matter for single-consumer operation and uncertain external writes.

## Handling private data

Keep `state/`, credentials, sessions, logs, downloaded user content, and generated distributions outside Git. The source `.gitignore` is a convenience, not a data-loss-prevention system. Review staged files and Git history before publication. Rotate any credential that was actually exposed; deleting its current file is not enough to remove history.

## Supported baseline

The public preview is tested on Ubuntu 22.04 Linux x64 with the fixed DSH/SDK versions in the manifests. Other platforms and dependency upgrades need their own validation. See [operations](docs/operations.md) for backups, controlled rollback, and orphan-lease recovery.

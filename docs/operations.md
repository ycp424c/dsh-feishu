# Operations

An instance has `releases/`, an atomic `current` symlink, and private `state/`. Use a distinct instance root and user service for each application. Keep credentials and state outside the source repository.

## Installation and health

Follow [README](../README.md#configure-and-install). Installation initializes files and a user unit without starting it. Configure credentials, then run:

```sh
node "$DSH_FEISHU_INSTANCE/current/scripts/doctor.mjs" "$DSH_FEISHU_INSTANCE"
python3 "$DSH_FEISHU_INSTANCE/current/scripts/host-api.py" "$DSH_FEISHU_INSTANCE"
```

The second command requires a running instance. It reads the private login information locally and prints a health summary, not the login token. The doctor verifies platform, lock digest, credential presence/mode, and actual execution through the configured sandbox runner.

Use `systemctl --user status dsh-feishu.service` and private journal access for diagnosis. Do not attach raw logs or sessions to public issues. A connected channel, a completed model turn, and a delivered message are separate pieces of evidence.

The service uses `KillMode=mixed`: systemd signals the wrapper, which forwards one TERM to DSH. Double signalling can escalate DSH shutdown and skip cleanup. Normal shutdown releases the local application lease.

## Compatible upgrade

Build and verify the new archive, extract it into a new directory directly under the instance's `releases/`, and run its script:

```sh
export DSH_FEISHU_NEXT_RELEASE="$DSH_FEISHU_INSTANCE/releases/REPLACE_WITH_RELEASE_NAME"
python3 "$DSH_FEISHU_NEXT_RELEASE/scripts/upgrade.py"   --root "$DSH_FEISHU_INSTANCE" --release "$DSH_FEISHU_NEXT_RELEASE"
```

The script checks idle state, preserves service configuration, stops the old process, and makes a private backup. With Feishu disabled, it checks an actual model turn and restart continuation, then restores the previous enabled flag. A disabled maintenance instance stays disabled. These probes do not send Feishu messages, but do use your configured model service.

This path supports compatible code updates on the fixed DSH `0.2.0-rc.2` baseline. Engine or state-format changes need a separate migration procedure. Do not re-run initialization over live settings.

## Rollback and uncertain writes

For compatible code rollback, run `rollback.py` with the same arguments, selecting the older release. It repeats the idle/model/restart checks and preserves current compatible state. This is not a general state-format downgrade mechanism.

Preflight failure restores the previous code and service settings. If live traffic might have arrived, automatic recovery retains state and backup for controlled recovery. Restoring a local backup cannot undo an external Feishu write. Inspect receipts and remote documents/records before any replay or state restoration. Old approvals do not remain authorized across processes.

## Single-consumer lease

Within one host user, application/domain hashes identify exclusive channel leases under `~/.local/state/dsh-feishu/locks/`. They do not detect another host or another user. Do not run two consumers for the same application.

Forced termination can leave an orphan lease. Stop the service, inspect its recorded PID, and confirm the process has exited before moving that lease to a private recovery directory. Never automatically delete a lease held by a running process.

## Acceptance

Validate actual private/group input, attachments, local file generation, confirmed/rejected writes, restart continuation, and final delivery. The local authenticated probe deliberately has no trusted Feishu requester, so business writes should be denied there. Real card clicks and final media delivery require real Feishu interaction.

A custom host embedding `createApplication` is responsible for validating its own execution environment before admitting messages; do not treat a transport-only readiness flag as proof that every model/tool integration works.

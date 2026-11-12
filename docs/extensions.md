# Extension contract

Contract version: **1**. Extensions are trusted code in the same process. They can access host services and are not isolated from credentials by this contract.

## Application composition

`createApplication(ctx, config, application)` publishes the shared `dshFeishu` service. Application options include `label`, `version`, `source`, `enabled`, `apiPrefix`, `sessionNamespace`, `requiredExtensions`, `approvalOptions`, `createConversations`, `createOperations`, and `setup`.

```js
import { createApplication, inject as feishuInject } from 'dsh-feishu'
import * as DomainPlugin from './domain.mjs'

export const name = 'my-bot'
export const inject = [...feishuInject]
export async function apply(ctx, config) {
  await createApplication(ctx, config, {
    label: 'My Bot',
    requiredExtensions: ['my-domain'],
    setup() { ctx.plugin(DomainPlugin) },
  })
}
```

A Cordis `apply` returns a supported lifecycle result, not the runtime object. Do not await `runtime.whenReady` inside the host's `apply`; doing so would block a child plugin waiting for that host service. The host publishes services/routes first, and channel startup waits asynchronously for extensions. An external test or operator may await `whenReady` after host activation.

## Readiness and lifecycle

A domain plugin declares `inject = ['dshFeishu', 'tools', ...]`. Its `apply` reads `ctx.dshFeishu`, registers tools and policies through its own `ctx.effect`, then marks its contract ready:

```js
export const name = 'my-domain'
export const inject = ['dshFeishu']
export function apply(ctx) {
  const runtime = ctx.dshFeishu
  ctx.effect(() => runtime.extensions.register(name, 1), 'domain contract')
  // Register the required capabilities and policies before marking ready.
  runtime.extensions.ready(name)
}
```

`extensions.register(id, 1)` returns a disposer; `extensions.ready(id)` marks completion. A missing required extension keeps `status.ready=false`, denies local probes with 503, and prevents channel connection. Losing a required extension cancels work/approvals and suspends the channel. Repair it and restart; re-registering alone does not revive disposed services.

## Shared facilities

The runtime exposes `ctx`, `config`, `bridge`, `approvals`, `operations`, `attachments`, `audit`, `extensions`, `context`, `tools`, `contractVersion`, and `whenReady`.

- `context.forExecution(exec)` resolves the actual running agent turn; do not derive requester identity from model text.
- `tools.register(definition)` uses the host registry. Lifecycle ownership belongs to the extension's effects.
- `operations.registerTool(factory, handler, { before })` adds a domain tool and returns a disposer. Register the matching DSH definition from `operations.definitions()` with the host tool registry. Duplicate names are rejected.
- `operations.registerPolicy(policy)` adds a restriction applied before approval and again before external dispatch.
- `approvals.registerPresenter(toolName, presenter)` customizes a verified card's workflow/detail/button labels; it cannot change the requester or decision.
- `operations.store` exposes the shared ledger's `value` and `save`. Avoid two executors writing the same ledger file.

A custom domain handler is trusted code, not an automatically enforced sandbox. It must implement its own validation and use the shared approved workflow for external writes.

## Approved workflows

`approveWorkflow(request)` returns a runtime-bound capability. Only `decision === 'allowed-once'` gives access to `performWrite`; dispose it in `finally`. `withApprovedWorkflow(request, run)` manages that lifetime. A model-visible `skipApproval` flag is not an authorization mechanism.

Present the full workflow, validate its targets/snapshots/media digests, obtain one approval from the actual requester, and recheck before sending. Persist step receipts and stop on uncertain outcomes. Do not call the SDK directly to bypass the shared ledger, or infer success from an accepted request alone.

Keep instance identity, domain records, skills, migration rules, and other business policy in the consumer repository. Keep transport and generic tools in this project. Custom hosts must also validate their actual sandbox/model environment before message admission.

## Conversation backends

For built-in native main/worker orchestration, set `config.conversationMode = 'orchestrated'`; see [configuration and lifecycle](native-orchestration.md). The default remains `single`.

The normal entry adds native service injection only when this mode is enabled. Custom Cordis plugins that compose the low-level orchestration factories can declare the exported `orchestrationInject` service list. Keep single-agent hosts on `inject` when no native services are loaded.

Trusted hosts may supply `application.createConversations(deps, config, state)`, returning a backend synchronously or asynchronously. The backend implements the exported `ConversationBackend` contract: ingress queues, reply admission, cancel/reset, requester context, running/queue maps, optional deferred `prepare()` and `statusText()`, and disposal. `prepare()` runs after host publication and before channel connection, allowing preset diagnostics without blocking Loader activation.

`deps.sendReply(message, content)` is the audited text/post sink and returns the actual message receipt. `deps.uploadImage(bytes)` returns an uploaded image key. A backend with `managedReplies = true` returns `{ delivery: 'managed', sessionId, provider, model }` from `reply()` and owns later replies; the receiver then sends no second final reply. Keep its own durable send ledger and retain unknown outcomes.

`runningForAgent(agent)` must return a stable execution context for each actual agent turn, including the trusted `senderId`, original `message`, abort `controller`, that agent's `startSeq`, and attested `allowedFiles`. Workflow grants compare context identity before external dispatch. Background children retain their original requester context while unrelated parent messages arrive. Apply the same private boundary and shared approved workflows to child tools. Do not derive identity or attachment grants from model text.

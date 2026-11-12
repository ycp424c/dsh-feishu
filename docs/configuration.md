# Configuration

Keep the input JSON and all instance state outside the Git checkout. Start from [the example](../examples/basic-bot/config.example.json).

## Input fields

| Field | Meaning |
| --- | --- |
| `appId` | Feishu/Lark bot application ID; not an application secret. |
| `dmAllowlist` | Required non-empty array of sender open IDs from this same application. |
| `provider`, `model`, `baseURL` | Your model provider identifier, exact model ID, and OpenAI-compatible endpoint. |
| `api` | Optional DSH provider API type; defaults to `openai-completions`. |
| `input` | Model input modalities, normally `["text"]` or `["text", "image"]`; the model must actually support them. |
| `domain` | `feishu` (default) or `lark`. |
| `contextWindow`, `maxTokens` | Model limits; defaults are 131072 and 8192. Set values supported by your provider. |
| `groupPolicy`, `groupAllowlist` | Groups are disabled by default. Use `allowlist` and explicit chat IDs to enable selected groups. |
| `toolGroups` | Enabled optional tool groups; `[]` disables workplace tools while retaining conversation, files, and shell. |
| `conversationMode` | `single` (default), or `orchestrated` for native main/worker agents. See [native orchestration](native-orchestration.md). |
| `orchestration` | Optional `maxActive` (default 2), `maxRelay` (default 16), and consumer `frontdeskPreset` / `workerPreset` IDs. Native mode currently requires private chats and `maxTurnMs: 0`. |

The example enables only `message`, allowing generated files to be sent through an approval card. Omitted `toolGroups` retains all generic groups for compatibility. Enable only the groups you need.

## Credentials

The installer creates `state/secrets.json` with empty values. Fill these on the server, without putting them into your source tree:

```json
{
  "DSH_FEISHU_APP_SECRET": "REPLACE_WITH_FEISHU_APP_SECRET",
  "DSH_MODEL_API_KEY": "REPLACE_WITH_MODEL_API_KEY"
}
```

Keep mode `600`; the containing state directory is `700`. These are bot/application credentials, not end-user OAuth tokens. The bot operates within its application's scopes and resource access.

## Feishu application setup

Enable the bot capability, publish the application configuration, and use long-connection event delivery. Subscribe to incoming message events (`im.message.receive_v1`) and configure interactive-card actions (`card.action.trigger`) for approvals. The bot also uses message sending, reactions, and message-resource download/upload APIs.

Grant the scopes required by the specific APIs and tool groups you enable. Follow the platform's current [message event documentation](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive) and [long-connection documentation](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode). Feishu and international Lark consoles may present permissions differently.

Implicit continuation requires the current `thread_id` to identify a confirmed bot-created topic. A quoted `root_id` alone does not admit a main-chat reply. With mention-required groups, a message mentioning only other members or everyone stays silent; an explicit bot mention still admits it. Groups configured with `requireMention: false` retain their normal behavior.

Mentioned group messages and all group messages have different permissions. Continuing without another mention in a bot-created topic requires the all-group-message event permission and a published application configuration. It does not grant access to arbitrary groups. Users must be admitted by the instance's allowlist policy.

## Optional groups

| Group | Tools/capabilities |
| --- | --- |
| `doc` | Document read/write and block operations. |
| `wiki` | Spaces, nodes, and wiki operations. |
| `drive` | Drive file and permission operations. |
| `chat` | Chat/member queries and confirmed discussion creation. |
| `bitable` | Base metadata, fields, records, and confirmed changes. |
| `scopes` | Application-scope diagnostics. |
| `message` | Confirmed message, image, and file sending. |
| `minutes` | Minutes metadata and transcript retrieval. |

Scopes do not override individual resource permissions. A recording's export permission may differ from its metadata permission. Unknown or unverifiable write effects retain receipts for manual checking.

## After installation

Initialization refuses to overwrite an existing instance. Edit existing private settings in `state/dsh/profiles/web/cordis.patch.yml` during a controlled, idle maintenance window; it is a DSH profile, not the original input JSON. Preserve unrelated provider and access settings. Restart and check readiness, then test the actual model, tools, approvals, and message delivery.

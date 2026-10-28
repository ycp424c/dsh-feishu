import { hash } from './policy.mjs'

// Same Feishu reaction as OpenClaw's typing indicator. Transport failures must not
// fail an otherwise valid task; retained cleanup records can be retried on restart.
export class TypingIndicators {
  constructor(getClient, state, audit = async () => {}) {
    this.getClient = getClient
    this.state = state
    this.audit = audit
    this.active = new Set()
    this.state.value.typingReactions ??= {}
    this.recovery = Object.entries(this.state.value.typingReactions)
  }
  async record(event, receipt, response) {
    await this.audit(event, { message: receipt, ...(Number.isInteger(response?.code) ? { apiCode: response.code } : {}) }).catch(() => {})
  }
  async remove(receipt, reaction) {
    try {
      const response = await this.getClient().im.v1.messageReaction.delete({ path: { message_id: reaction.messageId, reaction_id: reaction.reactionId } })
      if (response?.code !== 0) { await this.record('typing.remove_failed', receipt, response); return }
      delete this.state.value.typingReactions[receipt]
      await this.state.save()
      await this.record('typing.removed', receipt)
    } catch { await this.record('typing.remove_failed', receipt) }
  }
  start(message) {
    const receipt = hash(message.messageId)
    const ready = (async () => {
      try {
        const response = await this.getClient().im.v1.messageReaction.create({
          path: { message_id: message.messageId },
          data: { reaction_type: { emoji_type: 'Typing' } },
        })
        if (response?.code !== 0 || !response.data?.reaction_id) { await this.record('typing.add_failed', receipt, response); return }
        const reaction = { messageId: message.messageId, reactionId: response.data.reaction_id }
        this.state.value.typingReactions[receipt] = reaction
        // Keep the reaction available to stop() even if saving fails after creation.
        try { await this.state.save() } catch { await this.record('typing.save_failed', receipt) }
        await this.record('typing.added', receipt)
        return reaction
      } catch { await this.record('typing.add_failed', receipt) }
    })()
    let stopping
    const handle = { stop: () => {
      stopping ??= ready.then(async reaction => { if (reaction) await this.remove(receipt, reaction) }).finally(() => this.active.delete(handle))
      return stopping
    } }
    this.active.add(handle)
    return handle
  }
  async recover() {
    const previous = this.recovery
    this.recovery = []
    for (const [receipt, reaction] of previous) await this.remove(receipt, reaction)
  }
  async dispose() { await Promise.allSettled([...this.active].map(handle => handle.stop())) }
}

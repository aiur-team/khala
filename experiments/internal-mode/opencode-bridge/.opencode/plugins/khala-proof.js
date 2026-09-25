/**
 * Throwaway proof that a plugin loaded by a person-started OpenCode TUI can
 * push a Khala-shaped message after a session becomes idle.
 */
export const KhalaProof = async ({ client, directory }) => {
  let delivered = false

  return {
    event: async ({ event }) => {
      if (delivered || event.type !== "session.idle") return

      delivered = true
      await client.tui.appendPrompt({
        body: {
          text: "[Khala message khala-proof-1] Reply with exactly PLUGIN-PUSH-DEEPSEEK-OK.",
        },
        query: { directory },
      })
      await client.tui.submitPrompt({ query: { directory } })
    },
  }
}

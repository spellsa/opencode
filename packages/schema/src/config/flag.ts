export * as ConfigFlag from "./flag.js"

/** The `OPENCODE_FLAGS` entry that turns every flag on, as in `all,-media_blob`. It is not a flag key. */
export const wildcard = "all"

/**
 * Every feature flag, by key, with what it turns on. A flag is on in local and dev builds and off in released ones;
 * `experimental.<key>` in config and `OPENCODE_FLAGS` override that, and `OPENCODE_FLAGS=all` or
 * `experimental.all_flags: true` turn every flag on. Read one with Core's `Flag.enabled("<key>")`.
 */
export const registry = {
  todo: "Enable the experimental todowrite tool.",
  background_compaction:
    "Enable experimental background compaction: summarize the conversation in the background as it nears the compaction threshold, so automatic compaction does not wait for the summary. Background summaries that are never used still cost tokens.",
  media_blob: "Store new session media once in a deduplicated blob table instead of inline in every message row.",
  schedules: "Enable experimental scheduled tasks that wake a session with a prompt.",
  artifacts: "Enable experimental artifacts backed by pluggable providers.",
  service_heartbeat:
    "Enable heartbeat-based confirmation before replacing an unresponsive background service owner.",
  image_read_tool: "Enable the image_read tool, which reads local images as image media.",
  opencode2_autoupdate: "Automatically update standalone OpenCode2 preview builds from new preview releases.",
} as const satisfies Record<string, string>
export type Key = keyof typeof registry

/**
 * Resolve a flag from OPENCODE_FLAGS and the build channel for clients that cannot depend on Core's Config.
 * Explicit entries win over `all`, which wins over the channel default, matching Core's Flag resolver.
 * Config-file overrides are applied by Core on the server side.
 */
export function enabledFromEnv(key: Key, channel: string, overrides = process.env["OPENCODE_FLAGS"]) {
  const entries = (overrides ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  const explicit = entries.findLast((item) => item === key || item === `-${key}`)
  if (explicit !== undefined) return !explicit.startsWith("-")
  if (entries.includes(wildcard)) return true
  return channel === "local" || channel === "dev"
}

import { createMemo } from "solid-js"
import type { SessionInfo } from "@opencode-ai/client"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useRoute } from "../context/route"
import { useData } from "../context/data"
import { Locale } from "../util/locale"
import { withTimestampedFallback } from "@opencode-ai/util/session-title-fallback"

type Entry = {
  value: string
  title: string
  description?: string
  current: boolean
}

function label(session: SessionInfo) {
  const base = withTimestampedFallback(session)
  const match = base.match(/@(\w+) subagent/)
  const agent = session.agent ? Locale.titlecase(session.agent) : match ? Locale.titlecase(match[1]) : undefined
  const name = match ? base.replace(match[0], "").trim() || base : base
  return agent ? `${agent}: ${name}` : name
}

function family(sessions: readonly SessionInfo[], sessionID: string): Array<{ session: SessionInfo; prefix: string }> {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const start = byID.get(sessionID)
  if (!start) return []
  let root = start
  for (;;) {
    const parent = root.parentID ? byID.get(root.parentID) : undefined
    if (!parent) break
    root = parent
  }
  const children = new Map<string, SessionInfo[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const group = children.get(session.parentID)
    if (group) group.push(session)
    else children.set(session.parentID, [session])
  }
  const walk = (parentID: string, indent: string): Array<{ session: SessionInfo; prefix: string }> => {
    const group = children.get(parentID) ?? []
    return group.flatMap((session, index) => {
      const last = index === group.length - 1
      return [
        { session, prefix: `${indent}${last ? "└─ " : "├─ "}` },
        ...walk(session.id, `${indent}${last ? "   " : "│  "}`),
      ]
    })
  }
  return [{ session: root, prefix: "" }, ...walk(root.id, "")]
}

export function DialogSubagents() {
  const dialog = useDialog()
  const route = useRoute()
  const data = useData()

  const currentSessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)

  const options = createMemo<Entry[]>(() => {
    const sessionID = currentSessionID()
    const current = sessionID ? data.session.get(sessionID) : undefined
    if (!current) return []
    return family(data.session.list(), current.id).map(({ session, prefix }) => {
      const status = data.session.status(session.id)
      return {
        value: session.id,
        title: `${prefix}${label(session)}`,
        description: status === "running" ? "Running" : undefined,
        current: session.id === sessionID,
      }
    })
  })

  return (
    <DialogSelect
      title="Subagents"
      current={currentSessionID()}
      options={options()}
      skipFilter
      renderFilter={false}
      onSelect={(option) => {
        route.navigate({ type: "session", sessionID: option.value })
        dialog.clear()
      }}
    />
  )
}

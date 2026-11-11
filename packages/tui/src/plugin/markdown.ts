import { createMarkdownCodeBlockRenderer, type MarkdownCodeBlockRenderer, type MarkdownOptions } from "@opentui/core"
import { isShallowEqual } from "remeda"
import { createMemo } from "solid-js"

export function createMarkdownRenderer(
  sources: () => ReadonlyArray<Readonly<Record<string, MarkdownCodeBlockRenderer>>>,
  math?: () => MarkdownOptions["renderNode"],
) {
  // Changing renderNode makes OpenTUI destroy and rebuild every Markdown block.
  // Only invalidate it when the effective last-wins language handlers change.
  const renderers = createMemo(
    () => Object.fromEntries(sources().flatMap((source) => Object.entries(source))),
    undefined,
    { equals: isShallowEqual },
  )
  return createMemo(() => {
    const fences = Object.keys(renderers()).length === 0 ? undefined : createMarkdownCodeBlockRenderer(renderers())
    const formula = math?.()
    if (!formula) return fences
    return (token, context) => formula(token, context) ?? fences?.(token, context)
  })
}

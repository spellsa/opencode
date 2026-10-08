export * as GoalPlugin from "./goal.js"

import { SystemPart, ToolFailure } from "@opencode-ai/ai"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { SessionExecution } from "../session/execution.js"
import { SessionGoal } from "../session/goal.js"

export const Plugin = define({
  id: "opencode.goal",
  effect: Effect.fn(function* (ctx) {
    const goals = yield* SessionGoal.Service
    const execution = yield* SessionExecution.Service
    yield* ctx.command.transform((editor) =>
      editor.add({
        name: "goal",
        description: "Set a goal, or pause, resume, clear it",
        execute: (input) =>
          Effect.gen(function* () {
            const text = input.prompt.text.trim()
            if (text === "clear") {
              yield* goals.clear(input.sessionID)
              yield* execution.interrupt(input.sessionID)
              return
            }
            if (text === "pause") {
              yield* goals.status(input.sessionID, "paused")
              yield* execution.interrupt(input.sessionID)
              return
            }
            if (text === "resume") yield* goals.status(input.sessionID, "active")
            if (text !== "resume") yield* goals.set(input.sessionID, text)
            yield* execution.wake(input.sessionID)
          }),
      }),
    )
    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const goal = yield* goals.get(event.sessionID)
        if (goal?.status !== "active") return
        event.system.push(SystemPart.make(SessionGoal.continuation(goal.objective)))
      }),
    )
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name: "update_goal",
          description: "Mark the current goal complete after achieving and verifying it.",
          input: Schema.Struct({ status: Schema.Literal("complete") }),
          output: Schema.Struct({ status: Schema.Literal("complete") }),
          options: { codemode: false },
          execute: (input, context) =>
            goals.status(context.sessionID, input.status).pipe(
              Effect.as({ output: { status: "complete" as const }, content: "Goal complete." }),
              Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
})

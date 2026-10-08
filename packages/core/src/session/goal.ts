export * as SessionGoal from "./goal.js"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionGoal } from "@opencode-ai/schema/session-goal"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { SessionEvent } from "./event.js"
import { SessionInbox } from "./inbox.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionTable } from "./sql.js"

export const continuation = (objective: string) => `現在のゴール:
${objective}

このゴールの達成に向けて作業を続けてください。
まずこれまでの作業結果を確認してください。
もしゴールをすべて達成できた場合は、結果を検証して、update_goal({ status: "complete" }) を呼んでください。
そうでない場合は、次に必要な作業を続けてください。`

export class Error extends Schema.TaggedError<Error>()("SessionGoal.Error", { message: Schema.String }) {}

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionGoal.Info | undefined>
  readonly set: (sessionID: SessionSchema.ID, objective: string) => Effect.Effect<void, Error>
  readonly status: (sessionID: SessionSchema.ID, status: SessionGoal.Status) => Effect.Effect<void, Error>
  readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly enqueue: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const inbox = yield* SessionInbox.Service
    const get = Effect.fn("SessionGoal.get")(function* (sessionID: SessionSchema.ID) {
      const row = yield* db
        .select({ goal: SessionTable.goal })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row?.goal ?? undefined
    })
    const cancelPending = Effect.fn("SessionGoal.cancelPending")(function* (sessionID: SessionSchema.ID) {
      const pending = (yield* inbox.list(sessionID)).filter(
        (item) => item.type === "synthetic" && item.payload.metadata?.goalContinuation === true,
      )
      yield* Effect.forEach(
        pending,
        (item) => bus.publish(SessionEvent.InboxCancelled, { sessionID, inboxID: item.id }),
        { discard: true },
      )
    })
    return Service.of({
      get,
      set: (sessionID, objective) =>
        SessionInbox.serialized(
          sessionID,
          Effect.gen(function* () {
            if (!objective.trim()) return yield* new Error({ message: "Goal objective is required" })
            yield* cancelPending(sessionID)
            yield* bus.publish(SessionEvent.GoalSet, { sessionID, objective: objective.trim() })
          }),
        ),
      status: (sessionID, status) =>
        SessionInbox.serialized(
          sessionID,
          Effect.gen(function* () {
            const goal = yield* get(sessionID)
            if (!goal) return yield* new Error({ message: "No goal is set" })
            if (status !== "active") yield* cancelPending(sessionID)
            if (goal.status === status) return
            yield* bus.publish(SessionEvent.GoalStatusChanged, { sessionID, status })
          }),
        ),
      clear: (sessionID) =>
        SessionInbox.serialized(
          sessionID,
          Effect.gen(function* () {
            yield* cancelPending(sessionID)
            yield* bus.publish(SessionEvent.GoalCleared, { sessionID })
          }),
        ),
      enqueue: (sessionID) =>
        SessionInbox.serialized(
          sessionID,
          Effect.gen(function* () {
            const goal = yield* get(sessionID)
            if (goal?.status !== "active" || (yield* SessionInbox.has(db, sessionID, "input"))) return false
            yield* inbox
              .admit({
                sessionID,
                id: SessionMessage.ID.create(),
                item: {
                  type: "synthetic",
                  delivery: "queue",
                  payload: {
                    text: continuation(goal.objective),
                    description: "Goal continuation",
                    metadata: { goalContinuation: true },
                  },
                },
              })
              .pipe(Effect.orDie)
            return true
          }),
        ),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node, SessionInbox.node] })

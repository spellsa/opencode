export * as SessionGoal from "./session-goal.js"

import { Schema } from "effect"

export const Status = Schema.Literals(["active", "paused", "complete"])
export type Status = typeof Status.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  objective: Schema.String.check(Schema.isMinLength(1)),
  status: Status,
}).annotate({ identifier: "Session.Goal" })

import { Service, type Endpoint, type EnsureOptions } from "@opencode/client/effect/service"
import { ClientError, isUnauthorizedError, OpenCode } from "@opencode/client/promise"
import { OPENCODE_VERSION } from "../version"
import { Effect, Option, Redacted, Schedule } from "effect"
import { isIP } from "node:net"
import { Server as ServerFlag, Standalone as StandaloneFlag } from "../commands/commands"
import { Env } from "../env"
import { ServiceConfig } from "./service-config"
import { Standalone } from "./standalone"
import { errorMessage } from "../util/error"

export type Args = {
  readonly server?: string
  readonly standalone?: boolean
  readonly mismatch?: "replace" | "ignore" | "error"
  /** Start the background service when none is running. When false, use a standalone server instead. */
  readonly autostart?: boolean
  readonly onStart?: EnsureOptions["onStart"]
}

export type Resolved = {
  readonly endpoint: Endpoint
  readonly service?: ReturnType<typeof managedService>
  /** A private server started for this command alone. */
  readonly standalone?: boolean
}

export const resolve = Effect.fn("cli.server-connection.resolve")(function* (args: Args = {}) {
  const serverFlag = yield* Effect.serviceOption(ServerFlag).pipe(Effect.map(Option.flatten))
  const standaloneFlag = yield* Effect.serviceOption(StandaloneFlag)
  const server = args.server ?? Option.getOrUndefined(serverFlag)
  const standalone = args.standalone ?? Option.getOrElse(standaloneFlag, () => false)
  if (server !== undefined && standalone)
    return yield* Effect.fail(new Error("--server and --standalone cannot be combined"))
  if (server !== undefined) {
    const environmentPassword = yield* Env.password
    // An explicit local server may still be the managed one. Reuse the persisted service password
    // when the environment does not provide one, so `--server http://127.0.0.1:...` does not fail
    // with "requires a password" just because the caller omitted the variable. Never send that
    // local secret to a remote host.
    const password =
      environmentPassword !== undefined
        ? Redacted.value(environmentPassword)
        : isLoopback(server)
          ? (yield* ServiceConfig.read()).password
          : undefined
    const endpoint = {
      url: server,
      auth: password ? { type: "basic" as const, username: "opencode", password } : undefined,
    } satisfies Endpoint
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const health = yield* Effect.tryPromise({
      try: () => client.server.info({ signal: AbortSignal.timeout(10_000) }),
      catch: (cause) => cause,
    }).pipe(
      // A starting service can answer /api/info with 503 and a timeout while it boots. Retry only
      // those ambiguous outcomes; an unreachable port or a rejected credential should fail now.
      Effect.retry({
        while: retryableServerStart,
        schedule: Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: 30_000 })),
      }),
      Effect.mapError((cause) => connectError(endpoint, cause)),
    )
    if (health.version !== OPENCODE_VERSION)
      process.stderr.write(
        `Warning: Server at ${endpoint.url} has version ${health.version}; this client is ${OPENCODE_VERSION}. Continuing anyway.\n`,
      )
    return { endpoint } satisfies Resolved
  }
  if (standalone || (yield* ServiceConfig.read()).disabled === true) {
    return { endpoint: yield* Standalone.start(), standalone: true } satisfies Resolved
  }

  const mismatch = args.mismatch ?? "ignore"
  const options = yield* ServiceConfig.options({ checkVersion: mismatch !== "ignore" })
  if (args.autostart === false) {
    const endpoint = yield* Service.discover({ ...options, version: undefined })
    if (!endpoint) return { endpoint: yield* Standalone.start(), standalone: true } satisfies Resolved
    return { endpoint, service: managedService(options) } satisfies Resolved
  }
  return {
    endpoint: yield* resolveManaged({ ...options, onStart: args.onStart }, mismatch),
    service: managedService(options),
  } satisfies Resolved
})

function managedService(options: EnsureOptions) {
  const reconnectOptions = { ...options, version: undefined }
  return {
    reconnect: () => Service.ensure(reconnectOptions),
    restart: () =>
      Effect.gen(function* () {
        yield* Service.stop({ file: options.file, pty: "handoff" })
        yield* Service.ensure(reconnectOptions)
      }),
  }
}

export const shutdownPersistentPty = Effect.fn("cli.server-connection.shutdown-persistent-pty")(function* (
  options: EnsureOptions,
) {
  const endpoint = yield* Service.discover({ ...options, version: undefined })
  if (!endpoint) return
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  yield* Effect.tryPromise(() => client.experimental.persistentPty.shutdown())
})

const resolveManaged = Effect.fnUntraced(function* (options: EnsureOptions, mismatch: NonNullable<Args["mismatch"]>) {
  if (mismatch === "replace") return yield* Service.ensure(options)
  if (mismatch === "ignore") return yield* Service.ensure({ ...options, version: undefined })

  const compatible = yield* Service.discover(options)
  if (compatible !== undefined) return compatible
  const existing = yield* Service.discover({ ...options, version: undefined })
  if (existing !== undefined)
    return yield* Effect.fail(new Error("Background server version does not match this client"))
  return yield* Service.ensure(options)
})

function isLoopback(server: string) {
  const hostname = URL.parse(server)?.hostname.toLowerCase()
  if (hostname === undefined) return false
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true
  return isIP(hostname) === 4 && hostname.startsWith("127.")
}

function retryableServerStart(cause: unknown) {
  if (isUnauthorizedError(cause)) return false
  if (cause instanceof ClientError) {
    if (cause.reason === "UnexpectedStatus") return statusOf(cause.cause) === 503
    if (cause.reason === "Transport") return isTimeout(cause.cause)
    return false
  }
  return isTimeout(cause)
}

function statusOf(value: unknown) {
  if (typeof value !== "object" || value === null || !("status" in value)) return undefined
  return typeof value.status === "number" ? value.status : undefined
}

function isTimeout(value: unknown, depth = 0): boolean {
  if (depth > 4 || typeof value !== "object" || value === null) return false
  if ("name" in value && (value.name === "TimeoutError" || value.name === "AbortError")) return true
  return "cause" in value && isTimeout(value.cause, depth + 1)
}

function connectError(endpoint: Endpoint, cause: unknown) {
  if (isUnauthorizedError(cause)) {
    return new Error(
      endpoint.auth === undefined
        ? `Server at ${endpoint.url} requires a password; set OPENCODE_PASSWORD`
        : `Server at ${endpoint.url} rejected the password`,
      { cause },
    )
  }
  if (cause instanceof ClientError && cause.reason === "Transport")
    return new Error(`Could not reach server at ${endpoint.url}: ${errorMessage(cause.cause ?? cause)}`, { cause })
  return new Error(
    `Server at ${endpoint.url} did not provide a compatible V2 health response: ${errorMessage(cause)}`,
    { cause },
  )
}

export * as ServerConnection from "./server-connection"

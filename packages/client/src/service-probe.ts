import { homedir } from "node:os"
import { join } from "node:path"
import type { DiscoverOptions, Endpoint, Info } from "./service.js"
import { defaultEnsureTiming } from "./service-timing.js"
import { matchesVersion } from "./service-version.js"

// Shared by the Effect and Promise clients. Keep this module free of Effect so the
// Promise client never loads the Effect runtime.

export type LocalService = {
  readonly info: Info
  readonly endpoint: Endpoint
  readonly version?: string
  readonly state: "ready" | "waiting" | "failed"
  readonly compatible: boolean
}

/**
 * What `ensure()` does with a registered service that answered: return it, keep polling while
 * it starts, replace it because its version does not meet the requirement, or fail.
 */
export function decide(service: LocalService, options: DiscoverOptions) {
  if (!matchesVersion(service.version, options))
    return { _tag: "replace", pty: service.state === "ready" ? "handoff" : "clear" } as const
  if (!service.compatible)
    return fail(
      "Background service uses an incompatible health protocol. Update this client or explicitly restart the service.",
    )
  if (service.state === "ready") return { _tag: "reuse" } as const
  if (service.state === "failed") return fail("Background service failed to start")
  return { _tag: "wait" } as const
}

function fail(message: string) {
  return { _tag: "fail" as const, error: new Error(message) }
}

/** The default registration file. */
export function fallback() {
  return join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "opencode", "service.json")
}

/** Whether two registrations describe the same service instance. */
export function same(left: Info, right: Info) {
  return left.id === right.id && left.version === right.version && left.url === right.url && left.pid === right.pid
}

/** Whether the owner published a heartbeat recently enough to prove its event loop is alive. */
export function heartbeatFresh(info: Info, timeout = defaultEnsureTiming.heartbeatTimeout) {
  return info.heartbeat !== undefined && Date.now() - info.heartbeat <= timeout
}

/**
 * Decide whether a health-probe timeout is enough evidence to terminate the owner.
 *
 * A timed-out probe only proves that one request was slow. Before treating it as a dead service,
 * require that the process is gone, or that its registration heartbeat is stale and a much longer
 * probe still gets no answer. This keeps a busy but healthy owner from being killed by each client.
 */
export async function shouldTerminateUnresponsive(info: Info, timing = defaultEnsureTiming) {
  if (!processAlive(info.pid)) return true
  if (heartbeatFresh(info, timing.heartbeatTimeout)) return false
  if ((await probeResult(info, timing.unresponsiveTimeout)).service !== undefined) return false
  return true
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const slowOwnerWarnings = new Set<string>()

/** Emit the "slow but still alive" warning at most once per registration file per process. */
export function warnSlowOwnerOnce(file: string) {
  if (slowOwnerWarnings.has(file)) return false
  slowOwnerWarnings.add(file)
  return true
}

/** Ask a registered owner for its health and classify the answer. */
export async function probeResult(info: Info, timeout = defaultEnsureTiming.requestTimeout) {
  const endpoint = {
    url: info.url,
    auth: info.password === undefined ? undefined : { type: "basic", username: "opencode", password: info.password },
  } satisfies Endpoint
  const signal = AbortSignal.timeout(timeout)
  const result = await fetch(new URL("/api/info", info.url), { headers: headers(endpoint), signal })
    .then(async (response) => ({
      response,
      body: response.status === 404 ? undefined : ((await response.json()) as unknown),
    }))
    .catch(() => undefined)
  if (result === undefined) return { service: undefined, timedOut: signal.aborted }
  const response = result.response
  // A missing health endpoint identifies protocol incompatibility, not an older
  // version. Only an unmet version requirement lets ensure replace this owner.
  if (response.status === 404)
    return {
      service: {
        info,
        endpoint,
        version: info.version,
        state: "ready",
        compatible: false,
      } satisfies LocalService,
      timedOut: false,
    }
  const serverInfo = decodeInfo(result.body)
  if (serverInfo === undefined) return { service: undefined, timedOut: false }
  if (serverInfo.pid !== info.pid) return { service: undefined, timedOut: false }
  if (info.version !== undefined && serverInfo.version !== info.version) return { service: undefined, timedOut: false }
  return {
    service: {
      info,
      endpoint,
      version: serverInfo.version,
      state: response.ok ? "ready" : response.status === 500 ? "failed" : "waiting",
      compatible: true,
    } satisfies LocalService,
    timedOut: false,
  }
}

/** Create HTTP authentication headers for a service endpoint. */
export function headers(endpoint: Endpoint) {
  if (endpoint.auth === undefined) return undefined
  return {
    authorization: "Basic " + Buffer.from(endpoint.auth.username + ":" + endpoint.auth.password).toString("base64"),
  }
}

function decodeInfo(input: unknown) {
  if (typeof input !== "object" || input === null) return
  if (!("version" in input) || typeof input.version !== "string") return
  if (!("pid" in input) || typeof input.pid !== "number" || !Number.isInteger(input.pid) || input.pid < 0) return
  return { version: input.version, pid: input.pid }
}

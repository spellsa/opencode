export * as PreviewUpdater from "./preview-updater"

import { ConfigFlag } from "@opencode/schema/config/flag"
import { Global } from "@opencode/util/global"
import { EffectFlock } from "@opencode/util/effect-flock"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { OPENCODE_CHANNEL, OPENCODE_COMMIT, OPENCODE_LOCAL, OPENCODE_VERSION } from "../version"
import { Updater } from "./updater"

const repository = "spellsa/opencode"
const releasesUrl = `https://api.github.com/repos/${repository}/releases?per_page=10`
const tagPattern = /^preview-([0-9a-f]+)$/

const Release = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(Schema.Struct({ name: Schema.String, browser_download_url: Schema.String })),
})
const Releases = Schema.Array(Release)
type Release = typeof Release.Type
type Releases = typeof Releases.Type

export interface Candidate {
  readonly tag: string
  readonly commit: string
  readonly archive: string
  readonly checksum: string
}

/** The archive name published by .github/workflows/build-custom.yml for a given runner. */
export function platformAsset(platform = process.platform, arch = process.arch) {
  const os =
    platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform === "linux" ? "linux" : undefined
  if (os === undefined || (arch !== "x64" && arch !== "arm64")) return
  // The custom build matrix does not publish a Windows ARM binary.
  if (os === "windows" && arch === "arm64") return
  return `${os}-${arch}`
}

export function archiveName(platform = process.platform, arch = process.arch) {
  const asset = platformAsset(platform, arch)
  return asset ? `opencode2-${asset}.tar.gz` : undefined
}

/** Pick the newest preview release that has both an archive and a checksum for this runner. */
export function findCandidate(releases: Releases, platform = process.platform, arch = process.arch) {
  const name = archiveName(platform, arch)
  if (!name) return
  for (const release of releases) {
    const commit = tagPattern.exec(release.tag_name)?.[1]
    const archive = release.assets.find((item) => item.name === name)
    const checksum = release.assets.find((item) => item.name === `${name}.sha256`)
    if (!commit || !archive || !checksum) continue
    return {
      tag: release.tag_name,
      commit,
      archive: archive.browser_download_url,
      checksum: checksum.browser_download_url,
    } satisfies Candidate
  }
}

/** Preview tags carry commit prefixes, so compare those instead of parsing them as semver. */
export function isNewer(current: string, candidate: Candidate) {
  const known = current.toLowerCase()
  return known !== candidate.commit && !candidate.commit.startsWith(known) && !known.startsWith(candidate.commit)
}

export function verifyChecksum(bytes: Uint8Array, checksum: string, name: string) {
  const digest = createHash("sha256").update(bytes).digest("hex")
  const text = checksum.trim()
  if (/^[0-9a-f]{64}$/i.test(text)) return digest === text.toLowerCase()
  const match = /^([0-9a-f]{64})\s+\*?(.+)$/im.exec(text)
  if (!match || path.basename(match[2].trim()) !== name) return false
  return digest === match[1].toLowerCase()
}

/** Replace the running binary. Windows allows renaming a running image but not removing its last link. */
export async function replaceExecutable(target: string, source: string, platform = process.platform) {
  const backup = `${target}.old`
  if (platform !== "win32") {
    await fs.chmod(source, 0o755)
    await fs.rename(source, target)
    return
  }
  // A previous run may have failed to delete this link while the image was still running.
  await fs.rm(backup, { force: true })
  await fs.rename(target, backup)
  try {
    await fs.rename(source, target)
  } catch (error) {
    await fs.rename(backup, target)
    throw error
  }
  await fs.rm(backup, { force: true }).catch(() => {})
}

async function locateBinary(directory: string, depth = 0): Promise<string | undefined> {
  if (depth > 4) return
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const found = await locateBinary(target, depth + 1)
      if (found) return found
    }
    if (entry.isFile() && (entry.name === "opencode" || entry.name === "opencode.exe")) return target
  }
}

const runtime = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase()
const override = process.env["OPENCODE2_AUTOUPDATE"]
const flag = ConfigFlag.enabledFromEnv("opencode2_autoupdate", "dev")

/**
 * Only a standalone preview binary can replace itself. The preview channel is a rolling dev channel,
 * so the flag is on there unless OPENCODE_FLAGS opts out, and OPENCODE2_AUTOUPDATE is an explicit switch.
 */
export const applicable =
  !OPENCODE_LOCAL &&
  OPENCODE_CHANNEL === "v2-custom" &&
  !["bun", "node", "nodejs"].includes(runtime) &&
  platformAsset() !== undefined &&
  !["0", "false"].includes((process.env["OPENCODE_DISABLE_AUTOUPDATE"] ?? "").toLowerCase()) &&
  (override === undefined ? flag : !["0", "false"].includes(override.toLowerCase()))

const failure = (title: string, detail: string, retry: string) => new Updater.UpgradeError({ title, detail, retry })

const make = Effect.gen(function* () {
  const filesystem = yield* FileSystem.FileSystem
  const global = yield* Global.Service
  const flock = yield* EffectFlock.Service
  let notified: string | undefined
  const executable = yield* filesystem.realPath(process.execPath).pipe(Effect.orElseSucceed(() => process.execPath))

  yield* Effect.promise(() => fs.rm(`${executable}.old`, { force: true })).pipe(Effect.ignore)

  const fetchBytes = (url: string) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
          headers: { "User-Agent": `opencode/${OPENCODE_CHANNEL}/${OPENCODE_VERSION}` },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return new Uint8Array(await response.arrayBuffer())
      },
      catch: (cause) =>
        failure(
          "Could not download the OpenCode2 update",
          cause instanceof Error ? cause.message : String(cause),
          "Check your network, then try again.",
        ),
    })

  const fetchReleases = Effect.gen(function* () {
    const bytes = yield* fetchBytes(releasesUrl)
    const data: unknown = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(bytes)),
      catch: () =>
        failure("Could not read preview releases", "GitHub returned invalid JSON.", "Try again in a few minutes."),
    })
    return yield* Schema.decodeUnknownEffect(Releases)(data).pipe(
      Effect.mapError(() =>
        failure(
          "Could not read preview releases",
          "GitHub returned an unexpected release list.",
          "Try again in a few minutes.",
        ),
      ),
    )
  })

  const candidate = () =>
    Effect.gen(function* () {
      if (!applicable) return
      const found = findCandidate(yield* fetchReleases)
      return found && isNewer(OPENCODE_COMMIT, found) ? found : undefined
    })

  const readPolicy = () =>
    Effect.gen(function* () {
      const values = yield* Effect.forEach(["config.json", "opencode.json", "opencode.jsonc"], (name) =>
        filesystem.readFileString(path.join(global.config, name)).pipe(
          Effect.map(Updater.decodePolicy),
          Effect.orElseSucceed(() => undefined),
        ),
      )
      return values.findLast((value) => value !== undefined) ?? "auto"
    })

  const install = (found: Candidate) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          filesystem.makeTempDirectory({ directory: global.cache, prefix: "opencode2-update-" }),
          (value) => filesystem.remove(value, { recursive: true, force: true }).pipe(Effect.ignore),
        )
        const name = archiveName()
        if (!name)
          return yield* Effect.fail(
            failure(
              "No OpenCode2 update is available",
              "This platform has no published archive.",
              "Use a supported platform build.",
            ),
          )
        const archiveBytes = yield* fetchBytes(found.archive)
        const checksumBytes = yield* fetchBytes(found.checksum)
        if (!verifyChecksum(archiveBytes, new TextDecoder().decode(checksumBytes), name))
          return yield* Effect.fail(
            failure(
              "Could not verify the OpenCode2 update",
              `The checksum for ${name} did not match.`,
              "Try again in a few minutes.",
            ),
          )
        const archive = path.join(directory, name)
        yield* filesystem.writeFile(archive, archiveBytes)
        yield* Effect.tryPromise({
          try: async (signal) => {
            const child = Bun.spawn(["tar", "-xzf", archive, "-C", directory], {
              stdout: "ignore",
              stderr: "pipe",
              signal,
            })
            const code = await child.exited
            if (code !== 0) throw new Error(await new Response(child.stderr).text())
          },
          catch: (cause) =>
            failure(
              "Could not extract the OpenCode2 update",
              cause instanceof Error ? cause.message : String(cause),
              "Try again in a few minutes.",
            ),
        })
        const binary = yield* Effect.tryPromise({
          try: () => locateBinary(directory),
          catch: (cause) =>
            failure(
              "Could not find the updated binary",
              cause instanceof Error ? cause.message : String(cause),
              "Try again in a few minutes.",
            ),
        })
        if (!binary)
          return yield* Effect.fail(
            failure(
              "Could not find the updated binary",
              `The archive ${name} has no opencode executable.`,
              "Try again in a few minutes.",
            ),
          )
        yield* Effect.tryPromise({
          try: () => replaceExecutable(executable, binary),
          catch: (cause) =>
            failure(
              "Could not replace the OpenCode2 binary",
              cause instanceof Error ? cause.message : String(cause),
              "Check file permissions, then run opencode upgrade again.",
            ),
        })
        yield* Effect.logInfo("installed OpenCode2 preview update", { from: OPENCODE_COMMIT, to: found.tag })
      }),
    )

  const latest = () =>
    candidate().pipe(
      Effect.flatMap((found) =>
        found
          ? Effect.succeed(found.tag)
          : Effect.fail(
              failure(
                "No OpenCode2 update is available",
                "No preview release for this platform was found.",
                "Check the releases page later.",
              ),
            ),
      ),
    )

  const apply = Effect.fn("cli.preview-updater.apply")(function* (version: string) {
    const tag = version.trim().replace(/^v/, "")
    const found = findCandidate(yield* fetchReleases)
    if (found?.tag !== tag)
      return yield* Effect.fail(
        failure(
          "Could not find the OpenCode2 update",
          `Preview release ${version} was not found.`,
          "Run opencode upgrade without a version.",
        ),
      )
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* flock.acquire("cli-upgrade", undefined, { timeoutMs: 300_000 })
        yield* install(found)
      }),
    )
  })

  const check = Effect.fn("cli.preview-updater.check")(function* () {
    if (!applicable)
      return {
        type: "unavailable" as const,
        message: "Auto-update is only available in standalone OpenCode2 preview builds.",
      }
    const found = findCandidate(yield* fetchReleases)
    if (!found)
      return {
        type: "unavailable" as const,
        message: "No preview release with an archive for this platform was found.",
      }
    if (!isNewer(OPENCODE_COMMIT, found)) return undefined
    return { type: "available" as const, version: found.tag }
  })

  const run = Effect.fn("cli.preview-updater.run")(
    function* (onInstall: (version: string) => void = () => {}) {
      if (!applicable) return undefined
      const found = yield* candidate().pipe(
        Effect.catch((error) =>
          Effect.logWarning("OpenCode2 update check failed", { error }).pipe(Effect.as(undefined)),
        ),
      )
      if (!found) return undefined
      const policy = yield* readPolicy()
      if (policy === "disable") return undefined
      if (policy === "notify") {
        if (notified !== found.tag) {
          notified = found.tag
          yield* Effect.logInfo("OpenCode2 update available", { latest: found.tag })
        }
        return { type: "available" as const, version: found.tag }
      }
      onInstall(found.tag)
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* flock.acquire("cli-upgrade", undefined, { timeoutMs: 300_000 })
          yield* install(found)
        }),
      )
      return { type: "installed" as const, version: found.tag }
    },
    Effect.catch((error) => Effect.logWarning("OpenCode2 update failed", { error }).pipe(Effect.as(undefined))),
  )

  const method: Updater.Interface["method"] = () => Effect.succeed("curl")
  return Updater.Service.of({
    run,
    check,
    apply,
    method,
    latest,
    upgrade: (selected: Updater.Method, version: string) => apply(version),
    removal: () => undefined,
  })
})

export const layer = Layer.effect(Updater.Service, make)

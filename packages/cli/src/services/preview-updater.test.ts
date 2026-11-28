import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { findCandidate, isNewer, platformAsset, replaceExecutable, verifyChecksum } from "./preview-updater"

const asset = (name: string) => ({ name, browser_download_url: `https://example.test/${name}` })

describe("platformAsset", () => {
  test("maps every published runner target", () => {
    expect(platformAsset("linux", "x64")).toBe("linux-x64")
    expect(platformAsset("linux", "arm64")).toBe("linux-arm64")
    expect(platformAsset("darwin", "x64")).toBe("macos-x64")
    expect(platformAsset("darwin", "arm64")).toBe("macos-arm64")
    expect(platformAsset("win32", "x64")).toBe("windows-x64")
  })

  test("rejects targets the build matrix does not publish", () => {
    expect(platformAsset("win32", "arm64")).toBeUndefined()
    expect(platformAsset("freebsd", "x64")).toBeUndefined()
    expect(platformAsset("linux", "ia32")).toBeUndefined()
  })
})

describe("findCandidate", () => {
  const releases = [
    {
      tag_name: "v2.2.5",
      assets: [asset("opencode2-linux-x64.tar.gz"), asset("opencode2-linux-x64.tar.gz.sha256")],
    },
    {
      tag_name: "preview-abcdef123456",
      assets: [asset("opencode2-linux-x64.tar.gz"), asset("opencode2-linux-x64.tar.gz.sha256")],
    },
    { tag_name: "preview-111111111111", assets: [asset("opencode2-linux-x64.tar.gz")] },
    {
      tag_name: "preview-222222222222",
      assets: [asset("opencode2-macos-arm64.tar.gz"), asset("opencode2-macos-arm64.tar.gz.sha256")],
    },
  ]

  test("uses the latest release with both archive and checksum for this runner", () => {
    expect(findCandidate(releases, "linux", "x64")).toEqual({
      tag: "preview-abcdef123456",
      commit: "abcdef123456",
      archive: "https://example.test/opencode2-linux-x64.tar.gz",
      checksum: "https://example.test/opencode2-linux-x64.tar.gz.sha256",
    })
  })

  test("returns nothing when there is no complete release for the runner", () => {
    expect(findCandidate(releases, "linux", "arm64")).toBeUndefined()
  })
})

describe("isNewer", () => {
  const candidate = {
    tag: "preview-abcdef123456",
    commit: "abcdef123456",
    archive: "archive",
    checksum: "checksum",
  }

  test("treats the same commit prefix as current", () => {
    expect(isNewer("abcdef123456", candidate)).toBe(false)
    expect(isNewer("abcdef1234567890", candidate)).toBe(false)
  })

  test("accepts a different prefix", () => {
    expect(isNewer("0123456789ab", candidate)).toBe(true)
    expect(isNewer("local", candidate)).toBe(true)
  })
})

describe("verifyChecksum", () => {
  const bytes = new TextEncoder().encode("archive contents")
  const digest = createHash("sha256").update(bytes).digest("hex")
  const name = "opencode2-linux-x64.tar.gz"

  test("accepts a GNU-style checksum and a bare digest", () => {
    expect(verifyChecksum(bytes, `${digest}  ${name}\n`, name)).toBe(true)
    expect(verifyChecksum(bytes, digest, name)).toBe(true)
  })

  test("rejects a mismatched digest or archive name", () => {
    expect(verifyChecksum(new TextEncoder().encode("other"), `${digest}  ${name}`, name)).toBe(false)
    expect(verifyChecksum(bytes, `${digest}  other.tar.gz`, name)).toBe(false)
    expect(verifyChecksum(bytes, "not a checksum", name)).toBe(false)
  })
})

describe("replaceExecutable", () => {
  async function fixture() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode2-updater-"))
    const target = path.join(directory, "opencode")
    const source = path.join(directory, "downloaded")
    await fs.writeFile(target, "installed")
    await fs.writeFile(source, "updated")
    return { directory, target, source }
  }

  test("replaces the binary in place on Unix", async () => {
    const { directory, target, source } = await fixture()
    try {
      await replaceExecutable(target, source, "linux")
      expect(await fs.readFile(target, "utf8")).toBe("updated")
      expect(await fs.readFile(`${target}.old`, "utf8").catch(() => undefined)).toBeUndefined()
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  test("renames a running Windows binary aside before replacing it", async () => {
    const { directory, target, source } = await fixture()
    try {
      await replaceExecutable(target, source, "win32")
      expect(await fs.readFile(target, "utf8")).toBe("updated")
      expect(await fs.readFile(`${target}.old`, "utf8").catch(() => undefined)).toBeUndefined()
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  test("restores the original binary when a Windows replacement fails", async () => {
    const { directory, target, source } = await fixture()
    try {
      await fs.rm(source)
      let failed = false
      await replaceExecutable(target, source, "win32").catch(() => {
        failed = true
      })
      expect(failed).toBe(true)
      expect(await fs.readFile(target, "utf8")).toBe("installed")
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})

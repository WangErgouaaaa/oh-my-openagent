import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { delimiter, join } from "node:path"
import { tmpdir } from "node:os"
import {
  getExternalPromptFileRoots,
  MAX_PROMPT_FILE_BYTES,
  resolveCallOmoPrompt,
  resolveCallOmoPromptWithReceipt,
} from "./prompt-resolver"

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex")
}

describe("resolveCallOmoPrompt", () => {
  let testRoot: string
  let workspaceRoot: string
  let allowedRoot: string
  let outsideRoot: string

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "call-omo-prompt-"))
    workspaceRoot = join(testRoot, "workspace")
    allowedRoot = join(testRoot, "allowed")
    outsideRoot = join(testRoot, "outside")
    mkdirSync(workspaceRoot)
    mkdirSync(allowedRoot)
    mkdirSync(outsideRoot)
  })

  afterEach(() => {
    mock.restore()
    rmSync(testRoot, { recursive: true, force: true })
  })

  test("#given a literal prompt #then it keeps the existing prompt path", () => {
    const result = resolveCallOmoPrompt(
      { prompt: "direct prompt" },
      { workspaceDirectory: workspaceRoot, externalAllowedRoots: [] },
    )

    expect(result).toBe("direct prompt")
  })

  test("#given an empty host-injected digest with a literal prompt #then it treats the optional digest as absent", () => {
    const result = resolveCallOmoPromptWithReceipt(
      {
        prompt: "direct prompt",
        prompt_file: "",
        prompt_sha256: "",
      },
      { workspaceDirectory: workspaceRoot, externalAllowedRoots: [] },
    )

    expect(result.prompt).toBe("direct prompt")
    expect(result.receipt.source).toBe("literal")
  })

  test("#given a workspace prompt file with a matching digest #then it loads the frozen prompt", () => {
    const promptPath = join(workspaceRoot, "review.md")
    const prompt = "\uFEFFfrozen workspace prompt ✓"
    const promptBytes = Buffer.from(prompt, "utf8")
    writeFileSync(promptPath, promptBytes)

    const result = resolveCallOmoPromptWithReceipt(
      {
        prompt_file: promptPath,
        prompt_sha256: sha256(promptBytes),
      },
      { workspaceDirectory: workspaceRoot, externalAllowedRoots: [] },
    )

    expect(result.prompt).toBe(prompt)
    expect(result.receipt).toEqual({
      source: "file",
      byteCount: promptBytes.byteLength,
      sha256: sha256(promptBytes),
    })
  })

  test("#given an external approved root #then it loads a matching frozen prompt", () => {
    const promptPath = join(allowedRoot, "review.md")
    const prompt = "frozen reviewer prompt"
    writeFileSync(promptPath, prompt)

    const result = resolveCallOmoPrompt(
      {
        prompt_file: promptPath,
        prompt_sha256: sha256(prompt),
      },
      {
        workspaceDirectory: workspaceRoot,
        externalAllowedRoots: [allowedRoot],
      },
    )

    expect(result).toBe(prompt)
  })

  test("#given both prompt sources #then it rejects the ambiguous request", () => {
    const promptPath = join(allowedRoot, "review.md")
    const prompt = "frozen reviewer prompt"
    writeFileSync(promptPath, prompt)

    expect(() => resolveCallOmoPrompt(
      {
        prompt: "direct prompt",
        prompt_file: promptPath,
        prompt_sha256: sha256(prompt),
      },
      {
        workspaceDirectory: workspaceRoot,
        externalAllowedRoots: [allowedRoot],
      },
    )).toThrow("Provide exactly one of prompt or prompt_file")
  })

  test("#given prompt_file without a digest #then it fails closed", () => {
    const promptPath = join(allowedRoot, "review.md")
    writeFileSync(promptPath, "frozen reviewer prompt")

    expect(() => resolveCallOmoPrompt(
      { prompt_file: promptPath },
      {
        workspaceDirectory: workspaceRoot,
        externalAllowedRoots: [allowedRoot],
      },
    )).toThrow("prompt_sha256 is required")
  })

  test("#given a digest mismatch #then it rejects the file", () => {
    const promptPath = join(allowedRoot, "review.md")
    writeFileSync(promptPath, "frozen reviewer prompt")

    expect(() => resolveCallOmoPrompt(
      {
        prompt_file: promptPath,
        prompt_sha256: "0".repeat(64),
      },
      {
        workspaceDirectory: workspaceRoot,
        externalAllowedRoots: [allowedRoot],
      },
    )).toThrow("SHA-256 mismatch")
  })

  test("#given a prompt outside approved roots #then it rejects the path", () => {
    const promptPath = join(outsideRoot, "review.md")
    const prompt = "outside prompt"
    writeFileSync(promptPath, prompt)

    expect(() => resolveCallOmoPrompt(
      {
        prompt_file: promptPath,
        prompt_sha256: sha256(prompt),
      },
      { workspaceDirectory: workspaceRoot, externalAllowedRoots: [] },
    )).toThrow("outside the approved roots")
  })

  test("#given a prompt outside approved roots #then it rejects before opening the path", async () => {
    const promptPath = join(outsideRoot, "review.md")
    const prompt = "outside prompt"
    writeFileSync(promptPath, prompt)

    const fs = await import("node:fs")
    const openSync = mock(() => {
      throw new Error("outside path must not be opened")
    })
    mock.module("node:fs", () => ({
      ...fs,
      openSync,
    }))

    try {
      const resolver = await import(`./prompt-resolver?outside-before-open=${Date.now()}`)

      expect(() => resolver.resolveCallOmoPrompt(
        {
          prompt_file: promptPath,
          prompt_sha256: sha256(prompt),
        },
        { workspaceDirectory: workspaceRoot, externalAllowedRoots: [] },
      )).toThrow("outside the approved roots")
      expect(openSync).not.toHaveBeenCalled()
    } finally {
      mock.restore()
    }
  })

  test("#given a symbolic link #then it rejects the prompt path", () => {
    if (process.platform === "win32") {
      return
    }

    const targetPath = join(allowedRoot, "target.md")
    const symlinkPath = join(allowedRoot, "linked.md")
    const prompt = "linked prompt"
    writeFileSync(targetPath, prompt)
    symlinkSync(targetPath, symlinkPath)

    expect(() => resolveCallOmoPrompt(
      {
        prompt_file: symlinkPath,
        prompt_sha256: sha256(prompt),
      },
      {
        workspaceDirectory: workspaceRoot,
        externalAllowedRoots: [allowedRoot],
      },
    )).toThrow("must not be a symbolic link")
  })

  test("#given an approved path is swapped to a symlink while opening #then it fails closed", async () => {
    if (process.platform === "win32") {
      return
    }

    const promptPath = join(allowedRoot, "review.md")
    const outsidePath = join(outsideRoot, "outside.md")
    const prompt = "frozen reviewer prompt"
    writeFileSync(promptPath, prompt)
    writeFileSync(outsidePath, prompt)

    const fs = await import("node:fs")
    const originalOpenSync = fs.openSync
    let swapped = false
    mock.module("node:fs", () => ({
      ...fs,
      openSync: (file: string, flags: string | number) => {
        if (!swapped && file === promptPath) {
          swapped = true
          fs.unlinkSync(promptPath)
          fs.symlinkSync(outsidePath, promptPath)
        }
        return originalOpenSync(file, flags)
      },
    }))

    try {
      const resolver = await import(`./prompt-resolver?path-swap=${Date.now()}`)

      expect(() => resolver.resolveCallOmoPrompt(
        {
          prompt_file: promptPath,
          prompt_sha256: sha256(prompt),
        },
        {
          workspaceDirectory: workspaceRoot,
          externalAllowedRoots: [allowedRoot],
        },
      )).toThrow("prompt_file must not be a symbolic link")
      expect(swapped).toBe(true)
    } finally {
      mock.restore()
    }
  })

  test("#given an oversized prompt #then it rejects the file before decoding", () => {
    const promptPath = join(allowedRoot, "oversized.md")
    const prompt = Buffer.alloc(MAX_PROMPT_FILE_BYTES + 1, 0x61)
    writeFileSync(promptPath, prompt)

    expect(() => resolveCallOmoPrompt(
      {
        prompt_file: promptPath,
        prompt_sha256: sha256(prompt),
      },
      {
        workspaceDirectory: workspaceRoot,
        externalAllowedRoots: [allowedRoot],
      },
    )).toThrow(`exceeds ${MAX_PROMPT_FILE_BYTES} bytes`)
  })

  test("#given a prompt grows after its size check #then it rejects without an unbounded read", async () => {
    const promptPath = join(allowedRoot, "growing.md")
    const prompt = "frozen reviewer prompt"
    writeFileSync(promptPath, prompt)

    const fs = await import("node:fs")
    let readSyncCalled = false
    mock.module("node:fs", () => ({
      ...fs,
      readSync: () => {
        readSyncCalled = true
        return MAX_PROMPT_FILE_BYTES + 1
      },
    }))

    try {
      const resolver = await import(`./prompt-resolver?post-stat-growth=${Date.now()}`)

      expect(() => resolver.resolveCallOmoPrompt(
        {
          prompt_file: promptPath,
          prompt_sha256: sha256(prompt),
        },
        {
          workspaceDirectory: workspaceRoot,
          externalAllowedRoots: [allowedRoot],
        },
      )).toThrow(`exceeds ${MAX_PROMPT_FILE_BYTES} bytes`)
      expect(readSyncCalled).toBe(true)
    } finally {
      mock.restore()
    }
  })

  test("#given invalid UTF-8 bytes #then it rejects the prompt", () => {
    const promptPath = join(allowedRoot, "invalid-utf8.md")
    const prompt = Uint8Array.from([0xc3, 0x28])
    writeFileSync(promptPath, prompt)

    expect(() => resolveCallOmoPrompt(
      {
        prompt_file: promptPath,
        prompt_sha256: sha256(prompt),
      },
      {
        workspaceDirectory: workspaceRoot,
        externalAllowedRoots: [allowedRoot],
      },
    )).toThrow("valid UTF-8")
  })

  test("#given configured root text #then it splits roots with the platform delimiter", () => {
    const result = getExternalPromptFileRoots({
      OMO_CALL_OMO_PROMPT_FILE_ROOTS: `${workspaceRoot}${delimiter}${allowedRoot}`,
    })

    expect(result).toEqual([workspaceRoot, allowedRoot])
  })
})

import { createHash, timingSafeEqual } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs"
import {
  delimiter,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path"
import type { CallOmoPromptReceipt } from "./types"

export const PROMPT_FILE_ROOTS_ENV = "OMO_CALL_OMO_PROMPT_FILE_ROOTS"
export const MAX_PROMPT_FILE_BYTES = 1024 * 1024

export type PromptInput = {
  prompt?: string
  prompt_file?: string
  prompt_sha256?: string
}

export type PromptResolutionOptions = {
  workspaceDirectory: string
  externalAllowedRoots?: readonly string[]
}

export type ResolvedCallOmoPrompt = {
  prompt: string
  receipt: CallOmoPromptReceipt
}

type Environment = Record<string, string | undefined>

function canonicalizeDirectory(root: string, label: string): string {
  const absoluteRoot = resolve(root)
  const realRoot = realpathSync(absoluteRoot)
  if (!statSync(realRoot).isDirectory()) {
    throw new Error(`${label} must be a directory: ${root}`)
  }
  return realRoot
}

function isContainedPath(filePath: string, root: string): boolean {
  const relativePath = relative(root, filePath)
  return relativePath === ""
    || (
      relativePath !== ".."
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath)
    )
}

function openPromptFile(promptFile: string): number {
  const flags = constants.O_RDONLY
    | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
  try {
    return openSync(promptFile, flags)
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ELOOP"
    ) {
      throw new Error("prompt_file must not be a symbolic link.")
    }
    throw error
  }
}

type FileIdentity = {
  dev: number
  ino: number
}

function hasStableFileIdentity(fileStat: FileIdentity): boolean {
  return Number.isSafeInteger(fileStat.dev)
    && Number.isSafeInteger(fileStat.ino)
    && fileStat.dev >= 0
    && fileStat.ino >= 0
    && (fileStat.dev !== 0 || fileStat.ino !== 0)
}

function resolveOpenedPromptPath(
  fileDescriptor: number,
  canonicalPromptPath: string,
  inputStat: FileIdentity,
  fileStat: FileIdentity,
): string {
  if (process.platform === "linux") {
    return realpathSync(`/proc/self/fd/${fileDescriptor}`)
  }
  if (!hasStableFileIdentity(inputStat) || !hasStableFileIdentity(fileStat)) {
    throw new Error("prompt_file descriptor provenance is unavailable on this platform.")
  }
  return canonicalPromptPath
}

function resolveApprovedRoots(options: PromptResolutionOptions): string[] {
  const roots = new Set<string>([
    canonicalizeDirectory(options.workspaceDirectory, "Workspace directory"),
  ])

  for (const configuredRoot of options.externalAllowedRoots ?? []) {
    if (!isAbsolute(configuredRoot)) {
      throw new Error(`Configured prompt root must be absolute: ${configuredRoot}`)
    }
    roots.add(canonicalizeDirectory(configuredRoot, "Configured prompt root"))
  }

  return [...roots]
}

function validateExpectedDigest(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("prompt_sha256 is required when prompt_file is used.")
  }

  const normalized = value.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("prompt_sha256 must be a 64-character hexadecimal SHA-256 digest.")
  }
  return normalized
}

function verifyDigest(bytes: Uint8Array, expectedDigest: string): void {
  const actualDigest = createHash("sha256").update(bytes).digest()
  const expectedBytes = Buffer.from(expectedDigest, "hex")
  if (!timingSafeEqual(actualDigest, expectedBytes)) {
    throw new Error("prompt_file SHA-256 mismatch.")
  }
}

function decodePrompt(bytes: Uint8Array): string {
  let prompt: string
  try {
    prompt = new TextDecoder(
      "utf-8",
      { fatal: true, ignoreBOM: true },
    ).decode(bytes)
  } catch {
    throw new Error("prompt_file must contain valid UTF-8.")
  }

  if (prompt.includes("\u0000")) {
    throw new Error("prompt_file must not contain NUL bytes.")
  }
  if (prompt.trim() === "") {
    throw new Error("prompt_file must not be empty.")
  }
  return prompt
}

function readBoundedPromptFile(fileDescriptor: number): Buffer {
  const bytes = Buffer.allocUnsafe(MAX_PROMPT_FILE_BYTES + 1)
  let byteCount = 0

  while (byteCount < bytes.length) {
    const bytesRead = readSync(
      fileDescriptor,
      bytes,
      byteCount,
      bytes.length - byteCount,
      null,
    )
    if (bytesRead === 0) {
      break
    }
    byteCount += bytesRead
  }

  if (byteCount > MAX_PROMPT_FILE_BYTES) {
    throw new Error(`prompt_file exceeds ${MAX_PROMPT_FILE_BYTES} bytes.`)
  }
  return bytes.subarray(0, byteCount)
}

export function getExternalPromptFileRoots(
  env: Environment = process.env,
): string[] {
  return (env[PROMPT_FILE_ROOTS_ENV] ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
}

export function resolveCallOmoPrompt(
  input: PromptInput,
  options: PromptResolutionOptions,
): string {
  return resolveCallOmoPromptWithReceipt(input, options).prompt
}

export function resolveCallOmoPromptWithReceipt(
  input: PromptInput,
  options: PromptResolutionOptions,
): ResolvedCallOmoPrompt {
  const hasLiteralPrompt = typeof input.prompt === "string" && input.prompt.trim() !== ""
  const promptFile = input.prompt_file?.trim()
  const hasPromptFile = promptFile !== undefined && promptFile !== ""

  if (hasLiteralPrompt === hasPromptFile) {
    throw new Error("Provide exactly one of prompt or prompt_file.")
  }

  if (hasLiteralPrompt) {
    if (input.prompt_sha256 !== undefined) {
      throw new Error("prompt_sha256 is only valid with prompt_file.")
    }
    const prompt = input.prompt as string
    const bytes = Buffer.from(prompt, "utf8")
    return {
      prompt,
      receipt: {
        source: "literal",
        byteCount: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    }
  }

  if (!promptFile || !isAbsolute(promptFile)) {
    throw new Error("prompt_file must be an absolute path.")
  }

  const expectedDigest = validateExpectedDigest(input.prompt_sha256)
  const approvedRoots = resolveApprovedRoots(options)
  const inputStat = lstatSync(promptFile)
  if (inputStat.isSymbolicLink()) {
    throw new Error("prompt_file must not be a symbolic link.")
  }
  const canonicalPromptPath = realpathSync(promptFile)
  if (!approvedRoots.some((root) => isContainedPath(canonicalPromptPath, root))) {
    throw new Error("prompt_file is outside the approved roots.")
  }
  if (!inputStat.isFile()) {
    throw new Error("prompt_file must be a regular file.")
  }

  const fileDescriptor = openPromptFile(promptFile)
  try {
    const fileStat = fstatSync(fileDescriptor)
    if (!fileStat.isFile()) {
      throw new Error("prompt_file must be a regular file.")
    }
    const openedPathStat = lstatSync(promptFile)
    if (openedPathStat.isSymbolicLink()) {
      throw new Error("prompt_file must not be a symbolic link.")
    }
    if (
      inputStat.dev !== fileStat.dev
      || inputStat.ino !== fileStat.ino
      || openedPathStat.dev !== fileStat.dev
      || openedPathStat.ino !== fileStat.ino
    ) {
      throw new Error("prompt_file changed while it was being opened.")
    }
    const realPromptPath = resolveOpenedPromptPath(
      fileDescriptor,
      canonicalPromptPath,
      inputStat,
      fileStat,
    )
    if (realPromptPath.endsWith(" (deleted)")) {
      throw new Error("prompt_file changed while it was being opened.")
    }
    if (!approvedRoots.some((root) => isContainedPath(realPromptPath, root))) {
      throw new Error("prompt_file is outside the approved roots.")
    }
    if (fileStat.size > MAX_PROMPT_FILE_BYTES) {
      throw new Error(`prompt_file exceeds ${MAX_PROMPT_FILE_BYTES} bytes.`)
    }

    const bytes = readBoundedPromptFile(fileDescriptor)

    verifyDigest(bytes, expectedDigest)
    return {
      prompt: decodePrompt(bytes),
      receipt: {
        source: "file",
        byteCount: bytes.byteLength,
        sha256: expectedDigest,
      },
    }
  } finally {
    closeSync(fileDescriptor)
  }
}

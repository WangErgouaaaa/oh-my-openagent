import { MigrationTransactionError, type MigrationFileSystem } from "./types"

type BackupMove = {
  readonly from: string
  readonly to: string
}

function errorCode(error: unknown): unknown {
  return error instanceof Error ? Reflect.get(error, "code") : undefined
}

function copyThenRemove(
  move: BackupMove,
  fileSystem: MigrationFileSystem,
  allowExistingDestination: boolean,
): void {
  const sourceContent = fileSystem.readFileSync(move.from, "utf-8")
  if (fileSystem.existsSync(move.to)) {
    if (!allowExistingDestination || fileSystem.readFileSync(move.to, "utf-8") !== sourceContent) {
      throw new MigrationTransactionError(`Migration backup path already exists: ${move.to}`)
    }
  } else {
    try {
      fileSystem.writeFileExclusiveSync(move.to, sourceContent)
    } catch (error) {
      if (errorCode(error) !== "EEXIST" && fileSystem.existsSync(move.to)) {
        fileSystem.unlinkSync(move.to)
      }
      throw error
    }
    if (fileSystem.readFileSync(move.to, "utf-8") !== sourceContent) {
      fileSystem.unlinkSync(move.to)
      throw new MigrationTransactionError(`Migration backup copy does not match source: ${move.to}`)
    }
  }
  fileSystem.unlinkSync(move.from)
}

export function moveMigrationBackup(
  move: BackupMove,
  fileSystem: MigrationFileSystem,
  options: { readonly allowExistingDestination?: boolean } = {},
): void {
  const allowExistingDestination = options.allowExistingDestination === true
  if (!fileSystem.existsSync(move.from)) {
    if (allowExistingDestination && fileSystem.existsSync(move.to)) return
    if (fileSystem.existsSync(move.to)) {
      throw new MigrationTransactionError(`Migration backup path already exists: ${move.to}`)
    }
    throw new MigrationTransactionError(`Migration source and backup are both missing: ${move.from}`)
  }
  if (fileSystem.existsSync(move.to)) {
    copyThenRemove(move, fileSystem, allowExistingDestination)
    return
  }

  try {
    fileSystem.renameSync(move.from, move.to)
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error
    copyThenRemove(move, fileSystem, false)
  }
}

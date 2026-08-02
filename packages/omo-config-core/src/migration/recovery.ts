import { moveMigrationBackup } from "./backup-move"
import { prepareTargetWrite, targetDocument, writePreparedTarget } from "./commit"
import { readMigrationJournal, removeMigrationJournal, writeMigrationJournal } from "./journal"
import { hasMigrationMarker } from "./predicate"
import type { MigrationClock, MigrationEnvironment, MigrationFileSystem, MigrationProcess, MigrationTargetWriter } from "./types"

export function resumeMigrationJournal(input: {
  readonly clock: MigrationClock
  readonly env: MigrationEnvironment
  readonly fileSystem: MigrationFileSystem
  readonly process: MigrationProcess
  readonly renewLock: () => void
  readonly writeTarget: MigrationTargetWriter
}): boolean {
  const journal = readMigrationJournal(input.fileSystem, input.env)
  if (journal === null) return false

  input.renewLock()
  const target = targetDocument(journal.targetPath, input.fileSystem)
  if (!hasMigrationMarker(target, journal.migrationId)) {
    const prepared = prepareTargetWrite({
      additions: journal.targetWrite.additions,
      migrationId: journal.migrationId,
      target,
      targetPath: journal.targetPath,
    })
    writePreparedTarget({
      env: input.env,
      fileSystem: input.fileSystem,
      prepared,
      targetPath: journal.targetPath,
      writeTarget: input.writeTarget,
    })
  }

  const targetRecorded = { ...journal, targetWritten: true }
  writeMigrationJournal(targetRecorded, input.fileSystem, input.env, input.process, input.clock)
  for (const move of targetRecorded.backupMoves) {
    if (targetRecorded.completedMoves.includes(move.from)) continue
    input.renewLock()
    moveMigrationBackup(move, input.fileSystem, { allowExistingDestination: true })
    Object.assign(targetRecorded, { completedMoves: [...targetRecorded.completedMoves, move.from] })
    writeMigrationJournal(targetRecorded, input.fileSystem, input.env, input.process, input.clock)
  }
  removeMigrationJournal(input.fileSystem, input.env)
  return true
}

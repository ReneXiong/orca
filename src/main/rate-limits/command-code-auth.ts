import { createHmac, randomBytes } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { homedir } from 'node:os'
import { join } from 'node:path'

const IDENTITY_KEY = randomBytes(32)

export type CommandCodeCredentials = { apiKey: string; identity: string }

export function getCommandCodeAuthPath(): string {
  return join(homedir(), '.commandcode', 'auth.json')
}

/** Reads the CLI-owned production login without copying or refreshing it. */
export async function readCommandCodeCredentials(
  authPath: string
): Promise<CommandCodeCredentials | null> {
  try {
    if (!(await lstat(authPath)).isFile()) {
      return null
    }
    const { buffer } = await readNodeFileWithinLimit(authPath, 1_000_000)
    const parsed: unknown = JSON.parse(buffer.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || !('apiKey' in parsed)) {
      return null
    }
    const apiKey = parsed.apiKey
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
      return null
    }
    return {
      apiKey: apiKey.trim(),
      identity: createHmac('sha256', IDENTITY_KEY).update(apiKey.trim()).digest('hex')
    }
  } catch {
    return null
  }
}

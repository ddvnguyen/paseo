import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function applyPrivateMode(target: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(target, mode);
  } catch {
    // Permissions are not portable; creation must still work on such filesystems.
  }
}

export function ensurePrivateDirectory(directoryPath: string): void {
  mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  applyPrivateMode(directoryPath, PRIVATE_DIRECTORY_MODE);
}

export function ensurePrivateFile(filePath: string): void {
  applyPrivateMode(filePath, PRIVATE_FILE_MODE);
}

export interface PrivateFileWriteOptions {
  /**
   * Create the parent directory and force it to PRIVATE_DIRECTORY_MODE. Leave this
   * on for state under PASEO_HOME, which is private by contract. Turn it off when
   * the parent is a directory Paseo does not own — a user's source checkout, say —
   * where the secret belongs in the file but the directory's permissions are none
   * of Paseo's business.
   */
  privateDirectory?: boolean;
}

export function writePrivateFileAtomicSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  options: PrivateFileWriteOptions = {},
): void {
  const parent = path.dirname(filePath);
  if (options.privateDirectory ?? true) ensurePrivateDirectory(parent);
  const temporary = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}`);
  try {
    writeFileSync(temporary, data, { mode: PRIVATE_FILE_MODE });
    renameSync(temporary, filePath);
    ensurePrivateFile(filePath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

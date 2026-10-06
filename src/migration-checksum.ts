import { createHash } from 'node:crypto';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * A migration's checksum, the same on every OS. Git on Windows (`core.autocrlf=true`) checks files
 * out with CRLF, while Railway builds from the repository with LF, so hashing raw bytes made one file
 * two checksums — and every migration looked edited when run from a Windows checkout.
 */
export const migrationChecksum = (sql: string): string => sha256(sql.replace(/\r\n/g, '\n'));

/**
 * Whether a recorded checksum still describes this file. Also accepts the raw-bytes hash the migrator
 * recorded before line endings were normalized, so a database once migrated from Windows does not
 * report every file as changed.
 */
export const checksumMatches = (recorded: string, sql: string): boolean => recorded === migrationChecksum(sql) || recorded === sha256(sql);

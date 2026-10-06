import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { checksumMatches, migrationChecksum } from '../src/migration-checksum.js';

const lf = 'CREATE TABLE t (\n  id TEXT\n);\n';
const crlf = lf.replace(/\n/g, '\r\n');

test('a migration has one checksum whatever line endings the checkout gave it', () => {
  assert.equal(migrationChecksum(crlf), migrationChecksum(lf), 'a Windows checkout hashes like the LF file Railway deploys');
  // Railway records the hash of the LF file, so normalizing must leave that hash unchanged.
  assert.equal(migrationChecksum(lf), createHash('sha256').update(lf).digest('hex'));
});

test('a recorded checksum is accepted from either OS, and an edit is still caught', () => {
  assert.ok(checksumMatches(migrationChecksum(lf), crlf), 'recorded by a deploy, read on Windows');
  assert.ok(checksumMatches(createHash('sha256').update(crlf).digest('hex'), crlf), 'recorded raw by the old migrator on Windows');
  assert.ok(!checksumMatches(migrationChecksum(lf), lf.replace('TEXT', 'INTEGER')), 'a real edit still warns');
});

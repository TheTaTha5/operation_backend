import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBookingPassengers, withSeq } from '../src/domain/booking-passengers.js';

test('absent passengers is an empty list', () => {
  assert.deepEqual(parseBookingPassengers(undefined), []);
});

test('a passenger needs at least a name', () => {
  assert.deepEqual(parseBookingPassengers([{ name: 'Alex' }]), [{ name: 'Alex', nationality: undefined, type: undefined, foc: undefined }]);
  assert.throws(() => parseBookingPassengers([{ nationality: 'DE' }]), /name is required/);
  assert.throws(() => parseBookingPassengers([{ name: '  ' }]), /name is required/);
});

test('optional fields are trimmed and blanks drop to undefined', () => {
  const [row] = parseBookingPassengers([{ name: ' Alex ', nationality: '', type: 'AD', foc: true }]);
  assert.equal(row.name, 'Alex');
  assert.equal(row.nationality, undefined);
  assert.equal(row.type, 'AD');
  assert.equal(row.foc, true);
});

test('passengers must be an array, not a bare object', () => {
  assert.throws(() => parseBookingPassengers({ name: 'Alex' }), /must be an array/);
  assert.throws(() => parseBookingPassengers(['Alex']), /must be an object/);
});

test('withSeq assigns position in order', () => {
  const rows = withSeq([{ name: 'Alex' }, { name: 'Sam' }]);
  assert.deepEqual(rows.map((r) => r.seq), [0, 1]);
});

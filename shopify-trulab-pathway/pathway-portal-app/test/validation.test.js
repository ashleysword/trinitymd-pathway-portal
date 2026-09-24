import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAssignment, normalizeAssignmentBatch, normalizeKitId } from '../src/validation.js';

test('normalizes a customer-entered kit ID without accepting identity fields', () => {
  assert.equal(normalizeKitId(' ptw-9001 '), 'PTW-9001');
  assert.throws(() => normalizeKitId('bad id'), /4 to 64/);
});

test('normalizes kit ID, client email, and first initial plus last name', () => {
  assert.deepEqual(normalizeAssignment({
    kitId: ' px-1234 ',
    clientEmail: 'CLIENT@Example.COM ',
    clientName: 'j smith',
  }), {
    kitId: 'PX-1234',
    clientEmail: 'client@example.com',
    clientName: 'J. smith',
  });
});

test('accepts compound and apostrophe last names', () => {
  assert.equal(normalizeAssignment({
    kitId: 'KIT-0002',
    clientEmail: 'client@example.com',
    clientName: "A. O’Neil-Smith",
  }).clientName, "A. O’Neil-Smith");
});

test('rejects a full first name', () => {
  assert.throws(() => normalizeAssignment({
    kitId: 'KIT-0003',
    clientEmail: 'client@example.com',
    clientName: 'Jane Smith',
  }), /first initial/);
});

test('rejects duplicate kit IDs in one batch', () => {
  const item = { kitId: 'KIT-0004', clientEmail: 'client@example.com', clientName: 'J. Smith' };
  assert.throws(() => normalizeAssignmentBatch([item, item]), /appears more than once/);
});

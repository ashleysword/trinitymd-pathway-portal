import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoPatientHealthInformation,
  decodeDocumentFile,
  isValidNpi,
  normalizeApplication,
  normalizeKitIdWithPattern,
} from '../src/clinic-validation.js';

const validApplication = {
  firstName: ' Riley ',
  lastName: 'Applicant',
  contactEmail: 'RILEY@Example.com',
  company: 'Synthetic Wellness',
  businessType: 'Wellness clinic',
  website: 'synthetic.example',
  npi: '1234567893',
  taxId: '123456789',
  resellerPermit: 'sr-123',
  attestation: true,
  requestId: 'request-0001',
};

test('validates NPI check digits with the 80840 Luhn prefix', () => {
  assert.equal(isValidNpi('1234567893'), true);
  assert.equal(isValidNpi('1234567890'), false);
  assert.equal(isValidNpi('123456789'), false);
});

test('normalizes a practice application', () => {
  const application = normalizeApplication(validApplication);
  assert.equal(application.firstName, 'Riley');
  assert.equal(application.contactEmail, 'riley@example.com');
  assert.equal(application.taxId, '12-3456789');
  assert.equal(application.resellerPermit, 'SR-123');
  assert.equal(application.website, 'https://synthetic.example/');
});

test('rejects applications with missing or invalid required fields', () => {
  assert.throws(() => normalizeApplication({ ...validApplication, npi: '1234567890' }), (error) => error.field === 'npi');
  assert.throws(() => normalizeApplication({ ...validApplication, taxId: '12-34' }), (error) => error.field === 'taxId');
  assert.throws(() => normalizeApplication({ ...validApplication, company: '' }), (error) => error.field === 'company');
  assert.throws(() => normalizeApplication({ ...validApplication, businessType: 'Casino' }), (error) => error.field === 'businessType');
  assert.throws(() => normalizeApplication({ ...validApplication, attestation: false }), (error) => error.field === 'attestation');
  assert.throws(() => normalizeApplication({ ...validApplication, requestId: 'x' }), (error) => error.field === 'requestId');
});

test('enforces a configured kit label pattern after the legacy normalization', () => {
  assert.equal(normalizeKitIdWithPattern(' tl00001234 ', /^TL\d{8}$/), 'TL00001234');
  assert.throws(() => normalizeKitIdWithPattern('TL123', /^TL\d{8}$/), (error) => error.field === 'kitId');
  assert.equal(normalizeKitIdWithPattern('KIT-0001', null), 'KIT-0001');
});

test('blocks obvious patient health information in messages', () => {
  assert.throws(() => assertNoPatientHealthInformation('DOB 01/02/1980', 'body'));
  assert.throws(() => assertNoPatientHealthInformation('SSN 123-45-6789', 'body'));
  assert.throws(() => assertNoPatientHealthInformation('The diagnosis was', 'body'));
  assert.doesNotThrow(() => assertNoPatientHealthInformation('When will order #1042 ship?', 'body'));
});

test('accepts only small PDF or image document uploads', () => {
  const pdf = Buffer.from('%PDF-1.7 synthetic').toString('base64');
  assert.equal(decodeDocumentFile({ filename: 'a.pdf', contentType: 'application/pdf', base64: pdf }).contentType, 'application/pdf');
  assert.throws(() => decodeDocumentFile({ filename: 'a.pdf', contentType: 'application/pdf', base64: Buffer.from('not a pdf').toString('base64') }));
  assert.throws(() => decodeDocumentFile({ filename: 'a.html', contentType: 'text/html', base64: pdf }));
});

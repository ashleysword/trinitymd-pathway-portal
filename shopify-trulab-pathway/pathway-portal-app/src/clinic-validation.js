import { AssignmentValidationError, normalizeKitId } from './validation.js';

export const BUSINESS_TYPES = [
  'Medical practice',
  'Chiropractic practice',
  'Wellness clinic',
  'Pharmacy',
  'Med spa',
  'Naturopathic practice',
  'Other',
];

export const MESSAGE_CATEGORIES = ['general', 'kit_status', 'order', 'documents'];
export const DOCUMENT_AUDIENCES = ['public', 'clinic'];
export const DOCUMENT_STATUSES = ['draft', 'published', 'archived'];
export const DOCUMENT_CONTENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const PHI_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:date of birth|d\.?o\.?b\.?)\b/i,
  /\b(?:diagnos(?:is|ed)|genotype|variant|mutation)\b/i,
];

function fail(message, field) {
  throw new AssignmentValidationError(message, field);
}

function text(input, field, label, { required = false, max = 120, min = 0 } = {}) {
  const value = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (!value) {
    if (required) fail(`${label} is required.`, field);
    return '';
  }
  if (value.length < min || value.length > max) fail(`${label} must be ${min ? `${min} to ` : 'at most '}${max} characters.`, field);
  return value;
}

function multiline(input, field, label, { required = false, max = 4000 } = {}) {
  const value = String(input ?? '').replace(/\r\n/g, '\n').trim();
  if (!value) {
    if (required) fail(`${label} is required.`, field);
    return '';
  }
  if (value.length > max) fail(`${label} must be at most ${max} characters.`, field);
  return value;
}

// NPI check digit: Luhn over the 80840 prefix plus the first nine digits.
export function isValidNpi(npi) {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi.slice(0, 9)}`;
  let sum = 0;
  for (let index = digits.length - 1, double = true; index >= 0; index -= 1, double = !double) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10 === Number(npi[9]);
}

export function normalizeRequestId(input) {
  const value = String(input || '').trim();
  if (!REQUEST_ID_PATTERN.test(value)) fail('A valid request ID is required.', 'requestId');
  return value;
}

export function normalizeApplication(input = {}) {
  const npi = String(input.npi ?? '').replace(/\D/g, '');
  if (!isValidNpi(npi)) fail('Enter a valid 10-digit NPI number.', 'npi');

  const taxIdDigits = String(input.taxId ?? '').replace(/\D/g, '');
  if (!/^\d{9}$/.test(taxIdDigits)) fail('Enter a 9-digit Tax ID / EIN.', 'taxId');

  const resellerPermit = String(input.resellerPermit ?? '').trim().toUpperCase();
  if (resellerPermit && !/^[A-Z0-9][A-Z0-9 -]{2,39}$/.test(resellerPermit)) {
    fail('Reseller permit numbers may contain letters, numbers, spaces, and hyphens.', 'resellerPermit');
  }

  const businessType = text(input.businessType, 'businessType', 'Business type', { required: true, max: 60 });
  if (!BUSINESS_TYPES.includes(businessType)) fail('Choose a business type.', 'businessType');

  let website = text(input.website, 'website', 'Website', { max: 200 });
  if (website) {
    if (!/^https?:\/\//i.test(website)) website = `https://${website}`;
    try {
      const url = new URL(website);
      if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) throw new Error('bad');
      website = url.toString();
    } catch {
      fail('Enter a valid website address.', 'website');
    }
  }

  const contactEmail = String(input.contactEmail ?? '').trim().toLowerCase();
  if (contactEmail.length > 254 || !EMAIL_PATTERN.test(contactEmail)) fail('Enter a valid business email.', 'contactEmail');

  const phone = String(input.phone ?? '').replace(/[^\d+]/g, '');
  if (phone && !/^\+?\d{10,15}$/.test(phone)) fail('Enter a valid phone number.', 'phone');

  if (input.attestation !== true) fail('Confirm that the information is accurate.', 'attestation');

  return {
    firstName: text(input.firstName, 'firstName', 'First name', { required: true, max: 60 }),
    lastName: text(input.lastName, 'lastName', 'Last name', { required: true, max: 60 }),
    contactEmail,
    phone,
    company: text(input.company, 'company', 'Practice name', { required: true, min: 2, max: 120 }),
    businessType,
    website,
    npi,
    npiMatchesContact: input.npiMatchesContact === true,
    resellerPermit,
    taxId: `${taxIdDigits.slice(0, 2)}-${taxIdDigits.slice(2)}`,
    requestId: normalizeRequestId(input.requestId),
  };
}

export function normalizeKitIdWithPattern(input, pattern) {
  const kitId = normalizeKitId(input);
  if (pattern && !pattern.test(kitId)) {
    fail('That Kit ID does not match the format printed on TrinityMD kit labels.', 'kitId');
  }
  return kitId;
}

export function assertNoPatientHealthInformation(value, field) {
  if (PHI_PATTERNS.some((pattern) => pattern.test(value))) {
    fail('Please remove patient health information (such as dates of birth, ID numbers, or diagnoses). This channel is for business and kit-status questions only.', field);
  }
}

export function normalizeNewThread(input = {}) {
  const subject = text(input.subject, 'subject', 'Subject', { required: true, min: 3, max: 120 });
  const category = String(input.category || 'general');
  if (!MESSAGE_CATEGORIES.includes(category)) fail('Choose a message topic.', 'category');
  const kitId = input.kitId ? normalizeKitId(input.kitId) : '';
  const body = multiline(input.body, 'body', 'Message', { required: true });
  assertNoPatientHealthInformation(subject, 'subject');
  assertNoPatientHealthInformation(body, 'body');
  return { subject, category, kitId, body, requestId: normalizeRequestId(input.requestId) };
}

export function normalizeMessage(input = {}) {
  const body = multiline(input.body, 'body', 'Message', { required: true });
  assertNoPatientHealthInformation(body, 'body');
  return { body, requestId: normalizeRequestId(input.requestId) };
}

export function normalizeStaffNote(input, { required = false } = {}) {
  return multiline(input, 'note', 'Note', { required, max: 2000 });
}

export function normalizeDocumentInput(input = {}, { partial = false } = {}) {
  const output = {};
  if (!partial || input.title !== undefined) output.title = text(input.title, 'title', 'Title', { required: true, max: 120 });
  if (!partial || input.description !== undefined) output.description = text(input.description, 'description', 'Description', { max: 300 });
  if (!partial || input.category !== undefined) output.category = text(input.category, 'category', 'Category', { required: true, max: 60 });
  if (!partial || input.version !== undefined) output.version = text(input.version, 'version', 'Version', { required: true, max: 30 });
  if (!partial || input.publishedDate !== undefined) {
    const date = String(input.publishedDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) fail('Enter the document date as YYYY-MM-DD.', 'publishedDate');
    output.publishedDate = date;
  }
  if (!partial || input.audience !== undefined) {
    if (!DOCUMENT_AUDIENCES.includes(input.audience)) fail('Choose who can see this document.', 'audience');
    output.audience = input.audience;
  }
  if (input.status !== undefined) {
    if (!DOCUMENT_STATUSES.includes(input.status)) fail('Choose a valid document status.', 'status');
    output.status = input.status;
  }
  return output;
}

export function decodeDocumentFile(input = {}) {
  const contentType = String(input.contentType || '');
  if (!DOCUMENT_CONTENT_TYPES.includes(contentType)) fail('Upload a PDF, PNG, or JPEG file.', 'file');
  const filename = text(input.filename, 'file', 'File name', { required: true, max: 120 }).replace(/[^\w. -]/g, '_');
  const base64 = String(input.base64 || '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) fail('The uploaded file could not be read.', 'file');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) fail('Files must be 4 MB or smaller.', 'file');
  if (contentType === 'application/pdf' && bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    fail('The uploaded file is not a valid PDF.', 'file');
  }
  return { bytes, contentType, filename };
}

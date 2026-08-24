export class AssignmentValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'AssignmentValidationError';
    this.field = field;
  }
}

const KIT_ID_PATTERN = /^[A-Z0-9._-]{4,64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLIENT_NAME_PATTERN = /^(\p{L})\.?\s+([\p{L}\p{M}'’.-]+(?:\s+[\p{L}\p{M}'’.-]+)*)$/u;

export function normalizeAssignment(input) {
  const kitId = String(input?.kitId || '').trim().toUpperCase();
  const clientEmail = String(input?.clientEmail || '').trim().toLowerCase();
  const suppliedName = String(input?.clientName || '').trim().replace(/\s+/g, ' ');

  if (!KIT_ID_PATTERN.test(kitId)) {
    throw new AssignmentValidationError('Kit ID must be 4–64 letters, numbers, dots, underscores, or hyphens.', 'kitId');
  }
  if (clientEmail.length > 254 || !EMAIL_PATTERN.test(clientEmail)) {
    throw new AssignmentValidationError('Enter a valid client email address.', 'clientEmail');
  }
  const nameMatch = suppliedName.match(CLIENT_NAME_PATTERN);
  if (!nameMatch || suppliedName.length > 90) {
    throw new AssignmentValidationError('Use only the client’s first initial and full last name, such as J. Smith.', 'clientName');
  }

  const firstInitial = nameMatch[1].toLocaleUpperCase();
  const lastName = nameMatch[2];
  return {
    kitId,
    clientEmail,
    clientName: `${firstInitial}. ${lastName}`,
  };
}

export function normalizeAssignmentBatch(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 25) {
    throw new AssignmentValidationError('Submit between 1 and 25 kit assignments.', 'assignments');
  }
  const assignments = input.map(normalizeAssignment);
  const kitIds = new Set();
  for (const assignment of assignments) {
    if (kitIds.has(assignment.kitId)) {
      throw new AssignmentValidationError(`Kit ID ${assignment.kitId} appears more than once.`, 'kitId');
    }
    kitIds.add(assignment.kitId);
  }
  return assignments;
}

// Notifications carry event names and record IDs only, never message bodies,
// identifiers, or anything a clinic typed. No real email is sent in this phase;
// a delivery channel (Shopify Flow, transactional email) needs owner approval.
export const NOTIFICATION_EVENTS = [
  'application.submitted',
  'application.approved',
  'application.rejected',
  'kit.registered',
  'kit.status_changed',
  'message.from_clinic',
  'message.from_staff',
];

function assertEvent(event) {
  if (!NOTIFICATION_EVENTS.includes(event)) throw new Error(`Unknown notification event: ${event}`);
}

export class LogNotifier {
  constructor(logger = console) {
    this.logger = logger;
  }

  async notify(event, { audience, recordId }) {
    assertEvent(event);
    this.logger.info?.(`[portal-notify] ${event} audience=${audience} record=${recordId}`);
  }
}

export class OutboxNotifier {
  constructor() {
    this.outbox = [];
  }

  async notify(event, { audience, recordId, customerId = null }) {
    assertEvent(event);
    this.outbox.push({ event, audience, recordId, customerId, at: new Date().toISOString() });
  }
}

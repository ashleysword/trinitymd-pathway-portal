// Notifications carry event names and record IDs only, never message bodies,
// identifiers, or anything a clinic typed. The app sends no email itself; staff
// alerts go out through WebhookNotifier when STAFF_NOTIFY_WEBHOOK_URL is set.
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

// Staff alerts (owner plan, Nov 4): staff-audience events are POSTed to a webhook,
// e.g. a GHL "Inbound Webhook" workflow that emails or texts the staff list. The
// payload is the event name, numeric record and customer IDs, and a console link:
// no message text, names, emails or kit IDs. Delivery never blocks or fails the
// clinic's request; clinic-audience events stay log-only (clinics see unread badges).
export class WebhookNotifier {
  constructor({ url, consoleUrl = '', fetchImpl = globalThis.fetch, logger = console, timeoutMs = 3000 }) {
    this.url = url;
    this.consoleUrl = consoleUrl;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.log = new LogNotifier(logger);
  }

  async notify(event, { audience, recordId, customerId = null }) {
    await this.log.notify(event, { audience, recordId });
    if (audience !== 'staff') return;
    const payload = {
      event,
      recordId: String(recordId || '').split('/').pop(),
      customerId: customerId ? String(customerId) : null,
      consoleUrl: this.consoleUrl || null,
      at: new Date().toISOString(),
    };
    try {
      const response = await this.fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) this.logger.error?.(`[portal-notify] staff webhook returned ${response.status} for ${event}`);
    } catch (error) {
      this.logger.error?.(`[portal-notify] staff webhook failed for ${event}: ${error.name}`);
    }
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

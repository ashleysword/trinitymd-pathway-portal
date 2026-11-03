import { getPortalRuntime } from '../../src/runtime.js';
import { jsonResponse } from '../../src/app.js';

export default async function pathwayPortal(request) {
  try {
    return await getPortalRuntime().handler(request);
  } catch (error) {
    console.error('PATHWAY Netlify function failed to initialize.', error);
    return jsonResponse(500, {
      error: 'The secure portal could not complete that request.',
    });
  }
}

export const config = {
  path: [
    '/proxy/api/assignments',
    '/proxy/api/customer-kits',
    '/healthz',
    // Clinic portal v3 routes; they return 404 unless CLINIC_PORTAL_ENABLED is on.
    '/proxy/clinic',
    '/proxy/apply',
    '/proxy/api/clinic/*',
    '/staff',
    '/staff/api/*',
  ],
};

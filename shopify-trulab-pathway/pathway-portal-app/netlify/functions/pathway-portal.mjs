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
  path: ['/proxy/api/assignments', '/proxy/api/customer-kits', '/healthz'],
};

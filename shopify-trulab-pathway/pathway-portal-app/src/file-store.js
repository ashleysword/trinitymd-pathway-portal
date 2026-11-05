// Restricted document bytes live outside Shopify Files (whose CDN URLs are
// public). Production uses Netlify Blobs; tests and local dev use memory.
export class MemoryFileStore {
  constructor() {
    this.files = new Map();
  }

  async put(key, bytes, metadata) {
    this.files.set(key, { bytes: Buffer.from(bytes), metadata: { ...metadata } });
  }

  async get(key) {
    const file = this.files.get(key);
    return file ? { bytes: Buffer.from(file.bytes), metadata: { ...file.metadata } } : null;
  }
}

export class NetlifyBlobFileStore {
  constructor({ storeName = 'clinic-portal-documents' } = {}) {
    this.storeName = storeName;
    this.storePromise = null;
  }

  async store() {
    if (!this.storePromise) {
      this.storePromise = import('@netlify/blobs').then(({ getStore }) => getStore({ name: this.storeName, consistency: 'strong' }));
    }
    return this.storePromise;
  }

  async put(key, bytes, metadata) {
    const store = await this.store();
    await store.set(key, bytes, { metadata });
  }

  async get(key) {
    const store = await this.store();
    const result = await store.getWithMetadata(key, { type: 'arrayBuffer' });
    return result ? { bytes: Buffer.from(result.data), metadata: result.metadata || {} } : null;
  }
}

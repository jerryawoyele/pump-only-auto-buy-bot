import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export class ListenerState {
  constructor(path) {
    this.path = resolve(path);
    this.data = {
      lastSignature: null,
      lastSlot: null,
      updatedAt: null
    };
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        lastSignature: typeof parsed.lastSignature === 'string' ? parsed.lastSignature : null,
        lastSlot: Number.isFinite(Number(parsed.lastSlot)) ? Number(parsed.lastSlot) : null,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    return this.data;
  }

  get cursor() {
    return this.data;
  }

  async saveCursor(signature, slot = null) {
    if (!signature) {
      return;
    }

    this.data = {
      lastSignature: signature,
      lastSlot: Number.isFinite(Number(slot)) ? Number(slot) : null,
      updatedAt: new Date().toISOString()
    };

    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

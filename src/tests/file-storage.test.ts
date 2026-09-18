import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {
  FileStorePurposes,
  LinkedFileStorage,
} from '../utils/LinkedFileStorage';
import type {IFileStore, SaveFileOptions} from '../interfaces/IFileStore';
import {normalizeSaveFileOptions} from '../interfaces/IFileStore';

type SaveCall = {
  filePath: string;
  options?: SaveFileOptions | string;
  preventDuplicates?: boolean;
};

class FakeFileStore implements IFileStore {
  readonly accessURL: string;
  initCalls = 0;
  saveCalls: SaveCall[] = [];

  constructor(accessURL: string) {
    this.accessURL = accessURL;
  }

  async init(): Promise<any> {
    this.initCalls++;
  }

  async deleteFile(): Promise<void> {}

  async fileExists(): Promise<boolean> {
    return false;
  }

  async getFile(): Promise<Buffer | null> {
    return null;
  }

  async listFiles(): Promise<string[]> {
    return [];
  }

  async saveFile(
    filePath: string,
    _fileContent: unknown,
    options?: SaveFileOptions | string,
    preventDuplicates?: boolean,
  ): Promise<string | null> {
    this.saveCalls.push({filePath, options, preventDuplicates});
    return filePath;
  }
}

const reset = () => (LinkedFileStorage as any).resetForTests();

let infoSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  reset();
  infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
  reset();
});

describe('LinkedFileStorage purpose registry', () => {
  test('setStore then getStore returns that store and calls init()', () => {
    const store = new FakeFileStore('https://assets.example.com');
    LinkedFileStorage.setStore(FileStorePurposes.appAssets, store);

    expect(LinkedFileStorage.getStore(FileStorePurposes.appAssets)).toBe(store);
    expect(store.initCalls).toBe(1);
  });

  test('registered but unconfigured falls back to the default store and logs once', () => {
    const defaultStore = new FakeFileStore('https://uploads.example.com');
    LinkedFileStorage.setDefaultStore(defaultStore);

    expect(LinkedFileStorage.getStore(FileStorePurposes.appAssets)).toBe(defaultStore);
    expect(LinkedFileStorage.getStore(FileStorePurposes.appAssets)).toBe(defaultStore);
    expect(LinkedFileStorage.getStore(FileStorePurposes.appAssets)).toBe(defaultStore);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0][0])).toContain(FileStorePurposes.appAssets);
  });

  test('the one-time log is per purpose', () => {
    LinkedFileStorage.setDefaultStore(new FakeFileStore('https://uploads.example.com'));
    LinkedFileStorage.registerPurpose('captures');

    LinkedFileStorage.getStore(FileStorePurposes.appAssets);
    LinkedFileStorage.getStore('captures');
    LinkedFileStorage.getStore(FileStorePurposes.appAssets);

    expect(infoSpy).toHaveBeenCalledTimes(2);
  });

  test('an unregistered purpose throws, listing the known purposes', () => {
    LinkedFileStorage.setDefaultStore(new FakeFileStore('https://uploads.example.com'));

    expect(() => LinkedFileStorage.getStore('appAsset')).toThrow(
      /Unknown file store purpose 'appAsset'/,
    );
    expect(() => LinkedFileStorage.getStore('appAsset')).toThrow(/uploads/);
    expect(() => LinkedFileStorage.getStore('appAsset')).toThrow(/appAssets/);
  });

  test('registered and unconfigured with no default store throws about the default', () => {
    expect(() => LinkedFileStorage.getStore(FileStorePurposes.appAssets)).toThrow(
      /no default store is configured/,
    );
  });

  test('setStore auto-registers, so a later getStore does not throw', () => {
    const store = new FakeFileStore('https://captures.example.com');
    LinkedFileStorage.setStore('captures', store);

    expect(LinkedFileStorage.getStore('captures')).toBe(store);
    expect(
      LinkedFileStorage.listPurposes().map((entry) => entry.purpose),
    ).toContain('captures');
  });

  test('uploads and appAssets are registered out of the box', () => {
    const purposes = LinkedFileStorage.listPurposes();
    const names = purposes.map((entry) => entry.purpose);

    expect(names).toContain(FileStorePurposes.uploads);
    expect(names).toContain(FileStorePurposes.appAssets);
    expect(purposes.every((entry) => entry.configured === false)).toBe(true);
  });

  test('hasStore is false for a fallback and true for a configured purpose', () => {
    LinkedFileStorage.setDefaultStore(new FakeFileStore('https://uploads.example.com'));

    expect(LinkedFileStorage.hasStore(FileStorePurposes.appAssets)).toBe(false);
    // Even after resolving through the fallback it stays unconfigured.
    LinkedFileStorage.getStore(FileStorePurposes.appAssets);
    expect(LinkedFileStorage.hasStore(FileStorePurposes.appAssets)).toBe(false);

    LinkedFileStorage.setStore(
      FileStorePurposes.appAssets,
      new FakeFileStore('https://assets.example.com'),
    );
    expect(LinkedFileStorage.hasStore(FileStorePurposes.appAssets)).toBe(true);
  });

  test('accessURLFor returns the configured URL, or the default URL on fallback', () => {
    LinkedFileStorage.setDefaultStore(new FakeFileStore('https://uploads.example.com'));

    expect(LinkedFileStorage.accessURLFor(FileStorePurposes.appAssets)).toBe(
      'https://uploads.example.com',
    );

    LinkedFileStorage.setStore(
      FileStorePurposes.appAssets,
      new FakeFileStore('https://assets.example.com'),
    );
    expect(LinkedFileStorage.accessURLFor(FileStorePurposes.appAssets)).toBe(
      'https://assets.example.com',
    );
  });

  test('listPurposes reports descriptions and configured state', () => {
    LinkedFileStorage.registerPurpose('captures', {description: 'Capture artifacts.'});
    const captures = LinkedFileStorage.listPurposes().find(
      (entry) => entry.purpose === 'captures',
    );

    expect(captures).toEqual({
      purpose: 'captures',
      description: 'Capture artifacts.',
      configured: false,
    });
  });
});

describe('LinkedFileStorage default store rename', () => {
  test('the deprecated dataset aliases still work and share one store', () => {
    const store = new FakeFileStore('https://uploads.example.com');
    LinkedFileStorage.setDefaultDataset(store);

    expect(LinkedFileStorage.getDefaultStore()).toBe(store);
    expect(LinkedFileStorage.getDefaultDataset()).toBe(store);
    expect(LinkedFileStorage.getDefaultDataset()).toBe(
      LinkedFileStorage.getDefaultStore(),
    );
    expect(store.initCalls).toBe(1);

    const other = new FakeFileStore('https://other.example.com');
    LinkedFileStorage.setDefaultStore(other);
    expect(LinkedFileStorage.getDefaultDataset()).toBe(other);
  });

  test('accessURL follows the default store', () => {
    LinkedFileStorage.setDefaultAccessURL('https://fallback.example.com');
    expect(LinkedFileStorage.accessURL).toBe('https://fallback.example.com');

    LinkedFileStorage.setDefaultStore(new FakeFileStore('https://uploads.example.com'));
    expect(LinkedFileStorage.accessURL).toBe('https://uploads.example.com');
  });
});

describe('LinkedFileStorage.saveFile options passthrough', () => {
  test('forwards SaveFileOptions to the default store', async () => {
    const store = new FakeFileStore('https://uploads.example.com');
    LinkedFileStorage.setDefaultStore(store);

    const options: SaveFileOptions = {
      mimeType: 'application/javascript',
      cacheControl: 'public, max-age=31536000, immutable',
      metadata: {release: '1.2.3'},
    };
    await LinkedFileStorage.saveFile('/bundle.js', 'content', options);

    expect(store.saveCalls).toHaveLength(1);
    expect(store.saveCalls[0].filePath).toBe('/bundle.js');
    expect(store.saveCalls[0].options).toEqual(options);
  });

  test('still accepts a positional mime-type string with preventDuplicates', async () => {
    const store = new FakeFileStore('https://uploads.example.com');
    LinkedFileStorage.setDefaultStore(store);

    await LinkedFileStorage.saveFile('/photo.webp', 'content', 'image/webp', true);

    expect(store.saveCalls[0].options).toBe('image/webp');
    expect(store.saveCalls[0].preventDuplicates).toBe(true);
  });
});

describe('normalizeSaveFileOptions', () => {
  test('reads a string as the positional mimeType', () => {
    expect(normalizeSaveFileOptions('image/webp', true)).toEqual({
      mimeType: 'image/webp',
      preventDuplicates: true,
    });
    expect(normalizeSaveFileOptions('image/webp')).toEqual({
      mimeType: 'image/webp',
      preventDuplicates: false,
    });
  });

  test('keeps an options object and defaults preventDuplicates', () => {
    expect(
      normalizeSaveFileOptions({mimeType: 'text/css', cacheControl: 'no-store'}),
    ).toEqual({
      mimeType: 'text/css',
      cacheControl: 'no-store',
      preventDuplicates: false,
    });
    expect(normalizeSaveFileOptions({preventDuplicates: true}, false)).toEqual({
      preventDuplicates: true,
    });
    expect(normalizeSaveFileOptions(undefined, true)).toEqual({
      preventDuplicates: true,
    });
  });
});

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

  test('a two-argument call forwards preventDuplicates as undefined, not false', async () => {
    const store = new FakeFileStore('https://uploads.example.com');
    LinkedFileStorage.setDefaultStore(store);

    await LinkedFileStorage.saveFile('/photo.webp', 'content');

    // "Unspecified" must reach the store: LocalFileStore defaults to true and
    // would start overwriting if core materialised a false here.
    expect(store.saveCalls[0].preventDuplicates).toBeUndefined();
    expect(store.saveCalls[0].options).toBeUndefined();
    expect(
      normalizeSaveFileOptions(
        store.saveCalls[0].options,
        store.saveCalls[0].preventDuplicates,
      ).preventDuplicates,
    ).toBeUndefined();
  });

  test('an explicit positional preventDuplicates is forwarded verbatim', async () => {
    const store = new FakeFileStore('https://uploads.example.com');
    LinkedFileStorage.setDefaultStore(store);

    await LinkedFileStorage.saveFile('/a.webp', 'content', 'image/webp', false);
    await LinkedFileStorage.saveFile('/b.webp', 'content', 'image/webp', true);

    expect(store.saveCalls[0].preventDuplicates).toBe(false);
    expect(store.saveCalls[1].preventDuplicates).toBe(true);
  });

  test('an explicit preventDuplicates in the options object is forwarded verbatim', async () => {
    const store = new FakeFileStore('https://uploads.example.com');
    LinkedFileStorage.setDefaultStore(store);

    await LinkedFileStorage.saveFile('/a.webp', 'content', {
      preventDuplicates: false,
    });
    await LinkedFileStorage.saveFile('/b.webp', 'content', {
      preventDuplicates: true,
    });

    expect(store.saveCalls[0].options).toEqual({preventDuplicates: false});
    expect(store.saveCalls[1].options).toEqual({preventDuplicates: true});
    expect(store.saveCalls[0].preventDuplicates).toBeUndefined();
    expect(store.saveCalls[1].preventDuplicates).toBeUndefined();
  });

  test('options.preventDuplicates wins over the positional argument', async () => {
    const store = new FakeFileStore('https://uploads.example.com');
    LinkedFileStorage.setDefaultStore(store);

    await LinkedFileStorage.saveFile(
      '/a.webp',
      'content',
      {mimeType: 'image/webp', preventDuplicates: true},
      false,
    );

    const call = store.saveCalls[0];
    expect(normalizeSaveFileOptions(call.options, call.preventDuplicates)).toEqual({
      mimeType: 'image/webp',
      preventDuplicates: true,
    });
  });
});

describe('LinkedFileStorage uploads purpose', () => {
  test('setDefaultStore configures uploads, silently', () => {
    const store = new FakeFileStore('https://uploads.example.com');
    LinkedFileStorage.setDefaultStore(store);

    expect(LinkedFileStorage.getStore(FileStorePurposes.uploads)).toBe(store);
    expect(infoSpy).not.toHaveBeenCalled();
    expect(LinkedFileStorage.hasStore(FileStorePurposes.uploads)).toBe(true);
    expect(LinkedFileStorage.accessURLFor(FileStorePurposes.uploads)).toBe(
      'https://uploads.example.com',
    );

    const uploads = LinkedFileStorage.listPurposes().find(
      (entry) => entry.purpose === FileStorePurposes.uploads,
    );
    expect(uploads).toMatchObject({
      purpose: FileStorePurposes.uploads,
      configured: true,
    });
  });

  test('the deprecated setDefaultDataset alias configures uploads too', () => {
    const store = new FakeFileStore('https://uploads.example.com');
    LinkedFileStorage.setDefaultDataset(store);

    expect(LinkedFileStorage.getStore(FileStorePurposes.uploads)).toBe(store);
    expect(store.initCalls).toBe(1);
  });

  test('an explicit setStore(uploads, other) overrides the default store', () => {
    const defaultStore = new FakeFileStore('https://uploads.example.com');
    const other = new FakeFileStore('https://media.example.com');
    LinkedFileStorage.setDefaultStore(defaultStore);
    LinkedFileStorage.setStore(FileStorePurposes.uploads, other);

    expect(LinkedFileStorage.getStore(FileStorePurposes.uploads)).toBe(other);
    expect(LinkedFileStorage.getDefaultStore()).toBe(defaultStore);
    expect(LinkedFileStorage.accessURLFor(FileStorePurposes.uploads)).toBe(
      'https://media.example.com',
    );
  });

  test('resetForTests clears the uploads configuration', () => {
    LinkedFileStorage.setDefaultStore(new FakeFileStore('https://uploads.example.com'));
    reset();

    expect(LinkedFileStorage.hasStore(FileStorePurposes.uploads)).toBe(false);
    expect(
      LinkedFileStorage.listPurposes().map((entry) => entry.purpose),
    ).toContain(FileStorePurposes.uploads);
  });
});

describe('normalizeSaveFileOptions', () => {
  test('reads a string as the positional mimeType', () => {
    expect(normalizeSaveFileOptions('image/webp', true)).toEqual({
      mimeType: 'image/webp',
      preventDuplicates: true,
    });
    expect(normalizeSaveFileOptions('image/webp', false)).toEqual({
      mimeType: 'image/webp',
      preventDuplicates: false,
    });
  });

  test('the string form leaves an absent preventDuplicates undefined', () => {
    const normalized = normalizeSaveFileOptions('image/webp');

    expect(normalized.mimeType).toBe('image/webp');
    expect(normalized.preventDuplicates).toBeUndefined();
  });

  test('the object form is kept as given', () => {
    expect(
      normalizeSaveFileOptions({
        mimeType: 'text/css',
        cacheControl: 'no-store',
        metadata: {release: '1.2.3'},
      }),
    ).toEqual({
      mimeType: 'text/css',
      cacheControl: 'no-store',
      metadata: {release: '1.2.3'},
    });
    expect(normalizeSaveFileOptions({preventDuplicates: false})).toEqual({
      preventDuplicates: false,
    });
  });

  test('both absent leaves preventDuplicates undefined, never false', () => {
    // The store — not this helper — decides the default.
    expect(normalizeSaveFileOptions().preventDuplicates).toBeUndefined();
    expect(
      normalizeSaveFileOptions({mimeType: 'text/css'}).preventDuplicates,
    ).toBeUndefined();
    expect(normalizeSaveFileOptions(undefined, undefined).preventDuplicates)
      .toBeUndefined();
  });

  test('options.preventDuplicates wins over the positional argument', () => {
    expect(
      normalizeSaveFileOptions({preventDuplicates: true}, false).preventDuplicates,
    ).toBe(true);
    expect(
      normalizeSaveFileOptions({preventDuplicates: false}, true).preventDuplicates,
    ).toBe(false);
    // The positional value is used only when the object says nothing.
    expect(
      normalizeSaveFileOptions({mimeType: 'text/css'}, true).preventDuplicates,
    ).toBe(true);
    expect(normalizeSaveFileOptions(undefined, true).preventDuplicates).toBe(true);
  });
});

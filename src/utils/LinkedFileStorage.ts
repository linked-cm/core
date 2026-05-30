import {IFileStore} from '../interfaces/IFileStore.js';
import type {Readable} from 'stream';

export abstract class LinkedFileStorage {
  private static defaultDataset: IFileStore;
  private static url: string; // default accessURL

  static get accessURL(): string {
    // check if default store is not set, return default accessURL
    if (!this.defaultDataset) {
      return this.url;
    }

    return this.defaultDataset.accessURL;
  }

  static setDefaultAccessURL(accessURL: string): string {
    return (this.url = accessURL);
  }

  static getDefaultDataset(): IFileStore {
    return this.defaultDataset;
  }

  static setDefaultDataset(dataset: IFileStore) {
    this.defaultDataset = dataset;

    if (this.defaultDataset.init) {
      this.defaultDataset.init();
    }
  }

  static deleteFile(filePath: string): Promise<void> {
    return this.defaultDataset.deleteFile(filePath);
  }

  static fileExists(filePath: string): Promise<boolean> {
    return this.defaultDataset.fileExists(filePath);
  }

  static getFile(filePath: string): Promise<Buffer> {
    return this.defaultDataset.getFile(filePath);
  }

  static listFiles(prefix?: string): Promise<string[]> {
    return this.defaultDataset.listFiles(prefix);
  }

  static saveFile(
    filePath: string,
    fileContent: string | Uint8Array | Buffer | Readable,
    mimeType?: string,
    preventDuplicates: boolean = false,
  ): Promise<string> {
    return this.defaultDataset.saveFile(
      filePath,
      fileContent,
      mimeType,
      preventDuplicates,
    );
  }
}

/**
 * Get the full path of an asset based on the way LinkedFileStorage is configured
 * Returns accessURL + directory (/public by default) + path
 * @param path asset path
 * @param directory asset directory (optional, default is /public)
 * @returns asset url. e.g. https://cdn.example.com/public/image.png
 */
export function asset(path: string, directory: string = '/public'): string {
  // Some callers pass a raw app-relative path like `/images/foo.webp`, while
  // others may already have a fully qualified asset URL from an earlier
  // `asset(...)` call or backend response normalization. Keep this helper
  // idempotent so shared card/image components can safely call `asset(...)`
  // without duplicating the access URL prefix.
  if (/^(?:[a-z]+:)?\/\//i.test(path) || path.startsWith('data:') || path.startsWith('blob:')) {
    return path;
  }

  const accessURL = LinkedFileStorage.accessURL;
  const assetUrl = accessURL + directory + path;
  return assetUrl;
}

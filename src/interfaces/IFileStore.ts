import type {Readable} from 'stream';

/**
 * Options for `IFileStore.saveFile`.
 *
 * Passed as the third argument. A plain `string` is still accepted there and is
 * read as the old positional `mimeType`, so existing callers keep working.
 */
export interface SaveFileOptions {
  /** Content type of the stored bytes, e.g. `image/webp`. */
  mimeType?: string;
  /** Cache header the store should attach, e.g. `public, max-age=31536000, immutable`. */
  cacheControl?: string;
  /** Store-level user metadata, when the backing store supports it. */
  metadata?: Record<string, string>;
  /** Rename instead of overwriting when the path is already taken. */
  preventDuplicates?: boolean;
}

/**
 * Metadata of a stored file, for verify-after-upload.
 *
 * `sha256` is only set when the store can actually report a content hash; a
 * caller that does not get one must treat the file as "cannot verify" rather
 * than falling back to `etag`, which is not a content hash on S3.
 */
export interface FileStat {
  size: number;
  /** Only when the store can report it. */
  sha256?: string;
  etag?: string;
}

export interface IFileStore {
  /**
   * The base URL to access the filestore's files. For example:
   * - http://localhost:4000
   * - https://s3.amazonaws.com/my-bucket
   * - https://my-bucket.nyc3.digitaloceanspaces.com
   */
  readonly accessURL: string;

  init?(): Promise<any>;

  deleteFile(filePath: string): Promise<void>;

  fileExists(filePath: string): Promise<boolean>;

  getFile(filePath: string): Promise<Buffer | null>;

  listFiles(prefix?: string): Promise<string[]>;

  saveFile(
    filePath: string,
    fileContent: string | Uint8Array | Buffer | Readable,
    /** `SaveFileOptions`, or a `string` read as the old positional `mimeType`. */
    options?: SaveFileOptions | string,
    /** Only honoured when `options` is a string; otherwise use `options.preventDuplicates`. */
    preventDuplicates?: boolean,
  ): Promise<string | null>;

  /**
   * Optional. Metadata of a stored file, for verify-after-upload.
   * Resolves to `null` when the file does not exist.
   *
   * Optional by design (plan 011 D7): a store without it still publishes, and
   * the caller simply skips verification.
   */
  statFile?(filePath: string): Promise<FileStat | null>;
}

/**
 * Normalise `saveFile`'s widened third argument into a single options object.
 * Every `IFileStore` implementation should call this first, so the positional
 * mime-type form and the options form cannot drift apart.
 */
export function normalizeSaveFileOptions(
  options?: SaveFileOptions | string,
  preventDuplicates?: boolean,
): SaveFileOptions {
  if (typeof options === 'string') {
    return {mimeType: options, preventDuplicates: preventDuplicates ?? false};
  }
  return {
    ...(options ?? {}),
    preventDuplicates: options?.preventDuplicates ?? preventDuplicates ?? false,
  };
}

export interface ArtifactDestination {
  bucket: string;
  prefix: string;
  endpoint?: string;
  publicBaseUrl?: string;
}

export interface PutArtifactInput {
  key: string;
  body: string | Uint8Array | Buffer;
  contentType: string;
  cacheControl: string;
  sha256: string;
}

export interface PutArtifactResult {
  key: string;
  eTag?: string;
}

export interface ArtifactMetadata {
  key: string;
  size: number;
  sha256?: string;
  contentType?: string;
  cacheControl?: string;
  eTag?: string;
}

/**
 * Restricted object-storage capability used by immutable app releases.
 * Deliberately excludes deletion and listing operations.
 */
export interface IArtifactStore {
  describeDestination(): ArtifactDestination;
  putArtifact(input: PutArtifactInput): Promise<PutArtifactResult>;
  statArtifact(key: string): Promise<ArtifactMetadata>;
}


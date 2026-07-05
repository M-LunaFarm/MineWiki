declare module 'file-type' {
  import type { Buffer } from 'node:buffer';

  export interface FileTypeResult {
    readonly ext: string;
    readonly mime: string;
  }

  export function fromBuffer(buffer: Buffer): Promise<FileTypeResult | undefined>;
  export function fileTypeFromBuffer(
    buffer: Buffer | Uint8Array | ArrayBuffer
  ): Promise<FileTypeResult | undefined>;
}

declare module 'sharp' {
  import type { Buffer } from 'node:buffer';

  interface SharpMetadata {
    width?: number;
    height?: number;
  }

  interface SharpInstance {
    removeAlpha(): SharpInstance;
    metadata(): Promise<SharpMetadata>;
    rotate(): SharpInstance;
    resize(options?: {
      width?: number;
      height?: number;
      fit?: 'inside' | 'cover' | 'contain' | 'fill' | 'outside';
      withoutEnlargement?: boolean;
    }): SharpInstance;
    withMetadata(metadata?: { exif?: unknown; icc?: unknown }): SharpInstance;
    toFormat(format: string, options?: { quality?: number }): SharpInstance;
    toBuffer(): Promise<Buffer>;
  }

  interface SharpOptions {
    failOn?: 'none' | 'warning' | 'truncated';
  }

  function sharp(input?: Buffer, options?: SharpOptions): SharpInstance;

  export default sharp;
}

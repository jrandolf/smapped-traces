import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { SourceMapStore } from "smapped-traces/store";

/**
 * Options for creating an S3-compatible source map store.
 */
export interface S3StoreOptions {
  /** S3 bucket name. */
  bucket: string;
  /** Pre-configured S3 client. Works with AWS S3, GCS, and Cloudflare R2. */
  client: S3Client;
  /** Key prefix for source map objects (e.g. "sourcemaps/"). */
  prefix?: string;
}

/**
 * Creates a source map store backed by an S3-compatible bucket.
 *
 * Works with AWS S3, Google Cloud Storage, and Cloudflare R2 — any service
 * that supports the S3 API.
 *
 * @example
 * ```ts
 * import { S3Client } from '@aws-sdk/client-s3'
 * import { createS3Store } from 'smapped-traces-s3'
 *
 * const store = createS3Store({
 *   client: new S3Client({ region: 'us-east-1' }),
 *   bucket: 'my-sourcemaps',
 *   prefix: 'sourcemaps/',
 * })
 * ```
 */
export function createS3Store(options: S3StoreOptions): SourceMapStore {
  const { client, bucket, prefix = "" } = options;

  function key(debugId: string): string {
    return `${prefix}${debugId}`;
  }

  return {
    async get(debugId) {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key(debugId) })
        );
        return response.Body ? await response.Body.transformToString() : null;
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "NoSuchKey") {
          return null;
        }
        throw error;
      }
    },

    async put(debugId, content) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key(debugId),
          Body: content,
          ContentType: "application/json",
        })
      );
    },
  };
}

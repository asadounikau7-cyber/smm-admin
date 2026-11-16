import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import { env } from "./env";

let client: S3Client | null = null;

export function b2(): S3Client {
  if (client) return client;
  const e = env();
  if (!e.B2_ENDPOINT || !e.B2_KEY_ID || !e.B2_APP_KEY) throw new Error("B2 не настроен (B2_ENDPOINT, B2_KEY_ID, B2_APP_KEY)");
  const endpoint = e.B2_ENDPOINT.startsWith("http") ? e.B2_ENDPOINT : `https://${e.B2_ENDPOINT}`;
  const region = e.B2_REGION ?? endpoint.match(/s3\.([a-z0-9-]+)\.backblazeb2/)?.[1] ?? "us-west-004";
  client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId: e.B2_KEY_ID, secretAccessKey: e.B2_APP_KEY },
    forcePathStyle: true,
  });
  return client;
}

export type RemoteObject = { key: string; versionId: string | null; etag: string | null; size: number; lastModified: Date };

/** Lists the latest version of every object under the prefix. */
export async function listObjects(prefix = env().B2_PREFIX): Promise<RemoteObject[]> {
  const out: RemoteObject[] = [];
  let token: string | undefined;
  do {
    const res = await b2().send(
      new ListObjectsV2Command({ Bucket: env().B2_BUCKET, Prefix: prefix || undefined, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) out.push(toRemote(o));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  // Version ids are optional; fall back to ETag if the key lacks permission.
  try {
    const versions = new Map<string, string>();
    let km: string | undefined;
    let vm: string | undefined;
    do {
      const res = await b2().send(
        new ListObjectVersionsCommand({ Bucket: env().B2_BUCKET, Prefix: prefix || undefined, KeyMarker: km, VersionIdMarker: vm }),
      );
      for (const v of res.Versions ?? []) if (v.IsLatest && v.Key && v.VersionId) versions.set(v.Key, v.VersionId);
      km = res.IsTruncated ? res.NextKeyMarker : undefined;
      vm = res.IsTruncated ? res.NextVersionIdMarker : undefined;
    } while (km);
    for (const o of out) o.versionId = versions.get(o.key) ?? null;
  } catch {
    /* ignore */
  }
  return out.filter((o) => !o.key.endsWith("/"));
}

function toRemote(o: _Object): RemoteObject {
  return {
    key: o.Key!,
    versionId: null,
    etag: o.ETag?.replaceAll('"', "") ?? null,
    size: Number(o.Size ?? 0),
    lastModified: o.LastModified ?? new Date(),
  };
}

export async function headObject(key: string) {
  return b2().send(new HeadObjectCommand({ Bucket: env().B2_BUCKET, Key: key }));
}

/** Time-limited URL for external APIs (Instagram fetches the video by URL) and previews. */
export async function presign(key: string, versionId?: string | null, seconds = 3600) {
  const v = versionId && !versionId.startsWith("etag:") ? versionId : undefined;
  return getSignedUrl(b2(), new GetObjectCommand({ Bucket: env().B2_BUCKET, Key: key, VersionId: v }), { expiresIn: seconds });
}

export async function openStream(key: string, versionId?: string | null): Promise<{ stream: Readable; size: number; contentType?: string }> {
  const v = versionId && !versionId.startsWith("etag:") ? versionId : undefined;
  const res = await b2().send(new GetObjectCommand({ Bucket: env().B2_BUCKET, Key: key, VersionId: v }));
  return { stream: res.Body as Readable, size: Number(res.ContentLength ?? 0), contentType: res.ContentType };
}

export async function openRange(key: string, versionId: string | null | undefined, start: number) {
  const v = versionId && !versionId.startsWith("etag:") ? versionId : undefined;
  const res = await b2().send(new GetObjectCommand({ Bucket: env().B2_BUCKET, Key: key, VersionId: v, Range: `bytes=${start}-` }));
  return { stream: res.Body as Readable, size: Number(res.ContentLength ?? 0) };
}

export async function readAll(key: string, versionId?: string | null): Promise<Buffer> {
  const { stream } = await openStream(key, versionId);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

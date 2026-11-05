import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { v2 as cloudinary } from 'cloudinary';
import { Types } from 'mongoose';
import { ALLOWED_MIME, type MediaUrlDTO, type SignUploadInput, type SignedUpload } from '@strata/shared';
import { getEnv } from '../../config/env.js';
import { AppError, notFound } from '../../lib/errors.js';
import { randomToken, signMediaUrl } from '../../lib/tokens.js';
import { MediaAsset, type IMediaAsset } from '../../models/media.js';
import { requireMember, requireRead } from '../access.js';

const URL_TTL_MS = 5 * 60_000;

const rejected = (message: string) => new AppError(415, 'MEDIA_REJECTED', message);

/** Media storage behind one interface. Disk is a real implementation for development. Cloudinary is for production. */
interface MediaProvider {
  name: 'cloudinary' | 'disk';
  sign(asset: IMediaAsset): SignedUpload;
  verify(asset: IMediaAsset): Promise<void>;
  url(asset: IMediaAsset): MediaUrlDTO;
  remove(asset: IMediaAsset): Promise<void>;
}

const diskPath = (key: string) => path.join(path.resolve(getEnv().MEDIA_DIR), path.basename(key));

const diskProvider: MediaProvider = {
  name: 'disk',
  sign: (asset) => ({
    assetId: String(asset._id),
    provider: 'disk',
    url: `/api/media/${String(asset._id)}/upload`,
    fields: {},
    headers: { 'content-type': 'application/octet-stream' },
  }),
  verify: async () => {},
  url(asset) {
    const expiresAt = Date.now() + URL_TTL_MS;
    const sig = signMediaUrl(String(asset._id), expiresAt);
    return {
      url: `/api/media/${String(asset._id)}/file?exp=${expiresAt}&sig=${sig}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  },
  remove: (asset) => rm(diskPath(asset.key), { force: true }),
};

function cloudinaryConfig() {
  const env = getEnv();
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  return env;
}

/** `authenticated` assets can't be fetched by guessing a URL: delivery needs a signature that we issue per request. */
const cloudinaryProvider: MediaProvider = {
  name: 'cloudinary',
  sign(asset) {
    const env = cloudinaryConfig();
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { public_id: asset.key, timestamp, type: 'authenticated' };
    const signature = cloudinary.utils.api_sign_request(params, env.CLOUDINARY_API_SECRET!);
    return {
      assetId: String(asset._id),
      provider: 'cloudinary',
      url: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/auto/upload`,
      fields: {
        public_id: asset.key,
        timestamp: String(timestamp),
        type: 'authenticated',
        api_key: env.CLOUDINARY_API_KEY!,
        signature,
      },
      headers: {},
    };
  },
  async verify(asset) {
    cloudinaryConfig();
    const resourceType = ALLOWED_MIME[asset.mime]?.image ? 'image' : 'raw';
    const stored = (await cloudinary.api.resource(asset.key, { type: 'authenticated', resource_type: resourceType })) as { bytes: number };
    if (stored.bytes > (ALLOWED_MIME[asset.mime]?.maxBytes ?? 0)) {
      await this.remove(asset);
      throw rejected('That file is too large');
    }
  },
  url(asset) {
    cloudinaryConfig();
    const expiresSeconds = Math.floor((Date.now() + URL_TTL_MS) / 1000);
    const resourceType = ALLOWED_MIME[asset.mime]?.image ? 'image' : 'raw';
    const format = path.extname(asset.name).slice(1) || 'bin';
    const url = cloudinary.utils.private_download_url(asset.key, format, {
      type: 'authenticated',
      resource_type: resourceType,
      expires_at: expiresSeconds,
    });
    return { url, expiresAt: new Date(expiresSeconds * 1000).toISOString() };
  },
  async remove(asset) {
    cloudinaryConfig();
    await cloudinary.uploader.destroy(asset.key, {
      type: 'authenticated',
      resource_type: ALLOWED_MIME[asset.mime]?.image ? 'image' : 'raw',
    });
  },
};

const provider = (name: string = getEnv().MEDIA_PROVIDER): MediaProvider => (name === 'cloudinary' ? cloudinaryProvider : diskProvider);

export async function signUpload(userId: string, input: SignUploadInput): Promise<SignedUpload> {
  await requireMember(input.roomId, userId);
  const rule = ALLOWED_MIME[input.mime];
  if (!rule) throw rejected('That file type is not allowed');
  if (input.bytes > rule.maxBytes) throw rejected('That file is too large');

  const chosen = provider();
  const asset = await MediaAsset.create({
    roomId: input.roomId,
    uploaderId: userId,
    provider: chosen.name,
    key: `strata/${input.roomId}/${randomToken(16)}`.replaceAll('/', chosen.name === 'disk' ? '_' : '/'),
    name: input.name,
    mime: input.mime,
    bytes: input.bytes,
  });
  return chosen.sign(asset.toObject());
}

const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'application/zip': (b) => b[0] === 0x50 && b[1] === 0x4b,
  'text/plain': (b) => !b.subarray(0, 4096).includes(0),
};

/** The disk upload target. The declared type is only a claim, so the bytes have to match it. */
export async function storeDiskUpload(assetId: string, userId: string, body: Buffer) {
  const asset = await MediaAsset.findOne({ _id: assetId, uploaderId: userId, provider: 'disk', status: 'pending' }).lean();
  if (!asset) throw notFound('Upload');
  if (body.length === 0 || body.length > (ALLOWED_MIME[asset.mime]?.maxBytes ?? 0)) throw rejected('That file is too large');
  if (!SIGNATURES[asset.mime]?.(body)) throw rejected('The file contents do not match its type');

  await mkdir(path.resolve(getEnv().MEDIA_DIR), { recursive: true });
  await writeFile(diskPath(asset.key), body);
  await MediaAsset.updateOne({ _id: asset._id }, { bytes: body.length });
}

export async function completeUpload(assetId: string, userId: string, dims: { width?: number; height?: number }) {
  const asset = await MediaAsset.findOne({ _id: assetId, uploaderId: userId, status: 'pending' }).lean();
  if (!asset) throw notFound('Upload');
  await provider(asset.provider).verify(asset);
  await MediaAsset.updateOne({ _id: asset._id }, { status: 'ready', ...dims });
  return { id: assetId, name: asset.name, mime: asset.mime };
}

async function urlFor(asset: IMediaAsset) {
  return provider(asset.provider).url(asset);
}

export async function mediaUrl(assetId: string, userId: string): Promise<MediaUrlDTO> {
  const asset = await MediaAsset.findOne({ _id: assetId, status: 'ready' }).lean();
  if (!asset) throw notFound('File');
  await requireRead(String(asset.roomId), userId);
  return urlFor(asset);
}

export async function guestMediaUrl(assetId: string, roomId: Types.ObjectId): Promise<MediaUrlDTO> {
  const asset = await MediaAsset.findOne({ _id: assetId, roomId, status: 'ready' }).lean();
  if (!asset) throw notFound('File');
  return urlFor(asset);
}

export async function readDiskFile(assetId: string) {
  const asset = await MediaAsset.findOne({ _id: assetId, provider: 'disk', status: 'ready' }).lean();
  if (!asset) throw notFound('File');
  return { asset, bytes: await readFile(diskPath(asset.key)) };
}

export async function removeAsset(assetId: string) {
  const asset = await MediaAsset.findById(assetId).lean();
  if (!asset) return;
  await provider(asset.provider).remove(asset);
  await MediaAsset.deleteOne({ _id: asset._id });
}

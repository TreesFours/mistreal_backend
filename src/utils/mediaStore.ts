import crypto from 'crypto';

/**
 * Short-lived in-memory store so an AI-generated/edited image (which only
 * exists as base64 in the response) can be handed to Zernio as a fetchable
 * URL — social DM APIs take a media URL, not inline bytes. Entries expire
 * after 15 minutes, which is plenty of time for Zernio to fetch it once right
 * after the user hits send.
 *
 * In-memory + single-process: fine at this app's current scale. If this ever
 * runs on more than one backend instance, this needs to move to shared
 * storage (S3/Cloudinary/etc.) instead.
 */
interface StoredMedia {
    buffer: Buffer;
    mimeType: string;
    expiresAt: number;
}

const store = new Map<string, StoredMedia>();
const TTL_MS = 15 * 60 * 1000;

const cleanup = () => {
    const now = Date.now();
    for (const [id, media] of store.entries()) {
        if (media.expiresAt < now) store.delete(id);
    }
};
setInterval(cleanup, 5 * 60 * 1000);

export const storeMediaBase64 = (base64: string, mimeType: string): string => {
    const id = crypto.randomBytes(16).toString('hex');
    store.set(id, { buffer: Buffer.from(base64, 'base64'), mimeType, expiresAt: Date.now() + TTL_MS });
    return id;
};

export const getStoredMedia = (id: string): StoredMedia | undefined => store.get(id);

export const buildMediaUrl = (id: string): string => {
    const baseUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
    return `${baseUrl}/media/${id}`;
};

import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { CloudStorageConfig } from '../models/CloudStorageConfig';
import { decrypt } from '../utils/secretCrypto';
import logger from '../utils/logger';

export interface CloudFile {
    name: string;
    isDirectory: boolean;
    size: number | null;
    modifiedAt: string | null;
}

const joinUrl = (baseUrl: string, path: string): string => {
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${base}${cleanPath}`;
};

/**
 * WebDAV only, for now — the first real provider behind persistToStorage's
 * dispatcher (see adRoutes.ts). No OAuth app registration needed, unlike a
 * future Google Drive/Dropbox provider: just a server URL + username +
 * password/token, so this is what proves the whole BYOK-cloud-storage
 * pipeline before anything more involved gets added.
 */
export const uploadFile = async (config: CloudStorageConfig, buffer: Buffer, contentType: string, path: string): Promise<string> => {
    const url = joinUrl(config.baseUrl, path);
    const password = decrypt(config.encryptedPassword);

    // WebDAV servers 404 a PUT into a directory that doesn't exist yet —
    // create every ancestor directory first (MKCOL on each, ignoring
    // "already exists" failures) rather than requiring the user to have
    // pre-created the folder structure themselves.
    const segments = path.split('/').filter(Boolean).slice(0, -1);
    let currentPath = '';
    for (const segment of segments) {
        currentPath += `/${segment}`;
        try {
            await axios.request({
                url: joinUrl(config.baseUrl, currentPath),
                method: 'MKCOL',
                auth: { username: config.username, password }
            });
        } catch (e: any) {
            // 405/409 here just means the directory already exists — fine.
        }
    }

    await axios.put(url, buffer, {
        auth: { username: config.username, password },
        headers: { 'Content-Type': contentType },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
    });

    return url;
};

export const listFiles = async (config: CloudStorageConfig, path: string): Promise<CloudFile[]> => {
    const url = joinUrl(config.baseUrl, path);
    const password = decrypt(config.encryptedPassword);

    const response = await axios.request({
        url,
        method: 'PROPFIND',
        auth: { username: config.username, password },
        headers: { Depth: '1', 'Content-Type': 'application/xml' },
        data: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>`
    });

    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
    const parsed = parser.parse(response.data);
    const rawResponses = parsed?.multistatus?.response;
    if (!rawResponses) return [];
    const responses = Array.isArray(rawResponses) ? rawResponses : [rawResponses];

    const requestedHref = new URL(url).pathname;

    return responses
        .map((r: any) => {
            const prop = r.propstat?.prop || r.propstat?.[0]?.prop;
            const href: string = r.href || '';
            const name = decodeURIComponent(href.replace(/\/$/, '').split('/').pop() || '');
            const isDirectory = prop?.resourcetype?.collection !== undefined;
            return {
                name,
                isDirectory,
                size: prop?.getcontentlength ? parseInt(prop.getcontentlength, 10) : null,
                modifiedAt: prop?.getlastmodified || null,
                href
            };
        })
        // The directory being listed includes itself as the first <response> — exclude it.
        .filter((f: any) => decodeURIComponent(f.href.replace(/\/$/, '')) !== decodeURIComponent(requestedHref.replace(/\/$/, '')))
        .map(({ href, ...rest }: any) => rest);
};

export const getActiveConfig = async (deviceId: string): Promise<CloudStorageConfig | null> => {
    try {
        return await CloudStorageConfig.findOne({ where: { deviceId, isActive: true } });
    } catch (e: any) {
        logger.error(`❌ cloudStorageService.getActiveConfig failed: ${e.message}`);
        return null;
    }
};

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

/**
 * At-rest encryption for user-supplied BYOK AI provider API keys. Unlike the
 * existing OAuth tokens in userModel.ts (stored plaintext), these keys are
 * directly billable against the user's own provider account, so they must
 * never be stored unencrypted. Keyed by BYOK_ENCRYPTION_KEY (must decode to
 * exactly 32 bytes from base64). Fails loud (throws) rather than silently
 * falling back to plaintext — callers must catch and surface a clear error
 * (e.g. 503) instead of letting this crash server boot or silently no-op.
 */
const getKey = (): Buffer => {
    const raw = process.env.BYOK_ENCRYPTION_KEY;
    if (!raw) {
        throw new Error('ENCRYPTION_NOT_CONFIGURED: BYOK_ENCRYPTION_KEY is not set.');
    }
    const key = Buffer.from(raw, 'base64');
    if (key.length !== KEY_LENGTH) {
        throw new Error('ENCRYPTION_NOT_CONFIGURED: BYOK_ENCRYPTION_KEY must decode to 32 bytes.');
    }
    return key;
};

export const isEncryptionConfigured = (): boolean => {
    try {
        getKey();
        return true;
    } catch {
        return false;
    }
};

export const encrypt = (plaintext: string): string => {
    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
};

export const decrypt = (packed: string): string => {
    const key = getKey();
    const [ivB64, authTagB64, ciphertextB64] = packed.split(':');
    if (!ivB64 || !authTagB64 || !ciphertextB64) {
        throw new Error('MALFORMED_CIPHERTEXT');
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertextB64, 'base64')),
        decipher.final()
    ]);
    return plaintext.toString('utf8');
};

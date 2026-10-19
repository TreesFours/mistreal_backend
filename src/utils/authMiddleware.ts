import { Request, Response, NextFunction } from 'express';
import * as admin from 'firebase-admin';
import logger from './logger';

// Professional Credential Handler
if (admin.apps.length === 0) {
    try {
        const serviceAccount = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
            ? JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
            : null;

        if (serviceAccount) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
            });
            logger.info("🛡️ Firebase Admin initialized from Environment Variable");
        } else {
            // Fallback for local development using the file path
            admin.initializeApp({
                credential: admin.credential.applicationDefault(),
            });
            logger.info("🛡️ Firebase Admin initialized via Application Default");
        }
    } catch (error: any) {
        logger.error("❌ Firebase Initialization Failed:", error.message);
    }
}

// Firebase Admin surfaces a distinct error.code per failure reason — collapsing
// all of them into one generic 401 meant the client couldn't tell "token just
// expired, silently refresh and retry" apart from "token is malformed/revoked,
// force a real re-login." expired is the one case worth a different response
// code so the client can special-case it without string-matching the message.
const describeAuthError = (error: any): { status: number; code: string; message: string } => {
    switch (error?.code) {
        case 'auth/id-token-expired':
            return { status: 401, code: 'token_expired', message: 'Unauthorized: Token expired' };
        case 'auth/id-token-revoked':
            return { status: 401, code: 'token_revoked', message: 'Unauthorized: Token revoked' };
        case 'auth/argument-error':
            return { status: 401, code: 'token_malformed', message: 'Unauthorized: Malformed token' };
        default:
            return { status: 401, code: 'token_invalid', message: 'Unauthorized: Invalid token' };
    }
};

export const authenticateUser = async (req: any, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided', code: 'token_missing' });
    }

    const idToken = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;
        next();
    } catch (error: any) {
        logger.error(`Firebase Auth Error (${error?.code}):`, error);
        const { status, code, message } = describeAuthError(error);
        return res.status(status).json({ error: message, code });
    }
};

export const optionalAuthenticateUser = async (req: any, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const idToken = authHeader.split('Bearer ')[1];
        try {
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            req.user = decodedToken;
        } catch (error) {
            logger.warn('Optional Firebase Auth Token invalid, falling back to device ID');
        }
    }
    next();
};

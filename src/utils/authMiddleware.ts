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

export const authenticateUser = async (req: any, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;
        next();
    } catch (error) {
        logger.error('Firebase Auth Error:', error);
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
};

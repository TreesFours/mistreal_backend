import { Request, Response, NextFunction } from 'express';
import * as admin from 'firebase-admin';

// Check if Firebase Admin is initialized
if (admin.apps.length === 0) {
    admin.initializeApp({
        credential: admin.credential.applicationDefault(), // Assumes GOOGLE_APPLICATION_CREDENTIALS env var
    });
}

export const authenticateUser = async (req: any, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken; // uid is in decodedToken.uid
        next();
    } catch (error) {
        console.error('Firebase Auth Error:', error);
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
};

import { google } from 'googleapis';
import logger from '../utils/logger';

const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
});

const publisher = google.androidpublisher('v3');

export const verifyPurchase = async (packageName: string, productId: string, purchaseToken: string) => {
    try {
        const client = await auth.getClient();
        google.options({ auth: client as any });

        // Use any to bypass TS error if type definitions are out of sync
        const response = await (publisher as any).purchases.subscriptions.get({
            packageName,
            subscriptionId: productId,
            token: purchaseToken,
        });

        // 0 = Pending, 1 = Active, 2 = On Hold...
        const status = response.data.paymentState;
        const expiryTime = response.data.expiryTimeMillis;

        if (status === 1 || status === 0) {
            return {
                success: true,
                expiryTime: expiryTime ? new Date(parseInt(expiryTime)) : null,
                raw: response.data
            };
        }

        return { success: false, message: `Invalid payment state: ${status}` };
    } catch (error: any) {
        logger.error(`❌ Google Play Verification Error: ${error.message}`);
        throw error;
    }
};

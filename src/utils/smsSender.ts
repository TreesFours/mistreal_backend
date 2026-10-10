import axios from 'axios';
import logger from './logger';

const TELNYX_API_URL = 'https://api.telnyx.com/v2/messages';

/**
 * Real SMS send via Telnyx — gated by the caller on the owner's
 * sms_notifications add-on being active (see addonService.ts::hasAddon);
 * this function itself just sends, it doesn't know about billing.
 */
export const sendSms = async (toPhoneNumber: string, body: string): Promise<boolean> => {
    const apiKey = process.env.TELNYX_API_KEY;
    const fromNumber = process.env.TELNYX_PHONE_NUMBER;
    if (!apiKey || !fromNumber) {
        logger.warn('⚠️ TELNYX_API_KEY or TELNYX_PHONE_NUMBER not set. SMS send skipped.');
        return false;
    }

    try {
        await axios.post(TELNYX_API_URL, {
            from: fromNumber,
            to: toPhoneNumber,
            text: body
        }, {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
        });
        logger.info(`✅ SMS sent to ${toPhoneNumber}`);
        return true;
    } catch (error: any) {
        logger.error(`❌ SMS send failed to ${toPhoneNumber}: ${error.response?.data?.errors?.[0]?.detail || error.message}`);
        return false;
    }
};

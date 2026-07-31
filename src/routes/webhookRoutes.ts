// backend/src/routes/webhookRoutes.ts
import { Router, Request, Response } from 'express';
import { WebhookService } from '../services/webhookService';
import logger from '../utils/logger';

const router = Router();

router.post('/zernio', async (req: Request, res: Response) => {
    const signature = req.headers['x-zernio-signature'] as string;
    const payload = JSON.stringify(req.body);

    // 1. Verify Security
    if (!WebhookService.verifySignature(payload, signature)) {
        logger.warn('🚫 Invalid Zernio Webhook Signature rejected.');
        return res.status(401).send('Invalid Signature');
    }

    // 2. Process Event (Asynchronous to respond to Zernio quickly)
    WebhookService.handleEvent(req.body).catch(err => {
        logger.error(`❌ Webhook Processing Error: ${err.message}`);
    });

    // 3. Respond 200 OK immediately as required by most Webhook providers
    res.status(200).send('OK');
});

export default router;

import Stripe from 'stripe';
import { User } from '../models/userModel';
import logger from '../utils/logger';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2024-06-20',
});

// Real logic to create a dynamic Stripe payment link for tiers
export const createSubscriptionSession = async (tier: string, deviceId: string) => {
    try {
        const priceMap: Record<string, string> = {
            'ai_plus': process.env.STRIPE_PRICE_AI_PLUS || 'price_placeholder_1',
            'social_plus': process.env.STRIPE_PRICE_SOCIAL_PLUS || 'price_placeholder_2',
            'elite': process.env.STRIPE_PRICE_ELITE || 'price_placeholder_3'
        };

        const priceId = priceMap[tier];
        if (!priceId || priceId.includes('placeholder')) {
            throw new Error(`Invalid or missing Price ID for tier: ${tier}. Check Render Environment Variables.`);
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'subscription',
            metadata: { deviceId }, // 🚀 CRITICAL: Store deviceId so we can update the user on success
            success_url: 'mistreal://payment-success',
            cancel_url: 'mistreal://payment-cancel',
        });

        return session.url;
    } catch (error: any) {
        logger.error(`❌ Stripe Session Error: ${error.message}`);
        throw error;
    }
};

export const handleWebhook = async (payload: Buffer, sig: string) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
        logger.warn("⚠️ STRIPE_WEBHOOK_SECRET not set. Cannot verify payments.");
        return;
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(payload, sig, webhookSecret);
    } catch (err: any) {
        throw new Error(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        const deviceId = session.metadata?.deviceId;

        if (deviceId) {
            const user = await User.findOne({ where: { deviceId } });
            if (user) {
                user.isPro = true;
                user.subscriptionTier = 'pro'; // or the specific tier name
                await user.save();
                logger.info(`💰 [STRIPE] User ${deviceId} upgraded to PRO!`);
            }
        }
    }
};

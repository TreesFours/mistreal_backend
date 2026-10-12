import Stripe from 'stripe';
import { UserAddon } from '../models/UserAddon';
import { getAddonById } from './addonCatalog';
import { recomputeIsPro } from './addonService';
import logger from '../utils/logger';

/**
 * The Stripe rail — only ever used by installs that did NOT come from the
 * Play Store (see billingRail.ts's install-source detection on the client).
 * Grants/revokes the exact same UserAddon table Play Billing does; hasAddon()
 * and recomputeIsPro() don't know or care which provider granted a row.
 *
 * Previously this file existed but its webhook was never mounted on any
 * route, so Stripe purchases did nothing in production. Fixed by actually
 * registering the webhook route with raw-body parsing in index.ts, ahead of
 * the global express.json() middleware (Stripe's signature verification
 * needs the untouched raw body, not the JSON-parsed object).
 */
const getStripe = () => new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' });

export const createCheckoutSession = async (deviceId: string, addonId: string): Promise<string> => {
    const addon = getAddonById(addonId);
    if (!addon) throw new Error(`Unknown add-on: ${addonId}`);
    if (!addon.stripePriceId) throw new Error(`${addonId} has no Stripe price configured (ADDON_${addonId.toUpperCase()}_STRIPE_PRICE_ID).`);
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured.');

    const appUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
    const session = await getStripe().checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{ price: addon.stripePriceId, quantity: 1 }],
        mode: 'subscription',
        metadata: { deviceId, addonId },
        success_url: `${appUrl}/api/payment/stripe/result?status=success`,
        cancel_url: `${appUrl}/api/payment/stripe/result?status=cancel`
    });

    if (!session.url) throw new Error('Stripe did not return a checkout URL.');
    return session.url;
};

/**
 * Parallels Play Billing's own manage-subscriptions deep link — Stripe
 * customers get the equivalent "cancel/manage here, not silently in-app"
 * destination. Any one of the device's active Stripe-provider UserAddon
 * rows carries the same stripeCustomerId, since one Stripe Checkout
 * customer covers all of a device's add-on subscriptions.
 */
export const createBillingPortalSession = async (deviceId: string): Promise<string> => {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured.');
    const row = await UserAddon.findOne({ where: { deviceId, provider: 'stripe' } });
    if (!row || !row.stripeCustomerId) throw new Error('No Stripe subscription found for this device.');

    const appUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
    const session = await getStripe().billingPortal.sessions.create({
        customer: row.stripeCustomerId,
        return_url: `${appUrl}/api/payment/stripe/result?status=success`
    });
    return session.url;
};

export const handleStripeWebhook = async (rawBody: Buffer, signature: string): Promise<void> => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
        logger.warn('⚠️ STRIPE_WEBHOOK_SECRET not set — cannot verify Stripe webhooks.');
        return;
    }

    const event = getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        const deviceId = session.metadata?.deviceId;
        const addonId = session.metadata?.addonId;
        if (!deviceId || !addonId) {
            logger.warn('⚠️ Stripe checkout.session.completed missing deviceId/addonId metadata.');
            return;
        }

        await UserAddon.upsert({
            deviceId, addonId, status: 'active', provider: 'stripe',
            stripeCustomerId: typeof session.customer === 'string' ? session.customer : null,
            stripeSubscriptionId: typeof session.subscription === 'string' ? session.subscription : null,
            expiresAt: null
        });
        await recomputeIsPro(deviceId);
        logger.info(`💰 [STRIPE] Granted ${addonId} to device ${deviceId}`);
    }

    if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
        const subscription = event.data.object as Stripe.Subscription;
        const row = await UserAddon.findOne({ where: { stripeSubscriptionId: subscription.id } });
        if (!row) return;

        const isActive = subscription.status === 'active' || subscription.status === 'trialing';
        row.status = isActive ? 'active' : 'canceled';
        await row.save();
        await recomputeIsPro(row.deviceId);
        logger.info(`💰 [STRIPE] ${row.addonId} for device ${row.deviceId} -> ${row.status} (subscription ${subscription.status})`);
    }
};

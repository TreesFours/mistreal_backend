/**
 * Single source of truth for every purchasable add-on — both the backend's
 * own grant logic and the `/api/config` response the client's Subscription
 * screen renders its checklist from read this same catalog, so adding a new
 * add-on (or repricing one) is an env-var change, not a code change on
 * either side.
 *
 * Each add-on carries BOTH a Play product ID and a Stripe price ID — the
 * client picks which one it's allowed to use based on install source (Play
 * Store installs must use Play Billing; anything else uses Stripe), not a
 * user choice. stripePriceId is null if that env var isn't set, in which
 * case the client should hide the Stripe path for that add-on entirely
 * rather than attempt a checkout that can't succeed.
 */
export interface AddonDefinition {
    id: string;
    label: string;
    description: string;
    priceUsd: string;
    playProductId: string;
    stripePriceId: string | null;
}

export const getAddonCatalog = (): AddonDefinition[] => [
    {
        id: 'ai_pro',
        label: 'AI Pro Models',
        description: 'Access to premium AI models (GPT-4, Claude, Gemini Ultra-tier).',
        priceUsd: process.env.ADDON_AI_PRO_PRICE_USD || '4.99',
        playProductId: process.env.ADDON_AI_PRO_PLAY_PRODUCT_ID || 'addon_ai_pro_monthly',
        stripePriceId: process.env.ADDON_AI_PRO_STRIPE_PRICE_ID || null
    },
    {
        id: 'extra_platforms',
        label: 'Extra Platforms',
        description: `Connect ${getExtraPlatformsCount()} more social platforms beyond the free limit.`,
        priceUsd: process.env.ADDON_EXTRA_PLATFORMS_PRICE_USD || '2.99',
        playProductId: process.env.ADDON_EXTRA_PLATFORMS_PLAY_PRODUCT_ID || 'addon_extra_platforms_monthly',
        stripePriceId: process.env.ADDON_EXTRA_PLATFORMS_STRIPE_PRICE_ID || null
    },
    {
        id: 'sms_notifications',
        label: 'SMS Notifications',
        description: 'Emergency contacts can be reached by real SMS, not just email/DM.',
        priceUsd: process.env.ADDON_SMS_PRICE_USD || '1.00',
        playProductId: process.env.ADDON_SMS_PLAY_PRODUCT_ID || 'addon_sms_notifications_monthly',
        stripePriceId: process.env.ADDON_SMS_STRIPE_PRICE_ID || null
    }
];

export const getExtraPlatformsCount = (): number =>
    parseInt(process.env.ADDON_EXTRA_PLATFORMS_COUNT || '4', 10);

export const getAddonByPlayProductId = (playProductId: string): AddonDefinition | undefined =>
    getAddonCatalog().find(a => a.playProductId === playProductId);

export const getAddonById = (id: string): AddonDefinition | undefined =>
    getAddonCatalog().find(a => a.id === id);

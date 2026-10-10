/**
 * Single source of truth for every purchasable add-on — both the backend's
 * own grant logic and the `/api/config` response the client's Subscription
 * screen renders its checklist from read this same catalog, so adding a new
 * add-on (or repricing one) is an env-var change, not a code change on
 * either side.
 */
export interface AddonDefinition {
    id: string;
    label: string;
    description: string;
    priceUsd: string;
    playProductId: string;
}

export const getAddonCatalog = (): AddonDefinition[] => [
    {
        id: 'ai_pro',
        label: 'AI Pro Models',
        description: 'Access to premium AI models (GPT-4, Claude, Gemini Ultra-tier).',
        priceUsd: process.env.ADDON_AI_PRO_PRICE_USD || '4.99',
        playProductId: process.env.ADDON_AI_PRO_PLAY_PRODUCT_ID || 'addon_ai_pro_monthly'
    },
    {
        id: 'extra_platforms',
        label: 'Extra Platforms',
        description: `Connect ${getExtraPlatformsCount()} more social platforms beyond the free limit.`,
        priceUsd: process.env.ADDON_EXTRA_PLATFORMS_PRICE_USD || '2.99',
        playProductId: process.env.ADDON_EXTRA_PLATFORMS_PLAY_PRODUCT_ID || 'addon_extra_platforms_monthly'
    },
    {
        id: 'sms_notifications',
        label: 'SMS Notifications',
        description: 'Emergency contacts can be reached by real SMS, not just email/DM.',
        priceUsd: process.env.ADDON_SMS_PRICE_USD || '1.00',
        playProductId: process.env.ADDON_SMS_PLAY_PRODUCT_ID || 'addon_sms_notifications_monthly'
    }
];

export const getExtraPlatformsCount = (): number =>
    parseInt(process.env.ADDON_EXTRA_PLATFORMS_COUNT || '4', 10);

export const getAddonByPlayProductId = (playProductId: string): AddonDefinition | undefined =>
    getAddonCatalog().find(a => a.playProductId === playProductId);

export const getAddonById = (id: string): AddonDefinition | undefined =>
    getAddonCatalog().find(a => a.id === id);

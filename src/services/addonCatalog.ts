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
    },
    {
        // Reserves the pricing/addon slot only — this unlocks the UI entry
        // point, the actual voice-cloning pipeline (recording flow + calling
        // ElevenLabs' API + swapping it in wherever TTS runs today) isn't
        // built yet. ElevenLabs itself is still BYOK: this fee is for the
        // Mistreal-side integration, not a markup on ElevenLabs' own usage,
        // which the user pays ElevenLabs directly via their own key.
        id: 'voice_cloning',
        label: 'Voice Cloning (BYOK)',
        description: 'Unlocks AI voice cloning for spoken AI replies and voice notes — bring your own ElevenLabs API key, configured in Settings.',
        priceUsd: process.env.ADDON_VOICE_CLONING_PRICE_USD || '3.99',
        playProductId: process.env.ADDON_VOICE_CLONING_PLAY_PRODUCT_ID || 'addon_voice_cloning_monthly',
        stripePriceId: process.env.ADDON_VOICE_CLONING_STRIPE_PRICE_ID || null
    },
    {
        // This fee is for Mistreal's OWN integration (the ad-account connect
        // flow + campaign UI below) — separate from Zernio's own metered
        // per-managed-ad cost, and separate again from whatever the user
        // actually spends on ad budgets with Meta/Google/etc. Same
        // three-way separation already established for voice_cloning above.
        // Price is a placeholder consistent with this catalog's existing
        // tier, not a considered business decision — change the env var
        // once a real number is picked. Functionally gated on an external
        // prerequisite this code can't verify: Zernio's own "Ads add-on"
        // must be enabled on Mistreal's Zernio workspace, or every real
        // campaign call 403s with ads_addon_required regardless of this
        // addon being purchased.
        id: 'zernio_ads',
        label: 'Business Ads (via Zernio)',
        description: 'Run real ad campaigns on Meta, Google, TikTok and more through your connected platforms — managed from inside Mistreal.',
        priceUsd: process.env.ADDON_ZERNIO_ADS_PRICE_USD || '4.99',
        playProductId: process.env.ADDON_ZERNIO_ADS_PLAY_PRODUCT_ID || 'addon_zernio_ads_monthly',
        stripePriceId: process.env.ADDON_ZERNIO_ADS_STRIPE_PRICE_ID || null
    }
];

export const getExtraPlatformsCount = (): number =>
    parseInt(process.env.ADDON_EXTRA_PLATFORMS_COUNT || '4', 10);

export const getAddonByPlayProductId = (playProductId: string): AddonDefinition | undefined =>
    getAddonCatalog().find(a => a.playProductId === playProductId);

export const getAddonById = (id: string): AddonDefinition | undefined =>
    getAddonCatalog().find(a => a.id === id);

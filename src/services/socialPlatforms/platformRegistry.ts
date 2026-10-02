import { User } from '../../models/userModel';

export interface SocialPlatformCapabilities {
  supportsFeed: boolean;
  supportsStories: boolean;
  supportsReels: boolean;
  supportsDM: boolean;
  supportsFollow: boolean;
  supportsLike: boolean;
  supportsComments: boolean;
}

export interface SocialPlatformDefinition {
  id: string;
  displayName: string;
  icon: string;
  color: string;
  capabilities: SocialPlatformCapabilities;
}

const FULL_SOCIAL: SocialPlatformCapabilities = {
  supportsFeed: true,
  supportsStories: false,
  supportsReels: false,
  supportsDM: true,
  supportsFollow: false,
  supportsLike: true,
  supportsComments: true
};

const DM_ONLY: SocialPlatformCapabilities = {
  supportsFeed: false,
  supportsStories: false,
  supportsReels: false,
  supportsDM: true,
  supportsFollow: false,
  supportsLike: false,
  supportsComments: false
};

const READ_ONLY_FEED: SocialPlatformCapabilities = {
  supportsFeed: true,
  supportsStories: false,
  supportsReels: true,
  supportsDM: false,
  supportsFollow: false,
  supportsLike: false,
  supportsComments: false
};

/**
 * 📊 ZERNIO OFFICIAL PLATFORM REGISTRY
 * All platforms are universally accessible. Limitations are determined purely
 * by the count cap allowed by the user's tier.
 *
 * `capabilities` reflects what each platform's real public API actually allows
 * (not what Zernio could theoretically proxy) so the client can hide affordances
 * a platform can't actually fulfill instead of silently failing.
 */
const PLATFORM_DEFINITIONS: Record<string, SocialPlatformDefinition> = {
  twitter: {
    id: 'twitter',
    displayName: 'X (Twitter)',
    icon: '🐦',
    color: '#1DA1F2',
    // OAuth scope already requests follows.read/follows.write (see twitterAuth.ts)
    capabilities: { ...FULL_SOCIAL, supportsFollow: true }
  },
  whatsapp: {
    id: 'whatsapp',
    displayName: 'WhatsApp',
    icon: '💬',
    color: '#25D366',
    // WhatsApp Business API has no feed/stories/follow concept at all
    capabilities: DM_ONLY
  },
  instagram: {
    id: 'instagram',
    displayName: 'Instagram',
    icon: '📷',
    color: '#E4405F',
    capabilities: { ...FULL_SOCIAL, supportsStories: true, supportsReels: true }
  },
  facebook: {
    id: 'facebook',
    displayName: 'Facebook',
    icon: 'f',
    color: '#1877F2',
    capabilities: { ...FULL_SOCIAL, supportsStories: true }
  },
  discord: {
    id: 'discord',
    displayName: 'Discord',
    icon: '👾',
    color: '#5865F2',
    capabilities: { ...FULL_SOCIAL, supportsLike: false, supportsFollow: false }
  },
  telegram: {
    id: 'telegram',
    displayName: 'Telegram',
    icon: '✈️',
    color: '#0088cc',
    capabilities: { ...DM_ONLY, supportsFeed: true, supportsComments: true }
  },
  reddit: {
    id: 'reddit',
    displayName: 'Reddit',
    icon: 'r/',
    color: '#FF4500',
    capabilities: { ...FULL_SOCIAL, supportsFollow: true, supportsDM: true }
  },
  linkedin: {
    id: 'linkedin',
    displayName: 'LinkedIn',
    icon: 'in',
    color: '#0A66C2',
    capabilities: FULL_SOCIAL
  },
  tiktok: {
    id: 'tiktok',
    displayName: 'TikTok',
    icon: '🎵',
    color: '#000000',
    // TikTok Display API is read-mostly: no DM, no follow, no like/comment writes
    capabilities: READ_ONLY_FEED
  },
  snapchat: {
    id: 'snapchat',
    displayName: 'Snapchat',
    icon: '👻',
    color: '#FFFC00',
    capabilities: { ...DM_ONLY, supportsFeed: true, supportsStories: true }
  },
  youtube: {
    id: 'youtube',
    displayName: 'YouTube',
    icon: '📺',
    color: '#FF0000',
    capabilities: { ...READ_ONLY_FEED, supportsComments: true }
  },
  twitch: {
    id: 'twitch',
    displayName: 'Twitch',
    icon: '🎮',
    color: '#9146FF',
    capabilities: { ...READ_ONLY_FEED, supportsComments: true }
  }
};

export const getPlatformDefinition = (platform: string): SocialPlatformDefinition | undefined => {
  const normalized = platform.toLowerCase();
  return PLATFORM_DEFINITIONS[normalized] || Object.values(PLATFORM_DEFINITIONS).find((p: any) => p.id === normalized);
};

export const getAvailablePlatformDefinitions = (isPro: boolean): SocialPlatformDefinition[] => {
  return Object.values(PLATFORM_DEFINITIONS);
};

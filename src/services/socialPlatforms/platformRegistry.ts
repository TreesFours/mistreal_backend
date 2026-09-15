import { User } from '../../models/userModel';

export interface SocialPlatformDefinition {
  id: string;
  displayName: string;
  icon: string;
  color: string;
}

/**
 * 📊 ZERNIO OFFICIAL PLATFORM REGISTRY
 * All platforms are universally accessible. Limitations are determined purely
 * by the count cap allowed by the user's tier.
 */
const PLATFORM_DEFINITIONS: Record<string, SocialPlatformDefinition> = {
  twitter: {
    id: 'twitter',
    displayName: 'X (Twitter)',
    icon: '🐦',
    color: '#1DA1F2'
  },
  whatsapp: {
    id: 'whatsapp',
    displayName: 'WhatsApp',
    icon: '💬',
    color: '#25D366'
  },
  instagram: {
    id: 'instagram',
    displayName: 'Instagram',
    icon: '📷',
    color: '#E4405F'
  },
  facebook: {
    id: 'facebook',
    displayName: 'Facebook',
    icon: 'f',
    color: '#1877F2'
  },
  discord: {
    id: 'discord',
    displayName: 'Discord',
    icon: '👾',
    color: '#5865F2'
  },
  telegram: {
    id: 'telegram',
    displayName: 'Telegram',
    icon: '✈️',
    color: '#0088cc'
  },
  reddit: {
    id: 'reddit',
    displayName: 'Reddit',
    icon: 'r/',
    color: '#FF4500'
  },
  linkedin: {
    id: 'linkedin',
    displayName: 'LinkedIn',
    icon: 'in',
    color: '#0A66C2'
  }
};

export const getPlatformDefinition = (platform: string): SocialPlatformDefinition | undefined => {
  const normalized = platform.toLowerCase();
  return PLATFORM_DEFINITIONS[normalized] || Object.values(PLATFORM_DEFINITIONS).find((p: any) => p.id === normalized);
};

export const getAvailablePlatformDefinitions = (isPro: boolean): SocialPlatformDefinition[] => {
  return Object.values(PLATFORM_DEFINITIONS);
};

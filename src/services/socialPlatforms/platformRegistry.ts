import { User } from '../../models/userModel';

export interface SocialPlatformDefinition {
  id: string;
  displayName: string;
  icon: string;
  color: string;
  isProOnly: boolean;
}

/**
 * 📊 ZERNIO OFFICIAL PLATFORM REGISTRY
 * Now purely declarative metadata. The ZernioAdapter handles the actual logic.
 */
const PLATFORM_DEFINITIONS: Record<string, SocialPlatformDefinition> = {
  twitter: {
    id: 'twitter',
    displayName: 'X (Twitter)',
    icon: '🐦',
    color: '#1DA1F2',
    isProOnly: false
  },
  whatsapp: {
    id: 'whatsapp',
    displayName: 'WhatsApp',
    icon: '💬',
    color: '#25D366',
    isProOnly: false
  },
  instagram: {
    id: 'instagram',
    displayName: 'Instagram',
    icon: '📷',
    color: '#E4405F',
    isProOnly: true
  },
  facebook: {
    id: 'facebook',
    displayName: 'Facebook',
    icon: 'f',
    color: '#1877F2',
    isProOnly: true
  },
  discord: {
    id: 'discord',
    displayName: 'Discord',
    icon: '👾',
    color: '#5865F2',
    isProOnly: false // Move to free for testing
  },
  telegram: {
    id: 'telegram',
    displayName: 'Telegram',
    icon: '✈️',
    color: '#0088cc',
    isProOnly: true
  },
  reddit: {
    id: 'reddit',
    displayName: 'Reddit',
    icon: 'r/',
    color: '#FF4500',
    isProOnly: true
  },
  linkedin: {
    id: 'linkedin',
    displayName: 'LinkedIn',
    icon: 'in',
    color: '#0A66C2',
    isProOnly: false // Move to free for testing
  }
};

export const getPlatformDefinition = (platform: string): SocialPlatformDefinition | undefined => {
  const normalized = platform.toLowerCase();
  return PLATFORM_DEFINITIONS[normalized] || Object.values(PLATFORM_DEFINITIONS).find((p: any) => p.id === normalized);
};

export const getAvailablePlatformDefinitions = (isPro: boolean): SocialPlatformDefinition[] => {
  return Object.values(PLATFORM_DEFINITIONS).filter((def: any) => isPro || !def.isProOnly);
};

import { User } from '../../models/userModel';
import { TwitterOAuth } from './twitterAuth';
import { InstagramOAuth } from './instagramAuth';
import { WhatsAppOAuth } from './whatsappAuth';
import { FacebookOAuth, LinkedInOAuth } from './socialAuthHandlers';
import { ZernioAdapter } from './zernioAdapter';

export interface SocialPlatformDefinition {
  id: string;
  displayName: string;
  icon: string;
  color: string;
  isProOnly: boolean;
  aliases: string[];
  tokenField: keyof User | null;
  refreshTokenField?: keyof User | null;
  getAuthUrl: (deviceId: string, callbackUrl: string) => string;
  exchangeCodeForToken: (code: string, callbackUrl: string) => Promise<any>;
  fetchContent: (user: User) => Promise<any[]>;
}

/**
 * 🛠️ THE HYBRID BRIDGE LOGIC
 * If direct API keys exist in .env, use them.
 * Otherwise, automatically fallback to Zernio.
 */
const PLATFORM_DEFINITIONS: Record<string, SocialPlatformDefinition> = {
  twitter: {
    id: 'twitter',
    displayName: 'X (Twitter)',
    icon: '🐦',
    color: '#1DA1F2',
    isProOnly: false,
    aliases: ['x'],
    tokenField: 'twitterAccessToken',
    refreshTokenField: 'twitterRefreshToken',
    getAuthUrl: (deviceId, callbackUrl) => {
      return process.env.TWITTER_CLIENT_ID
        ? TwitterOAuth.getAuthUrl(deviceId, callbackUrl)
        : ZernioAdapter.getAuthUrl(deviceId, callbackUrl, 'twitter');
    },
    exchangeCodeForToken: (code, callbackUrl) => {
      return process.env.TWITTER_CLIENT_ID
        ? TwitterOAuth.exchangeCodeForToken(code, callbackUrl)
        : ZernioAdapter.exchangeCodeForToken(code, callbackUrl, 'twitter');
    },
    fetchContent: async (user: User) => {
      if (!user.twitterAccessToken) return [];
      return process.env.TWITTER_CLIENT_ID
        ? TwitterOAuth.fetchUserPosts(user.twitterAccessToken)
        : ZernioAdapter.fetchContent(user.twitterAccessToken, 'twitter');
    }
  },
  whatsapp: {
    id: 'whatsapp',
    displayName: 'WhatsApp',
    icon: '💬',
    color: '#25D366',
    isProOnly: false,
    aliases: ['whatsapp_business'],
    tokenField: 'whatsappAccessToken',
    getAuthUrl: (deviceId, callbackUrl) => {
      return process.env.WHATSAPP_CLIENT_ID
        ? WhatsAppOAuth.getAuthUrl(deviceId, callbackUrl)
        : ZernioAdapter.getAuthUrl(deviceId, callbackUrl, 'whatsapp');
    },
    exchangeCodeForToken: (code, callbackUrl) => {
      return process.env.WHATSAPP_CLIENT_ID
        ? WhatsAppOAuth.exchangeCodeForToken(code, callbackUrl)
        : ZernioAdapter.exchangeCodeForToken(code, callbackUrl, 'whatsapp');
    },
    fetchContent: async (user: User) => {
      if (!user.whatsappAccessToken) return [];
      return process.env.WHATSAPP_CLIENT_ID
        ? WhatsAppOAuth.fetchMessages(user.whatsappAccessToken, process.env.WHATSAPP_BUSINESS_PHONE_ID || '')
        : ZernioAdapter.fetchContent(user.whatsappAccessToken, 'whatsapp');
    }
  },
  instagram: {
    id: 'instagram',
    displayName: 'Instagram',
    icon: '📷',
    color: '#E4405F',
    isProOnly: true,
    aliases: [],
    tokenField: 'instagramAccessToken',
    getAuthUrl: (deviceId, callbackUrl) => {
      return process.env.INSTAGRAM_CLIENT_ID
        ? InstagramOAuth.getAuthUrl(deviceId, callbackUrl)
        : ZernioAdapter.getAuthUrl(deviceId, callbackUrl, 'instagram');
    },
    exchangeCodeForToken: (code, callbackUrl) => {
      return process.env.INSTAGRAM_CLIENT_ID
        ? InstagramOAuth.exchangeCodeForToken(code, callbackUrl)
        : ZernioAdapter.exchangeCodeForToken(code, callbackUrl, 'instagram');
    },
    fetchContent: async (user: User) => {
      if (!user.instagramAccessToken) return [];
      return process.env.INSTAGRAM_CLIENT_ID
        ? InstagramOAuth.fetchUserPosts(user.instagramAccessToken)
        : ZernioAdapter.fetchContent(user.instagramAccessToken, 'instagram');
    }
  },
  facebook: {
    id: 'facebook',
    displayName: 'Facebook',
    icon: 'f',
    color: '#1877F2',
    isProOnly: true,
    aliases: [],
    tokenField: 'facebookAccessToken',
    getAuthUrl: (deviceId, callbackUrl) => {
      return process.env.FACEBOOK_CLIENT_ID
        ? FacebookOAuth.getAuthUrl(deviceId, callbackUrl)
        : ZernioAdapter.getAuthUrl(deviceId, callbackUrl, 'facebook');
    },
    exchangeCodeForToken: (code, callbackUrl) => {
      return process.env.FACEBOOK_CLIENT_ID
        ? FacebookOAuth.exchangeCodeForToken(code, callbackUrl)
        : ZernioAdapter.exchangeCodeForToken(code, callbackUrl, 'facebook');
    },
    fetchContent: async (user: User) => {
      if (!user.facebookAccessToken) return [];
      return process.env.FACEBOOK_CLIENT_ID
        ? FacebookOAuth.fetchUserPosts(user.facebookAccessToken)
        : ZernioAdapter.fetchContent(user.facebookAccessToken, 'facebook');
    }
  },
  discord: {
    id: 'discord',
    displayName: 'Discord',
    icon: '👾',
    color: '#5865F2',
    isProOnly: true,
    aliases: [],
    tokenField: 'discordAccessToken',
    getAuthUrl: (deviceId, callbackUrl) => ZernioAdapter.getAuthUrl(deviceId, callbackUrl, 'discord'),
    exchangeCodeForToken: (code, callbackUrl) => ZernioAdapter.exchangeCodeForToken(code, callbackUrl, 'discord'),
    fetchContent: async (user: User) => {
      if (!user.discordAccessToken) return [];
      return ZernioAdapter.fetchContent(user.discordAccessToken, 'discord');
    }
  },
  telegram: {
    id: 'telegram',
    displayName: 'Telegram',
    icon: '✈️',
    color: '#0088cc',
    isProOnly: true,
    aliases: [],
    tokenField: 'telegramAccessToken',
    getAuthUrl: (deviceId, callbackUrl) => ZernioAdapter.getAuthUrl(deviceId, callbackUrl, 'telegram'),
    exchangeCodeForToken: (code, callbackUrl) => ZernioAdapter.exchangeCodeForToken(code, callbackUrl, 'telegram'),
    fetchContent: async (user: User) => {
      if (!user.telegramAccessToken) return [];
      return ZernioAdapter.fetchContent(user.telegramAccessToken, 'telegram');
    }
  }
};

export const getPlatformDefinition = (platform: string): SocialPlatformDefinition | undefined => {
  const normalized = platform.toLowerCase();
  return Object.values(PLATFORM_DEFINITIONS).find(
    def => def.id === normalized || def.aliases.includes(normalized)
  );
};

export const getAvailablePlatformDefinitions = (isPro: boolean): SocialPlatformDefinition[] => {
  return Object.values(PLATFORM_DEFINITIONS).filter(def => isPro || !def.isProOnly);
};

export const getPlatformDefinitionsById = (): SocialPlatformDefinition[] => {
  return Object.values(PLATFORM_DEFINITIONS);
};

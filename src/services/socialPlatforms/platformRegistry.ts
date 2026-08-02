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
  postContent?: (user: User, content: string, type: string) => Promise<any>;
}

/**
 * 🛠️ THE UNIVERSAL SOCIAL HUB
 * Prioritizes Zernio's professional bridge while remaining future-ready for direct APIs.
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
      // Use direct API if keys are provided, otherwise use Zernio Bridge
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
    },
    postContent: async (user: User, content: string, type: string) => {
      if (!user.twitterAccessToken) throw new Error('X not connected');
      return ZernioAdapter.sendAction(user.twitterAccessToken, 'twitter', { type: 'post', content });
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
      // WhatsApp Meta Embedded Signup requires a hosted bridge
      const appUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
      return `${appUrl}/api/social/whatsapp/bridge?deviceId=${deviceId}`;
    },
    exchangeCodeForToken: async (code, callbackUrl) => {
      // This is handled by the dedicated /whatsapp/callback route
      return ZernioAdapter.completeWhatsAppSignup(code);
    },
    fetchContent: async (user: User) => {
      if (!user.whatsappAccessToken) return [];
      // Use Zernio professional fetch for WhatsApp messages/status
      return ZernioAdapter.fetchContent(user.whatsappAccessToken, 'whatsapp');
    },
    postContent: async (user: User, content: string, type: string) => {
      if (!user.whatsappAccessToken) throw new Error('WhatsApp not connected');
      return ZernioAdapter.sendAction(user.whatsappAccessToken, 'whatsapp', {
        type: type === 'status' ? 'status_update' : 'message',
        content
      });
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
      // Professional Instagram bridge (Requires Creator/Business account)
      return ZernioAdapter.getAuthUrl(deviceId, callbackUrl, 'instagram');
    },
    exchangeCodeForToken: (code, callbackUrl) => {
      return ZernioAdapter.exchangeCodeForToken(code, callbackUrl, 'instagram');
    },
    fetchContent: async (user: User) => {
      if (!user.instagramAccessToken) return [];
      return ZernioAdapter.fetchContent(user.instagramAccessToken, 'instagram');
    },
    postContent: async (user: User, content: string, type: string) => {
      if (!user.instagramAccessToken) throw new Error('Instagram not connected');
      return ZernioAdapter.sendAction(user.instagramAccessToken, 'instagram', {
        type: type === 'status' ? 'story' : 'post',
        content
      });
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
    getAuthUrl: (deviceId, callbackUrl) => ZernioAdapter.getAuthUrl(deviceId, callbackUrl, 'facebook'),
    exchangeCodeForToken: (code, callbackUrl) => ZernioAdapter.exchangeCodeForToken(code, callbackUrl, 'facebook'),
    fetchContent: async (user: User) => {
      if (!user.facebookAccessToken) return [];
      return ZernioAdapter.fetchContent(user.facebookAccessToken, 'facebook');
    },
    postContent: async (user: User, content: string, type: string) => {
        if (!user.facebookAccessToken) throw new Error('Facebook not connected');
        return ZernioAdapter.sendAction(user.facebookAccessToken, 'facebook', { type: type === 'status' ? 'story' : 'post', content });
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
    },
    postContent: async (user: User, content: string, type: string) => {
        if (!user.discordAccessToken) throw new Error('Discord not connected');
        return ZernioAdapter.sendAction(user.discordAccessToken, 'discord', { type: 'message', content });
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
    },
    postContent: async (user: User, content: string, type: string) => {
        if (!user.telegramAccessToken) throw new Error('Telegram not connected');
        return ZernioAdapter.sendAction(user.telegramAccessToken, 'telegram', { type: 'message', content });
    }
  },
  reddit: {
    id: 'reddit',
    displayName: 'Reddit',
    icon: 'r/',
    color: '#FF4500',
    isProOnly: true,
    aliases: [],
    tokenField: 'redditAccessToken',
    getAuthUrl: (deviceId, callbackUrl) => ZernioAdapter.getAuthUrl(deviceId, callbackUrl, 'reddit'),
    exchangeCodeForToken: (code, callbackUrl) => ZernioAdapter.exchangeCodeForToken(code, callbackUrl, 'reddit'),
    fetchContent: async (user: User) => {
      if (!user.redditAccessToken) return [];
      return ZernioAdapter.fetchContent(user.redditAccessToken, 'reddit');
    },
    postContent: async (user: User, content: string, type: string) => {
        if (!user.redditAccessToken) throw new Error('Reddit not connected');
        return ZernioAdapter.sendAction(user.redditAccessToken, 'reddit', { type: 'post', content });
    }
  },
  linkedin: {
    id: 'linkedin',
    displayName: 'LinkedIn',
    icon: 'in',
    color: '#0A66C2',
    isProOnly: true,
    aliases: [],
    tokenField: 'linkedinAccessToken',
    getAuthUrl: (deviceId, callbackUrl) => ZernioAdapter.getAuthUrl(deviceId, callbackUrl, 'linkedin'),
    exchangeCodeForToken: (code, callbackUrl) => ZernioAdapter.exchangeCodeForToken(code, callbackUrl, 'linkedin'),
    fetchContent: async (user: User) => {
      if (!user.linkedinAccessToken) return [];
      return ZernioAdapter.fetchContent(user.linkedinAccessToken, 'linkedin');
    },
    postContent: async (user: User, content: string, type: string) => {
        if (!user.linkedinAccessToken) throw new Error('LinkedIn not connected');
        return ZernioAdapter.sendAction(user.linkedinAccessToken, 'linkedin', { type: 'post', content });
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

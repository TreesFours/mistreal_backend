import { User, SocialEvent } from '../models/userModel';
import { getPlatformDefinition, getAvailablePlatformDefinitions } from './socialPlatforms/platformRegistry';
import { ZernioAdapter } from './socialPlatforms/zernioAdapter';
import { FacebookOAuth, LinkedInOAuth } from './socialPlatforms/socialAuthHandlers';
import { TwitterOAuth } from './socialPlatforms/twitterAuth';
import logger from '../utils/logger';

export const getAvailablePlatforms = async (isPro: boolean) => {
    return getAvailablePlatformDefinitions(isPro).map((def: any) => ({
        id: def.id,
        name: def.displayName,
        icon: def.icon,
        color: def.color,
        isProOnly: def.isProOnly
    }));
};

/**
 * 🔄 Refined Zernio Sync logic
 */
export const getSocialSummary = async (user: User, isPro: boolean = false) => {
    try {
        // 💾 PERSISTENCE FIRST: Fetch from our DB
        const events = await SocialEvent.findAll({
            where: { deviceId: user.deviceId },
            order: [['timestamp', 'DESC']],
            limit: 50
        });

        let items = events.map((e: any) => ({
            _id: e.externalId,
            platform: e.platform,
            author: { id: e.senderId, name: e.senderName },
            content: { text: e.content },
            createdAt: e.timestamp,
            metadata: e.metadata,
            type: e.type
        }));

        // 🚰 HYDRATION: If DB is empty, do a one-time sync from Zernio
        if (items.length === 0 && user.zernioProfileId) {
            console.info(`🚰 [SYNC] DB empty. Hydrating from Zernio Inbox & Feed for Profile: ${user.zernioProfileId}`);
            try {
                // Fetch both DMs (Inbox) AND Social Posts (Feed)
                const [inboxItems, feedItems] = await Promise.all([
                    ZernioAdapter.fetchInbox(user.zernioProfileId),
                    ZernioAdapter.fetchFeed(user.zernioProfileId)
                ]);

                const allRemoteItems = [...inboxItems, ...feedItems];
                console.info(`📥 [SYNC] Zernio returned ${inboxItems.length} Inbox items and ${feedItems.length} Feed items.`);

                for (const it of allRemoteItems) {
                    await SocialEvent.findOrCreate({
                        where: { externalId: it._id || it.id },
                        defaults: {
                            deviceId: user.deviceId,
                            platform: it.platform.toLowerCase(),
                            type: it.type || (feedItems.includes(it) ? 'post' : 'message'),
                            externalId: it._id || it.id,
                            senderId: it.author?.id,
                            senderName: it.author?.name || it.author?.handle || 'Social Contact',
                            content: it.content?.text || it.content?.body || "",
                            metadata: it.metadata || {},
                            timestamp: it.createdAt || new Date()
                        }
                    });
                }
                items = allRemoteItems;
            } catch (fetchError: any) {
                console.error(`❌ [SYNC] Zernio Fetch Failed: ${fetchError.message}`);
            }
        }

        const filteredItems = isPro ? items : items.filter((i: any) =>
            ['twitter', 'x', 'whatsapp', 'linkedin', 'facebook', 'discord', 'telegram', 'instagram'].includes((i.platform || '').toLowerCase())
        );

        const platformUpdates = filteredItems.reduce((acc: any[], item: any) => {
            const existing = acc.find((p: any) => p.platform === item.platform);
            if (existing) {
                existing.count++;
            } else {
                const def = getPlatformDefinition(item.platform);
                acc.push({
                    platform: item.platform,
                    count: 1,
                    platformIcon: def?.icon || '🔗',
                    platformColor: def?.color || '#888',
                    platformDisplayName: def?.displayName || item.platform,
                    connected: true
                });
            }
            return acc;
        }, []);

        const posts = filteredItems.map((it: any) => {
            const def = getPlatformDefinition(it.platform);

            // Extract image from attachments if available
            const imageUrl = it.content?.attachments?.find((a: any) => a.type === 'image')?.url ||
                             it.metadata?.attachments?.find((a: any) => a.type === 'image')?.url;

            return {
                id: it._id || it.id,
                platform: it.platform,
                author: it.author?.name || it.author?.handle || 'Social Contact',
                content: it.content?.text || it.content?.body || '',
                timestamp: it.createdAt || it.timestamp || new Date().toISOString(),
                type: it.type || 'post',
                imageUrl: imageUrl || null,
                sourceUrl: it.source_url || it.url || null,
                platformIcon: def?.icon || '🔗',
                platformColor: def?.color || '#888',
                platformDisplayName: def?.displayName || it.platform,
                commentsCount: it.metadata?.comments_count || 0,
                likes: it.metadata?.likes_count || 0,
                comments: it.metadata?.comments || []
            };
        });

        return {
            summary: items.length > 0 ? `Unified Intelligence: ${items.length} new signals.` : 'Your intelligence feeds are silent.',
            platformUpdates,
            posts,
            rawContent: posts.map((p: any) => `[${p.platform}] ${p.author}: ${p.content}`).join('\n')
        };
    } catch (error: any) {
        return { summary: "SYNC_ERROR", platformUpdates: [], posts: [], rawContent: "" };
    }
};

/**
 * 🔗 Headless Zernio Session: Bypasses their dashboard with fallback routing
 */
export const createConnectSession = async (platform: string, deviceId: string, callbackUrl: string) => {
    let user = await User.findOne({ where: { deviceId } });
    if (!user) {
        user = await User.create({ deviceId, connectedPlatforms: [] });
    }

    // 🛡️ TIER LIMIT ENFORCEMENT
    const tier = user.subscriptionTier?.toLowerCase() || 'free';
    let limit = parseInt(process.env.FREE_USER_PLATFORM_LIMIT || '1', 10);

    if (tier === 'premium1') {
        limit = parseInt(process.env.PREMIUM_1_PLATFORM_LIMIT || '5', 10);
    } else if (tier === 'premium2') {
        limit = parseInt(process.env.PREMIUM_2_PLATFORM_LIMIT || '99', 10);
    } else if (user.isPro) {
        limit = 99;
    }

    const currentConnected = user.connectedPlatforms || [];

    // Allow re-connecting an existing platform, but block NEW ones if limit reached
    if (!currentConnected.map(p => p.toLowerCase()).includes(platform.toLowerCase()) && currentConnected.length >= limit) {
        const tierLabel = tier === 'free' ? 'Free tier' : tier === 'premium1' ? 'Premium 1' : 'Your subscription';
        throw new Error(`LIMIT_REACHED: ${tierLabel} is limited to ${limit} social connection${limit === 1 ? '' : 's'}.`);
    }

    // 1. Try Zernio Adapter if ZERNIO_API_KEY is configured
    if (process.env.ZERNIO_API_KEY) {
        try {
            if (!user.zernioProfileId) {
                user.zernioProfileId = await ZernioAdapter.getOrCreateProfile(deviceId);
                await user.save();
            }

            const state = Buffer.from(JSON.stringify({ deviceId, platform }))
                .toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');

            const fallbackCallback = `${callbackUrl}${callbackUrl.includes('?') ? '&' : '?'}deviceId=${deviceId}&platform=${platform}`;
            const scope = platform.toLowerCase() === 'linkedin'
                ? 'r_liteprofile,r_emailaddress,w_member_social'
                : undefined;

            const authUrl = await ZernioAdapter.getAuthUrl(platform, user.zernioProfileId!, scope, state, fallbackCallback);
            if (authUrl && typeof authUrl === 'string' && authUrl.startsWith('http')) {
                return authUrl;
            }
        } catch (zernioError: any) {
            logger.warn(`⚠️ Zernio connection failed (${zernioError.message}). Attempting direct/fallback connector...`);
        }
    }

    // 2. Direct OAuth Handlers if client credentials are present
    const normalizedPlatform = platform.toLowerCase();
    if (normalizedPlatform === 'facebook' && process.env.FACEBOOK_CLIENT_ID) {
        return FacebookOAuth.getAuthUrl(deviceId, callbackUrl);
    } else if (normalizedPlatform === 'linkedin' && process.env.LINKEDIN_CLIENT_ID) {
        return LinkedInOAuth.getAuthUrl(deviceId, callbackUrl);
    } else if ((normalizedPlatform === 'twitter' || normalizedPlatform === 'x') && process.env.TWITTER_CLIENT_ID) {
        return TwitterOAuth.getAuthUrl(deviceId, callbackUrl);
    }

    // 3. Fallback: Direct Handshake Callback URL
    const fallbackUrl = `${callbackUrl}${callbackUrl.includes('?') ? '&' : '?'}deviceId=${deviceId}&platform=${platform}&tempToken=MOCK_CONNECT_${Date.now()}`;
    return fallbackUrl;
};

export const exchangeOAuthCode = async (deviceId: string, platform: string, code: string, callbackUrl: string) => {
    let user = await User.findOne({ where: { deviceId } });
    if (!user) {
        user = await User.create({ deviceId, connectedPlatforms: [] });
    }

    const connected = user.connectedPlatforms || [];
    const normalizedPlatform = platform.toLowerCase();

    if (!connected.map((p: any) => p.toLowerCase()).includes(normalizedPlatform)) {
        connected.push(normalizedPlatform);
        user.set('connectedPlatforms', connected);
        user.changed('connectedPlatforms', true);
    }

    if (!user.zernioProfileId && process.env.ZERNIO_API_KEY) {
        try {
            user.zernioProfileId = await ZernioAdapter.getOrCreateProfile(deviceId);
        } catch (e: any) {
            logger.warn(`Zernio Profile skipped during OAuth exchange: ${e.message}`);
        }
    }

    if (normalizedPlatform === 'linkedin') user.linkedinAccessToken = 'MANAGED';

    await user.save();
    logger.info(`✅ ${normalizedPlatform} connection saved for device ${deviceId}`);
};

export const disconnectPlatform = async (deviceId: string, platform: string) => {
    try {
        const user = await User.findOne({ where: { deviceId } });
        if (!user) return { success: false, error: 'User not found' };

        const connected = user.connectedPlatforms || [];
        user.set('connectedPlatforms', connected.filter((p: any) => p.toLowerCase() !== platform.toLowerCase()));
        user.changed('connectedPlatforms', true);

        // Also clear profileId if it was a critical failure? No, usually keep it for reconnections.

        await user.save();
        return { success: true, platform, message: `${platform} disconnected` };
    } catch (e: any) {
        throw new Error(`Disconnect failed: ${e.message}`);
    }
};

export const sendSocialAction = async (user: User, action: { platform: string, type: string, content: string, targetId?: string }) => {
    if (!user.zernioProfileId) throw new Error('Connect your social profile first.');
    return await ZernioAdapter.sendAction(user.zernioProfileId, action.platform, action.content, action.type, action.targetId);
};

export const getPlatformContacts = async (user: User, platform: string, search?: string) => {
    try {
        const events = await SocialEvent.findAll({
            where: {
                deviceId: user.deviceId,
                platform: platform.toLowerCase()
            },
            order: [['timestamp', 'DESC']],
            limit: 100
        });

        const contactMap = new Map<string, any>();
        for (const e of events) {
            if (e.senderId && e.senderId !== 'self' && !contactMap.has(e.senderId)) {
                contactMap.set(e.senderId, {
                    id: e.senderId,
                    name: e.senderName || 'Social Contact',
                    platform: e.platform,
                    unreadCount: e.isRead ? 0 : 1,
                    isOnline: true,
                    lastSeen: 'Recently',
                    statusMessage: e.content?.slice(0, 30) || 'Active',
                    avatar: null
                });
            }
        }

        let contactsList = Array.from(contactMap.values());
        if (search && search.trim().length > 0) {
            const query = search.toLowerCase();
            contactsList = contactsList.filter(c => c.name.toLowerCase().includes(query));
        }

        if (contactsList.length === 0 && user.zernioProfileId) {
            const zernioContacts = await ZernioAdapter.fetchContacts(user.zernioProfileId, platform);
            return zernioContacts.map((c: any) => ({
                id: c.id || c._id,
                name: c.name || c.username || 'Social Contact',
                platform: platform.toLowerCase(),
                unreadCount: 0,
                isOnline: false,
                lastSeen: 'Unknown',
                statusMessage: 'Zernio Contact',
                avatar: c.avatar || null
            }));
        }

        return contactsList;
    } catch (e: any) {
        logger.error(`Error in getPlatformContacts: ${e.message}`);
        return [];
    }
};

export const getUnreadMessages = async (user: User) => {
    try {
        const events = await SocialEvent.findAll({
            where: {
                deviceId: user.deviceId,
                isRead: false
            },
            order: [['timestamp', 'DESC']],
            limit: 20
        });

        return events.map((e: any) => ({
            id: e.externalId,
            sender: e.senderName || 'Social Contact',
            platform: e.platform,
            text: e.content,
            timestamp: e.timestamp ? e.timestamp.toISOString() : new Date().toISOString(),
            isOnline: true,
            lastSeen: 'Now'
        }));
    } catch (e: any) {
        logger.error(`Error in getUnreadMessages: ${e.message}`);
        return [];
    }
};

export const getSocialHistory = async (user: User, platform: string, targetId: string) => {
    try {
        const events = await SocialEvent.findAll({
            where: {
                deviceId: user.deviceId,
                platform: platform.toLowerCase()
            },
            order: [['timestamp', 'ASC']],
            limit: 50
        });

        const messages = events.map((e: any) => {
            const isIncoming = e.senderId === targetId || (e.senderId !== 'self');
            return {
                id: e.externalId,
                platform: e.platform,
                direction: isIncoming ? 'incoming' : 'outgoing',
                text: e.content,
                timestamp: e.timestamp ? e.timestamp.toISOString() : new Date().toISOString(),
                attachments: e.metadata?.attachments || null
            };
        });

        return messages;
    } catch (e: any) {
        logger.error(`Error in getSocialHistory: ${e.message}`);
        return [];
    }
};

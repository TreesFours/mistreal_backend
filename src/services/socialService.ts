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
        isProOnly: def.isProOnly,
        capabilities: def.capabilities
    }));
};

/**
 * 🔄 Refined Zernio Sync logic
 */
export const getSocialSummary = async (user: User, isPro: boolean = false) => {
    const syncWarnings: string[] = [];
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

        // 🚰 HYDRATION: per-platform, not "DB has ANY row at all". The old check
        // (`items.length === 0`) meant that once a single event existed for this
        // device — from any platform — newly-connected platforms would never get
        // their first hydration, since the global count was already non-zero.
        const connectedPlatforms = (user.connectedPlatforms || []).map((p: string) => normalizePlatformId(p));
        const platformsWithData = new Set(items.map((i: any) => normalizePlatformId(i.platform)));
        const unhydrated = connectedPlatforms.filter((p: string) => !platformsWithData.has(p));

        if (unhydrated.length > 0 && user.zernioProfileId) {
            console.info(`🚰 [SYNC] Hydrating ${unhydrated.join(', ')} from Zernio for Profile: ${user.zernioProfileId}`);
            try {
                // Fetch both DMs (Inbox) AND Social Posts (Feed)
                const [inboxItemsRaw, feedItemsRaw] = await Promise.all([
                    ZernioAdapter.fetchInbox(user.zernioProfileId),
                    ZernioAdapter.fetchFeed(user.zernioProfileId)
                ]);
                // Zernio is expected to return an array for both — guard against a
                // malformed/non-array response shape so a spread below can't throw
                // and silently blank out the whole feed.
                const inboxItems = Array.isArray(inboxItemsRaw) ? inboxItemsRaw : [];
                const feedItems = Array.isArray(feedItemsRaw) ? feedItemsRaw : [];
                const feedItemSet = new Set(feedItems);

                const allRemoteItems = [...inboxItems, ...feedItems]
                    .filter((it: any) => unhydrated.includes(normalizePlatformId(it?.platform)));
                console.info(`📥 [SYNC] Zernio returned ${inboxItems.length} Inbox items and ${feedItems.length} Feed items (${allRemoteItems.length} for newly-connected platforms).`);

                if (inboxItems.length === 0 && feedItems.length === 0) {
                    syncWarnings.push(`Zernio returned zero items for profile ${user.zernioProfileId} — either the connected account(s) have no content yet, or Zernio isn't returning data for ${unhydrated.join(', ')} (some platforms, e.g. LinkedIn, restrict third-party read access by policy).`);
                }

                // Raw Zernio items arrive in Zernio's own field shape, not the
                // {_id, platform, author:{id,name}, content:{text,attachments}, ...}
                // shape the rest of this function (and posts.map below) assumes —
                // without normalizing here, a fresh hydration would silently render
                // blank author/text/image fields even though Zernio has real data.
                // Exact Zernio field names are UNVERIFIED against a live account;
                // these fallbacks cover the common aliases seen across social APIs —
                // adjust here first if real payloads use different keys.
                const normalizedRemoteItems: any[] = [];
                for (const it of allRemoteItems) {
                    try {
                        const rawAuthor = it.author || it.user || it.sender || {};
                        const rawAttachments = it.content?.attachments || it.media || it.attachments || [];
                        const externalId = it._id || it.id;
                        if (!externalId || !it.platform) continue; // can't persist/display without these
                        normalizedRemoteItems.push({
                            _id: externalId,
                            platform: it.platform,
                            author: {
                                id: rawAuthor.id || rawAuthor._id || rawAuthor.userId || rawAuthor.handle || rawAuthor.username || null,
                                name: rawAuthor.name || rawAuthor.displayName || rawAuthor.display_name || rawAuthor.handle || rawAuthor.username || 'Social Contact'
                            },
                            content: {
                                text: it.content?.text || it.content?.body || it.text || it.message || it.caption || '',
                                attachments: Array.isArray(rawAttachments) ? rawAttachments : []
                            },
                            createdAt: it.createdAt || it.created_at || it.timestamp || new Date(),
                            metadata: it.metadata || {},
                            type: it.type || (feedItemSet.has(it) ? 'post' : 'message')
                        });
                    } catch (normErr: any) {
                        console.error(`[SYNC] Skipping one malformed Zernio item: ${normErr.message}`);
                    }
                }

                for (const it of normalizedRemoteItems) {
                    await SocialEvent.findOrCreate({
                        where: { externalId: it._id },
                        defaults: {
                            deviceId: user.deviceId,
                            platform: it.platform.toLowerCase(),
                            type: it.type,
                            externalId: it._id,
                            senderId: it.author.id,
                            senderName: it.author.name,
                            content: it.content.text,
                            metadata: { ...it.metadata, attachments: it.content.attachments },
                            timestamp: it.createdAt
                        }
                    });
                }
                items = [...items, ...normalizedRemoteItems];
            } catch (fetchError: any) {
                console.error(`❌ [SYNC] Zernio Fetch Failed: ${fetchError.message}`, fetchError);
                syncWarnings.push(`Zernio sync failed for ${unhydrated.join(', ')}: ${fetchError.response?.data?.error || fetchError.message}`);
            }
        } else if (unhydrated.length > 0 && !user.zernioProfileId) {
            syncWarnings.push(`${unhydrated.join(', ')} connected but no Zernio profile is linked — sync can't run. Try reconnecting.`);
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

        // Built item-by-item with each item isolated in its own try/catch —
        // one malformed item (an unexpected Zernio field shape) must degrade to
        // "skip this one post", not blank out the entire feed via the outer catch.
        const posts: any[] = [];
        for (const it of filteredItems) {
            try {
                const def = getPlatformDefinition(it.platform);

                // Extract image/video from attachments if available
                const rawAttachments = it.content?.attachments || it.metadata?.attachments || [];
                const attachments = Array.isArray(rawAttachments) ? rawAttachments : [];
                const imageUrl = attachments.find((a: any) => a?.type === 'image')?.url || null;
                const videoUrl = attachments.find((a: any) => a?.type === 'video')?.url || null;

                // Resolve the real content kind. Zernio's raw items don't consistently
                // flag stories/reels, so check both a dedicated `type` and metadata hints
                // before falling back to a generic "post".
                const isStory = it.type === 'story' || it.metadata?.is_story === true || it.metadata?.media_product_type === 'STORY';
                const isReel = !isStory && (it.type === 'reel' || it.metadata?.is_reel === true || it.metadata?.media_product_type === 'REELS' || (videoUrl && it.metadata?.media_type === 'VIDEO'));
                const resolvedType = isStory ? 'story' : isReel ? 'reel' : (it.type || 'post');

                posts.push({
                    id: it._id || it.id,
                    platform: it.platform,
                    author: it.author?.name || it.author?.handle || 'Social Contact',
                    content: it.content?.text || it.content?.body || '',
                    timestamp: it.createdAt || it.timestamp || new Date().toISOString(),
                    type: resolvedType,
                    imageUrl: imageUrl,
                    videoUrl: videoUrl,
                    sourceUrl: it.source_url || it.url || null,
                    platformIcon: def?.icon || '🔗',
                    platformColor: def?.color || '#888',
                    platformDisplayName: def?.displayName || it.platform,
                    commentsCount: it.metadata?.comments_count || 0,
                    likes: it.metadata?.likes_count || 0,
                    comments: it.metadata?.comments || []
                });
            } catch (itemError: any) {
                console.error(`[SYNC] Skipping one post that failed to render: ${itemError.message}`, it);
            }
        }

        return {
            summary: items.length > 0 ? `Unified Intelligence: ${items.length} new signals.` : 'Your intelligence feeds are silent.',
            platformUpdates,
            posts,
            rawContent: posts.map((p: any) => `[${p.platform}] ${p.author}: ${p.content}`).join('\n'),
            syncWarnings
        };
    } catch (error: any) {
        // This used to swallow the error completely — a blank feed with zero
        // diagnostic info, impossible to tell apart from "genuinely no content".
        logger.error(`❌ [SYNC] getSocialSummary crashed for device ${user.deviceId}: ${error.message}`, error);
        return { summary: "SYNC_ERROR", platformUpdates: [], posts: [], rawContent: "", syncWarnings: [`Feed sync crashed: ${error.message}`] };
    }
};

/**
 * 🔄 Helper: Normalize platform aliases between Zernio API and Mistreal app IDs
 */
export const normalizePlatformId = (platform: string): string => {
    if (!platform) return '';
    const lower = platform.toLowerCase().trim();
    if (lower === 'x' || lower === 'twitter') return 'twitter';
    if (lower.startsWith('linkedin')) return 'linkedin';
    if (lower.startsWith('facebook')) return 'facebook';
    if (lower.startsWith('instagram')) return 'instagram';
    if (lower.startsWith('whatsapp')) return 'whatsapp';
    if (lower.startsWith('youtube')) return 'youtube';
    if (lower.startsWith('tiktok')) return 'tiktok';
    if (lower.startsWith('telegram')) return 'telegram';
    if (lower.startsWith('discord')) return 'discord';
    if (lower.startsWith('reddit')) return 'reddit';
    return lower;
};

export const isPlatformMatching = (platformA: string, platformB: string): boolean => {
    return normalizePlatformId(platformA) === normalizePlatformId(platformB);
};

/**
 * 🔗 Headless Zernio Session: Bypasses their dashboard with fallback routing
 */
export const createConnectSession = async (platform: string, deviceId: string, callbackUrl: string) => {
    let user = await User.findOne({ where: { deviceId } });
    if (!user) {
        user = await User.create({ deviceId, connectedPlatforms: [] });
    }

    const normPlatform = normalizePlatformId(platform);

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

    const currentConnected = (user.connectedPlatforms || []).map(p => normalizePlatformId(p));

    // Allow re-connecting an existing platform, but block NEW ones if limit reached
    if (!currentConnected.includes(normPlatform) && currentConnected.length >= limit) {
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

            const state = Buffer.from(JSON.stringify({ deviceId, platform: normPlatform }))
                .toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');

            const fallbackCallback = `${callbackUrl}${callbackUrl.includes('?') ? '&' : '?'}deviceId=${deviceId}&platform=${normPlatform}`;
            const scope = normPlatform === 'linkedin'
                ? 'r_liteprofile,r_emailaddress,w_member_social'
                : undefined;

            const authUrl = await ZernioAdapter.getAuthUrl(normPlatform, user.zernioProfileId!, scope, state, fallbackCallback);
            if (authUrl && typeof authUrl === 'string' && authUrl.startsWith('http')) {
                return authUrl;
            }
            throw new Error(`Zernio returned empty auth URL for ${platform}`);
        } catch (zernioError: any) {
            logger.error(`❌ Zernio connection error [${platform}]: ${zernioError.message}`);
            throw zernioError;
        }
    }

    // 2. Direct OAuth Handlers if client credentials are present
    if (normPlatform === 'facebook' && process.env.FACEBOOK_CLIENT_ID) {
        return FacebookOAuth.getAuthUrl(deviceId, callbackUrl);
    } else if (normPlatform === 'linkedin' && process.env.LINKEDIN_CLIENT_ID) {
        return LinkedInOAuth.getAuthUrl(deviceId, callbackUrl);
    } else if (normPlatform === 'twitter' && process.env.TWITTER_CLIENT_ID) {
        return TwitterOAuth.getAuthUrl(deviceId, callbackUrl);
    }

    throw new Error(`Failed to retrieve valid Zernio auth URL for ${platform}. Check Zernio API key and platform configuration.`);
};

export const exchangeOAuthCode = async (deviceId: string, platform: string, code: string, callbackUrl: string) => {
    let user = await User.findOne({ where: { deviceId } });
    if (!user) {
        user = await User.create({ deviceId, connectedPlatforms: [] });
    }

    const connected = user.connectedPlatforms || [];
    const normPlatform = normalizePlatformId(platform);

    if (!connected.map((p: any) => normalizePlatformId(p)).includes(normPlatform)) {
        connected.push(normPlatform);
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

    if (normPlatform === 'linkedin') user.linkedinAccessToken = 'MANAGED';

    await user.save();
    logger.info(`✅ ${normPlatform} connection saved for device ${deviceId}`);
};

export const disconnectPlatform = async (deviceId: string, platform: string) => {
    try {
        const user = await User.findOne({ where: { deviceId } });
        if (!user) return { success: false, error: 'User not found' };

        const normPlatform = normalizePlatformId(platform);

        // If Zernio profile exists, issue real API delete to Zernio
        if (user.zernioProfileId && process.env.ZERNIO_API_KEY) {
            try {
                const accounts = await ZernioAdapter.fetchAccounts(user.zernioProfileId);
                const targetAccount = accounts.find((a: any) => isPlatformMatching(a.platform || a.type || '', normPlatform));
                if (targetAccount) {
                    const accountId = targetAccount._id || targetAccount.id || targetAccount.accountId;
                    await ZernioAdapter.deleteAccount(user.zernioProfileId, accountId);
                    logger.info(`✅ Unlinked ${normPlatform} account ${accountId} on Zernio.`);
                }
            } catch (zernioErr: any) {
                logger.warn(`⚠️ Zernio deleteAccount warning: ${zernioErr.message}`);
            }
        }

        const connected = user.connectedPlatforms || [];
        user.set('connectedPlatforms', connected.filter((p: any) => !isPlatformMatching(p, normPlatform)));
        user.changed('connectedPlatforms', true);

        await user.save();
        return { success: true, platform: normPlatform, message: `${platform} disconnected successfully` };
    } catch (e: any) {
        throw new Error(`Disconnect failed: ${e.message}`);
    }
};

export const reconcileUserPlatforms = async (user: User): Promise<string[]> => {
    const existingConnected = (user.connectedPlatforms || []).map((p: string) => normalizePlatformId(p)).filter(Boolean);
    if (!user.zernioProfileId || !process.env.ZERNIO_API_KEY) {
        return Array.from(new Set(existingConnected));
    }
    try {
        const accounts = await ZernioAdapter.fetchAccounts(user.zernioProfileId);
        const zernioPlatforms = accounts
            .map((a: any) => normalizePlatformId(a.platform || a.type || ''))
            .filter(Boolean);

        const allConnected = Array.from(new Set([...existingConnected, ...zernioPlatforms]));
        if (JSON.stringify(allConnected.sort()) !== JSON.stringify(existingConnected.sort())) {
            user.set('connectedPlatforms', allConnected);
            user.changed('connectedPlatforms', true);
            await user.save();
        }
        return allConnected;
    } catch (e: any) {
        logger.warn(`Platform reconciliation error: ${e.message}`);
        return Array.from(new Set(existingConnected));
    }
};

export const sendSocialAction = async (user: User, action: { platform: string, type: string, content: string, targetId?: string, mediaUrl?: string }) => {
    if (!user.zernioProfileId) throw new Error('Connect your social profile first.');
    return await ZernioAdapter.sendAction(user.zernioProfileId, action.platform, action.content, action.type, action.targetId, action.mediaUrl);
};

/**
 * 👻 Per-contact Ghost Responder override. Auto-reply is gated by BOTH the
 * global `user.guardianEnabled` master switch AND this per-contact flag, so
 * turning the master switch on never silently starts auto-replying to every
 * contact — each DM minichat opts in individually.
 */
const contactAutoReplyKey = (platform: string, contactId: string) => `${platform.toLowerCase()}:${contactId}`;

export const isContactAutoReplyEnabled = (user: User, platform: string, contactId: string): boolean => {
    const map = user.preferences?.autoReplyContacts || {};
    return map[contactAutoReplyKey(platform, contactId)] === true;
};

export const setContactAutoReply = async (user: User, platform: string, contactId: string, enabled: boolean) => {
    const map = { ...(user.preferences?.autoReplyContacts || {}) };
    const key = contactAutoReplyKey(platform, contactId);
    if (enabled) map[key] = true; else delete map[key];
    user.set('preferences', { ...user.preferences, autoReplyContacts: map });
    user.changed('preferences', true);
    await user.save();
};

export const getPlatformContacts = async (user: User, platform: string, search?: string) => {
    try {
        const events = await SocialEvent.findAll({
            where: {
                deviceId: user.deviceId,
                platform: platform.toLowerCase(),
                // Only DM events define a "contact" — posts/comments must not leak in here.
                type: 'message'
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
                    avatar: null,
                    autoReplyEnabled: isContactAutoReplyEnabled(user, e.platform, e.senderId)
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
                avatar: c.avatar || null,
                autoReplyEnabled: isContactAutoReplyEnabled(user, platform, c.id || c._id)
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
                isRead: false,
                // Unread posts/comments must not surface in the DM unread badge.
                type: 'message'
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
                platform: platform.toLowerCase(),
                // A DM thread must only contain messages, not that contact's unrelated posts/comments.
                type: 'message'
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

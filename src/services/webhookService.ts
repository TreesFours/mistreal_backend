// backend/src/services/webhookService.ts
import crypto from 'crypto';
import { Op } from 'sequelize';
import axios from 'axios';
import * as admin from 'firebase-admin';
import logger from '../utils/logger';
import { User, SocialEvent, DelayedAction, sequelize } from '../models/userModel';
import { getAiResponse } from './aiService';
import { normalizePlatformId, isPlatformMatching, isContactAutoReplyEnabled } from './socialService';

// The event types below are registered with Zernio on startup (see
// ZernioAdapter.ensureWebhookRegistered in index.ts) — kept in this file so
// the registered list and the switch statement that actually handles them
// stay next to each other. Only confirmed-real event names from Zernio's
// OpenAPI spec are listed here; a few extra aliases the switch below also
// accepts (e.g. 'message.created', 'call.incoming') aren't registered since
// they weren't confirmed in the real catalog — harmless if never received.
export const ZERNIO_SUBSCRIBED_EVENTS = [
    'post.scheduled', 'post.published', 'post.failed', 'post.partial', 'post.cancelled',
    'post.platform.published', 'post.platform.failed',
    'account.connected', 'account.disconnected',
    'message.received', 'message.sent', 'message.edited', 'message.deleted',
    'message.delivered', 'message.read', 'message.failed',
    'conversation.started', 'reaction.received',
    'comment.received', 'review.new', 'review.updated', 'lead.received',
    'call.received', 'call.ended', 'call.failed',
    'whatsapp.template.status_updated',
    'verification.approved', 'verification.failed'
];

export class WebhookService {
// ... (rest of the imports/class structure)
    private static readonly SECRET = process.env.ZERNIO_WEBHOOK_SECRET;
    private static readonly ZERNIO_API_KEY = process.env.ZERNIO_API_KEY || '';

    /**
     * 🛡️ SECURITY: Best-practice HMAC Verification
     * Uses constant-time comparison to prevent timing attacks.
     */
    static verifySignature(payload: string, signature: string): boolean {
        if (!this.SECRET) {
            logger.warn('⚠️ ZERNIO_WEBHOOK_SECRET is not set. Security at risk.');
            return false;
        }

        const hmac = crypto.createHmac('sha256', this.SECRET);
        const digest = hmac.update(payload).digest('hex');

        try {
            return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
        } catch {
            return false;
        }
    }

    /**
     * 🧠 INNOVATION: Multi-stage Event Orchestration
     * Ensures database integrity using Transactions.
     */
    static async handleEvent(event: any) {
        // 🛡️ ADAPTIVE PAYLOAD RESOLUTION
        // Support both Zernio standard and "Late" (internal engine) payload shapes
        const type = (event.event || event.type || '').toLowerCase();
        const data = event.data || event.account || event.message || event.comment;
        const platform = event.platform || data?.platform;

        // Profile ID can be profile_id or profileId (nested or flat)
        const profileId = event.profile_id || event.profileId || data?.profileId || data?.profile_id;

        logger.info(`📨 [ZERNIO WEBHOOK] Type: ${type} | Platform: ${platform} | Profile: ${profileId}`);
        logger.debug(`📄 [RAW PAYLOAD]: ${JSON.stringify(event)}`);

        // Use a transaction to ensure all metadata updates happen atomically
        const transaction = await sequelize.transaction();

        try {
            // 🛡️ SECURITY: Strict Multi-Tenant Lookup
            const user = await User.findOne({
                where: { zernioProfileId: profileId || 'NOT_FOUND' },
                transaction
            });

            if (!user) {
                logger.warn(`⚠️ [ZERNIO] Unauthorized or Orphaned Webhook for profile_id: ${profileId}. Ensure this profileId is mapped to a user in our DB.`);
                await transaction.rollback();
                return;
            }

            logger.info(`👤 [ZERNIO] Event belongs to User: ${user.deviceId} (${user.userName || 'No Name'})`);

            switch (type) {
                case 'message.received':
                case 'message.created':
                    await this.handleIncomingMessage(user, data, platform, transaction);
                    break;
                case 'message.sent':
                    await this.handleMessageSent(user, data, platform, transaction);
                    break;
                case 'message.edited':
                    await this.handleMessageEdited(user, data, platform, transaction);
                    break;
                case 'message.deleted':
                    await this.handleMessageDeleted(user, data, platform, transaction);
                    break;
                case 'message.delivered':
                    await this.handleMessageDelivered(user, data, platform, transaction);
                    break;
                case 'message.read':
                    await this.handleMessageRead(user, data, platform, transaction);
                    break;
                case 'message.failed':
                    await this.handleMessageFailed(user, data, platform, transaction);
                    break;
                case 'reaction.received':
                    await this.handleReactionReceived(user, data, platform, transaction);
                    break;
                case 'comment.received':
                case 'comment.created':
                    await this.handleCommentReceived(user, data, platform, transaction);
                    break;
                case 'post.published':
                    await this.handlePostPublished(user, data, platform, transaction);
                    break;
                case 'post.failed':
                    await this.handlePostFailed(user, data, platform, transaction);
                    break;
                case 'account.connected':
                    await this.handleAccountConnected(user, data, platform, transaction);
                    break;
                case 'account.disconnected':
                    await this.handleAccountDisconnected(user, data, platform, transaction);
                    break;
                case 'call.received':
                case 'call.incoming':
                    await this.handleIncomingCall(user, data, platform, transaction);
                    break;
                case 'call.ended':
                    await this.handleCallEnded(user, data, platform, transaction);
                    break;
                case 'call.failed':
                    await this.handleCallFailed(user, data, platform, transaction);
                    break;
                // Confirmed real event name (via Zernio's OpenAPI spec) is
                // whatsapp.template.status_updated — the old 'whatsapp.template.status'
                // case never matched anything Zernio actually sends.
                case 'whatsapp.template.status_updated':
                    await this.handleWhatsAppTemplateUpdate(user, data, transaction);
                    break;
                case 'post.scheduled':
                case 'post.cancelled':
                case 'post.partial':
                case 'post.platform.published':
                case 'post.platform.failed':
                    await this.handlePostStatusEvent(user, type, data, platform, transaction);
                    break;
                case 'conversation.started':
                    await this.handleConversationStarted(user, data, platform, transaction);
                    break;
                case 'review.new':
                case 'review.updated':
                    await this.handleReviewEvent(user, type, data, platform, transaction);
                    break;
                case 'lead.received':
                    await this.handleLeadReceived(user, data, platform, transaction);
                    break;
                case 'whatsapp.number.activated':
                case 'whatsapp.number.disconnected':
                case 'whatsapp.number.action':
                case 'whatsapp.number.verified':
                    await this.handleWhatsAppNumberEvent(user, type, data, transaction);
                    break;
                case 'verification.approved':
                case 'verification.failed':
                    await this.handleVerificationEvent(user, type, data, transaction);
                    break;
                default:
                    logger.debug(`ℹ️ Passive event ${type} logged for device ${user.deviceId}.`);
            }

            await transaction.commit();
        } catch (error: any) {
            await transaction.rollback();
            logger.error(`❌ Webhook Critical Error: ${error.message}`);
        }
    }

    private static async handleIncomingMessage(user: any, data: any, platform: string, transaction: any) {
        const sender = data.sender?.name || data.sender?.id || "Unknown";

        // 📸 WhatsApp Media Handling: Download and store in Firebase Storage
        if (platform.toLowerCase() === 'whatsapp' && data.attachments) {
            for (const attachment of data.attachments) {
                if (attachment.url && attachment.url.includes('zernio.com')) {
                    try {
                        logger.info(`📥 WhatsApp Media detected: Downloading from ${attachment.url}`);

                        // 1. Download from Zernio
                        const response = await axios.get(attachment.url, {
                            headers: { 'Authorization': `Bearer ${this.ZERNIO_API_KEY}` },
                            responseType: 'arraybuffer'
                        });

                        // 2. Upload to Firebase Storage
                        const bucket = admin.storage().bucket();
                        const fileName = `media/${user.deviceId}/${Date.now()}_${attachment.id || 'file'}`;
                        const file = bucket.file(fileName);

                        const contentType = response.headers['content-type']?.toString() || 'application/octet-stream';

                        await file.save(Buffer.from(response.data), {
                            metadata: { contentType: contentType }
                        });

                        // 3. Make public or get Signed URL
                        await file.makePublic();
                        attachment.url = `https://storage.googleapis.com/${bucket.name}/${fileName}`;

                        logger.info(`✅ WhatsApp Media secured: ${attachment.url}`);
                    } catch (e: any) {
                        logger.error(`❌ Media Download/Upload failed: ${e.message}`);
                    }
                }
            }
        }

        // 💾 PERSISTENCE: Save to SocialEvent table for feed and history
        // senderId must be the Zernio CONVERSATION id, not the raw contact id —
        // getPlatformContacts() surfaces this as contact.id, which the app sends
        // straight back as targetId to POST /inbox/conversations/{targetId}/messages
        // when replying (see zernioAdapter.ts::sendAction). Using the contact id
        // here would make every reply to a live-arrived DM fail against Zernio's
        // real API with the wrong resource id.
        await SocialEvent.create({
            deviceId: user.deviceId,
            platform: platform.toLowerCase(),
            type: 'message',
            externalId: data.message_id || data.id || `msg_${Date.now()}`,
            senderId: data.conversationId || data.sender?.id,
            senderName: sender,
            content: data.content?.text || data.text || "",
            metadata: {
                attachments: data.attachments || [],
                conversationId: data.conversationId
            },
            timestamp: new Date(),
            isRead: false
        }, { transaction });

        // Update unread count atomically
        user.unreadMessagesCount = (user.unreadMessagesCount || 0) + 1;

        const unreadMetadata = { ...(user.preferences?.unreadMetadata || {}) };
        const platformKey = platform.toLowerCase();
        if (!unreadMetadata[platformKey]) unreadMetadata[platformKey] = [];

        // 🚀 INNOVATION: Context-Aware Payload
        unreadMetadata[platformKey].push({
            id: data.message_id,
            type: 'message',
            sender: sender,
            content: data.content,
            timestamp: new Date().toISOString(),
            is_priority: data.content?.toLowerCase().includes('urgent') || false
        });

        user.set('preferences', { ...user.preferences, unreadMetadata });
        user.changed('preferences', true);
        await user.save({ transaction });

        logger.info(`💬 [${platform}] Message queued for Shadow AI analysis.`);

        // 🛡️ GHOST RESPONDER: Auto-Reply Logic — requires BOTH the global master
        // switch AND this specific contact's minichat to have auto-reply enabled,
        // so turning the master switch on never silently starts auto-replying to
        // every contact at once.
        const incomingSenderId = data.sender?.id || data.author?.id;
        if (user.guardianEnabled && incomingSenderId && isContactAutoReplyEnabled(user, platform, incomingSenderId)) {
            const incomingContent = data.content?.text || data.text || "";
            const prompt = `AUTO_REPLY_MODE: A contact named ${sender} just sent you this on ${platform}: "${incomingContent}".
            Reply as ${user.aiPersona || 'Shadow'}. Be concise. Keep it tactical.`;

            const aiResponse = await getAiResponse(prompt, 'gemini-1.5-flash', [], user);

            if (aiResponse.success) {
                const delayMs = (user.autoReplyDelay || 15) * 60000;
                await DelayedAction.create({
                    deviceId: user.deviceId,
                    type: 'message',
                    platform: platform.toLowerCase(),
                    content: aiResponse.content,
                    targetId: data.sender?.id || data.author?.id,
                    executeAt: new Date(Date.now() + delayMs),
                    status: 'pending'
                }, { transaction });
                logger.info(`⏳ [${platform}] Auto-reply scheduled in ${user.autoReplyDelay} mins.`);
            }
        }
    }

    private static async handleMessageRead(user: any, data: any, platform: string, transaction: any) {
        if (user.unreadMessagesCount > 0) {
            user.unreadMessagesCount -= 1;

            const unreadMetadata = { ...(user.preferences?.unreadMetadata || {}) };
            const platformKey = platform.toLowerCase();
            if (unreadMetadata[platformKey]) {
                unreadMetadata[platformKey] = unreadMetadata[platformKey].filter((m: any) => m.id !== data.message_id);
                user.set('preferences', { ...user.preferences, unreadMetadata });
                user.changed('preferences', true);
            }

            await user.save({ transaction });
        }
    }

    private static async handleCommentReceived(user: any, data: any, platform: string, transaction: any) {
        // 💾 PERSISTENCE: Save to SocialEvent table
        await SocialEvent.create({
            deviceId: user.deviceId,
            platform: platform.toLowerCase(),
            type: 'comment',
            externalId: data.comment_id || `comment_${Date.now()}`,
            senderId: data.author?.id,
            senderName: data.author?.name || "Unknown",
            content: data.content || "",
            metadata: {
                post_id: data.post_id
            },
            timestamp: new Date(),
            isRead: false
        }, { transaction });

        const unreadMetadata = { ...(user.preferences?.unreadMetadata || {}) };
        const platformKey = platform.toLowerCase();
        if (!unreadMetadata[platformKey]) unreadMetadata[platformKey] = [];

        unreadMetadata[platformKey].push({
            id: data.comment_id,
            type: 'comment',
            sender: data.author?.name || "Unknown",
            content: data.content,
            post_id: data.post_id,
            timestamp: new Date().toISOString()
        });

        user.set('preferences', { ...user.preferences, unreadMetadata });
        user.changed('preferences', true);
        await user.save({ transaction });
    }

    private static async handleIncomingCall(user: any, data: any, platform: string, transaction: any) {
        const caller = data.caller?.name || data.caller?.id || "Unknown Caller";
        const unreadMetadata = { ...(user.preferences?.unreadMetadata || {}) };

        unreadMetadata['system_alerts'] = unreadMetadata['system_alerts'] || [];
        unreadMetadata['system_alerts'].push({
            id: data.call_id,
            type: 'call_incoming',
            platform,
            sender: caller,
            timestamp: new Date().toISOString(),
            action_required: 'BRIEFING'
        });

        user.set('preferences', { ...user.preferences, unreadMetadata });
        user.changed('preferences', true);
        await user.save({ transaction });
        logger.info(`📞 [${platform}] Alerting Shadow AI of incoming call from ${caller}`);
    }

    private static async handleCallEnded(user: any, data: any, platform: string, transaction: any) {
        const unreadMetadata = { ...(user.preferences?.unreadMetadata || {}) };
        unreadMetadata['system_alerts'] = unreadMetadata['system_alerts'] || [];

        unreadMetadata['system_alerts'].push({
            id: data.call_id,
            type: 'call_ended',
            platform,
            duration: data.duration_seconds,
            timestamp: new Date().toISOString(),
            action_required: 'SUMMARY'
        });

        user.set('preferences', { ...user.preferences, unreadMetadata });
        user.changed('preferences', true);
        await user.save({ transaction });
    }

    private static async handleWhatsAppTemplateUpdate(user: any, data: any, transaction: any) {
        const unreadMetadata = { ...(user.preferences?.unreadMetadata || {}) };
        unreadMetadata['system_alerts'] = unreadMetadata['system_alerts'] || [];

        unreadMetadata['system_alerts'].push({
            type: 'whatsapp_business',
            template_name: data.template_name,
            status: data.status,
            timestamp: new Date().toISOString()
        });

        user.set('preferences', { ...user.preferences, unreadMetadata });
        user.changed('preferences', true);
        await user.save({ transaction });
    }

    private static async handleAccountConnected(user: any, data: any, platform: string, transaction: any) {
        const connected = user.connectedPlatforms || [];
        const normPlatform = normalizePlatformId(platform || data?.platform || '');
        if (normPlatform && !connected.some((p: string) => isPlatformMatching(p, normPlatform))) {
            connected.push(normPlatform);
            user.connectedPlatforms = connected;
            await user.save({ transaction });
            logger.info(`✅ [${normPlatform}] Account connection secured via Webhook.`);
        }
    }

    private static async handleAccountDisconnected(user: any, data: any, platform: string, transaction: any) {
        const connected = user.connectedPlatforms || [];
        const normPlatform = normalizePlatformId(platform || data?.platform || '');
        user.connectedPlatforms = connected.filter((p: string) => !isPlatformMatching(p, normPlatform));
        await user.save({ transaction });
        logger.warn(`🛑 [${normPlatform}] Account disconnected via Webhook.`);
    }

    private static async handlePostPublished(user: any, data: any, platform: string, transaction: any) {
        // 💾 PERSISTENCE: Save our own published post to the flow
        await SocialEvent.create({
            deviceId: user.deviceId,
            platform: platform.toLowerCase(),
            type: 'post',
            externalId: data.post_id || `post_${Date.now()}`,
            senderId: 'self',
            senderName: user.userName || 'Me',
            content: data.content || "",
            metadata: {
                url: data.url
            },
            timestamp: new Date(),
            isRead: true
        }, { transaction });

        logger.info(`🚀 [${platform}] Post successfully published and persisted.`);
    }

    private static async handleMessageSent(user: any, data: any, platform: string, transaction: any) {
        // 💾 PERSISTENCE: Save our own outgoing message to history
        await SocialEvent.create({
            deviceId: user.deviceId,
            platform: platform.toLowerCase(),
            type: 'message',
            externalId: data.message_id || data.id || `sent_${Date.now()}`,
            senderId: 'self',
            senderName: user.userName || 'Me',
            content: data.content?.text || data.text || "",
            metadata: {
                attachments: data.attachments || [],
                recipientId: data.recipientId,
                conversationId: data.conversationId
            },
            timestamp: new Date(),
            isRead: true
        }, { transaction });

        logger.info(`📤 [${platform}] Outgoing message persisted to history.`);
    }

    private static async handlePostFailed(user: any, data: any, platform: string, transaction: any) {
        logger.error(`❌ [${platform}] Post publication failed: ${data?.error || 'Unknown error'}`);
        const unreadMetadata = { ...(user.preferences?.unreadMetadata || {}) };
        unreadMetadata['system_alerts'] = unreadMetadata['system_alerts'] || [];
        unreadMetadata['system_alerts'].push({
            type: 'post_failed',
            platform: platform || 'social',
            error: data?.error || 'Publishing failed',
            timestamp: new Date().toISOString()
        });
        user.set('preferences', { ...user.preferences, unreadMetadata });
        user.changed('preferences', true);
        await user.save({ transaction });
    }

    private static async handleMessageEdited(user: any, data: any, platform: string, transaction: any) {
        logger.info(`✏️ [${platform}] Message edited: ${data?.message_id || data?.id}`);
        await SocialEvent.update(
            { content: data?.content?.text || data?.text || "" },
            { where: { deviceId: user.deviceId, externalId: data?.message_id || data?.id }, transaction }
        );
    }

    private static async handleMessageDeleted(user: any, data: any, platform: string, transaction: any) {
        logger.info(`🗑️ [${platform}] Message deleted: ${data?.message_id || data?.id}`);
        await SocialEvent.destroy({
            where: { deviceId: user.deviceId, externalId: data?.message_id || data?.id },
            transaction
        });
    }

    private static async handleMessageDelivered(user: any, data: any, platform: string, transaction: any) {
        logger.info(`✓✓ [${platform}] Message delivered: ${data?.message_id || data?.id}`);
    }

    private static async handleMessageFailed(user: any, data: any, platform: string, transaction: any) {
        logger.error(`❌ [${platform}] Message delivery failed: ${data?.error || 'Unknown'}`);
    }

    private static async handleReactionReceived(user: any, data: any, platform: string, transaction: any) {
        logger.info(`❤️ [${platform}] Reaction received from ${data?.sender?.name || 'User'}`);
        await SocialEvent.create({
            deviceId: user.deviceId,
            platform: (platform || 'social').toLowerCase(),
            type: 'reaction',
            externalId: data?.reaction_id || `reaction_${Date.now()}`,
            senderId: data?.sender?.id,
            senderName: data?.sender?.name || 'User',
            content: `Reacted with ${data?.emoji || data?.reaction || '❤️'}`,
            metadata: data,
            timestamp: new Date(),
            isRead: false
        }, { transaction });
    }

    private static async handleCallFailed(user: any, data: any, platform: string, transaction: any) {
        logger.error(`❌ [${platform || 'system'}] Call failed: ${data?.error || 'Unknown'}`);
    }

    private static async handleWhatsAppNumberEvent(user: any, eventType: string, data: any, transaction: any) {
        logger.info(`📱 [WhatsApp Number Event] ${eventType}: ${JSON.stringify(data)}`);
        const unreadMetadata = { ...(user.preferences?.unreadMetadata || {}) };
        unreadMetadata['system_alerts'] = unreadMetadata['system_alerts'] || [];
        unreadMetadata['system_alerts'].push({
            type: 'whatsapp_number_event',
            event: eventType,
            data,
            timestamp: new Date().toISOString()
        });
        user.set('preferences', { ...user.preferences, unreadMetadata });
        user.changed('preferences', true);
        await user.save({ transaction });
    }

    private static async handlePostStatusEvent(user: any, eventType: string, data: any, platform: string, transaction: any) {
        logger.info(`📋 [${platform}] Post status event ${eventType}: ${data?.post_id || data?.id}`);
        const unreadMetadata = { ...(user.preferences?.unreadMetadata || {}) };
        unreadMetadata['system_alerts'] = unreadMetadata['system_alerts'] || [];
        unreadMetadata['system_alerts'].push({
            type: 'post_status',
            event: eventType,
            platform: platform || 'social',
            postId: data?.post_id || data?.id,
            error: data?.error,
            timestamp: new Date().toISOString()
        });
        user.set('preferences', { ...user.preferences, unreadMetadata });
        user.changed('preferences', true);
        await user.save({ transaction });
    }

    private static async handleConversationStarted(user: any, data: any, platform: string, transaction: any) {
        logger.info(`💬 [${platform}] New conversation started with ${data?.contactId || 'a contact'}`);
        const unreadMetadata = { ...(user.preferences?.unreadMetadata || {}) };
        unreadMetadata['system_alerts'] = unreadMetadata['system_alerts'] || [];
        unreadMetadata['system_alerts'].push({
            type: 'conversation_started',
            platform: platform || 'social',
            contactId: data?.contactId,
            timestamp: new Date().toISOString()
        });
        user.set('preferences', { ...user.preferences, unreadMetadata });
        user.changed('preferences', true);
        await user.save({ transaction });
    }

    private static async handleReviewEvent(user: any, eventType: string, data: any, platform: string, transaction: any) {
        logger.info(`⭐ [${platform}] ${eventType}: ${data?.rating ?? 'n/a'} stars`);
        await SocialEvent.create({
            deviceId: user.deviceId,
            platform: (platform || 'social').toLowerCase(),
            type: 'review',
            externalId: data?.review_id || data?.id || `review_${Date.now()}`,
            senderId: data?.author?.id,
            senderName: data?.author?.name || 'Reviewer',
            content: data?.text || '',
            metadata: { rating: data?.rating, event: eventType },
            timestamp: new Date(),
            isRead: false
        }, { transaction });
    }

    private static async handleLeadReceived(user: any, data: any, platform: string, transaction: any) {
        logger.info(`🧲 [${platform}] New lead received: ${data?.name || data?.id}`);
        const unreadMetadata = { ...(user.preferences?.unreadMetadata || {}) };
        unreadMetadata['system_alerts'] = unreadMetadata['system_alerts'] || [];
        unreadMetadata['system_alerts'].push({
            type: 'lead_received',
            platform: platform || 'social',
            name: data?.name,
            contact: data?.email || data?.phone,
            timestamp: new Date().toISOString()
        });
        user.set('preferences', { ...user.preferences, unreadMetadata });
        user.changed('preferences', true);
        await user.save({ transaction });
    }

    private static async handleVerificationEvent(user: any, eventType: string, data: any, transaction: any) {
        logger.info(`🛡️ [Verification Event] ${eventType}: ${JSON.stringify(data)}`);
        const unreadMetadata = { ...(user.preferences?.unreadMetadata || {}) };
        unreadMetadata['system_alerts'] = unreadMetadata['system_alerts'] || [];
        unreadMetadata['system_alerts'].push({
            type: 'verification_event',
            event: eventType,
            data,
            timestamp: new Date().toISOString()
        });
        user.set('preferences', { ...user.preferences, unreadMetadata });
        user.changed('preferences', true);
        await user.save({ transaction });
    }
}

// backend/src/services/webhookService.ts
import crypto from 'crypto';
import { Op } from 'sequelize';
import logger from '../utils/logger';
import { User, sequelize } from '../models/userModel';

export class WebhookService {
    private static readonly SECRET = process.env.ZERNIO_WEBHOOK_SECRET;

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
        const { type, data, platform, user_token, profile_id } = event;

        logger.info(`📨 [ZERNIO] Processing ${type} on ${platform}`);

        // Use a transaction to ensure all metadata updates happen atomically
        const transaction = await sequelize.transaction();

        try {
            // 🛡️ SECURITY: Strict Multi-Tenant Lookup
            // We search exclusively by profile_id to ensure the event belongs to the correct tenant.
            // Zernio guarantees profile_id is present for all multi-tenant events.
            const user = await User.findOne({
                where: { zernioProfileId: profile_id || 'NOT_FOUND' },
                transaction
            });

            if (!user) {
                logger.warn(`⚠️ Security Alert: Unauthorized or Orphaned Zernio Webhook for profile_id: ${profile_id}`);
                await transaction.rollback();
                return;
            }

            switch (type) {
                case 'message.received':
                    await this.handleIncomingMessage(user, data, platform, transaction);
                    break;
                case 'message.read':
                    await this.handleMessageRead(user, data, platform, transaction);
                    break;
                case 'comment.received':
                    await this.handleCommentReceived(user, data, platform, transaction);
                    break;
                case 'call.received':
                    await this.handleIncomingCall(user, data, platform, transaction);
                    break;
                case 'call.ended':
                    await this.handleCallEnded(user, data, platform, transaction);
                    break;
                case 'account.connected':
                    await this.handleAccountConnected(user, data, platform, transaction);
                    break;
                case 'account.disconnected':
                    await this.handleAccountDisconnected(user, data, platform, transaction);
                    break;
                case 'post.published':
                    await this.handlePostPublished(user, data, platform, transaction);
                    break;
                case 'message.sent':
                    await this.handleMessageSent(user, data, platform, transaction);
                    break;
                case 'whatsapp.template.status_updated':
                    await this.handleWhatsAppTemplateUpdate(user, data, transaction);
                    break;
                default:
                    // Future-proofing: Unknown events logged for AI pattern matching
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
        if (!connected.includes(platform.toLowerCase())) {
            connected.push(platform.toLowerCase());
            user.connectedPlatforms = connected;
            await user.save({ transaction });
            logger.info(`✅ [${platform}] Account connection secured via Webhook.`);
        }
    }

    private static async handleAccountDisconnected(user: any, data: any, platform: string, transaction: any) {
        const connected = user.connectedPlatforms || [];
        user.connectedPlatforms = connected.filter((p: string) => p !== platform.toLowerCase());
        await user.save({ transaction });
        logger.warn(`🛑 [${platform}] Account disconnected via Webhook.`);
    }

    private static async handlePostPublished(user: any, data: any, platform: string, transaction: any) {
        logger.info(`🚀 [${platform}] Post successfully published: ${data.post_id}`);
        // Optionally update a "Last Published" timestamp or similar
    }

    private static async handleMessageSent(user: any, data: any, platform: string, transaction: any) {
        logger.info(`📤 [${platform}] Message sent confirmation received.`);
    }
}

import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

export class User extends Model {
    public id!: number;
    public deviceId!: string;
    public firebaseUid!: string;
    public isPro!: boolean;
    public subscriptionTier!: string;
    public lastSocialSync!: Date | null;
    public zernioUserToken!: string | null;
    public socialDrafts!: any | null;
    public userName!: string | null;
    public aiPersona!: string | null;
    public preferences!: any | null;
    public messageCount!: number;
    public lastResetDate!: Date;
    public autoReplyDelay!: number;
    public vipList!: string[];
    public guardianEnabled!: boolean;
    public emergencyContacts!: any[];
    public connectedPlatforms!: string[];
    public unreadMessagesCount!: number;
    public zernioProfileId!: string | null; // Added for official Zernio SDK flow

    // 📍 Proactive Intelligence Fields
    public lastKnownLat!: number | null;
    public lastKnownLon!: number | null;
    public lastKnownCity!: string | null;
    public lastWeatherSummary!: string | null;
    public lastLocationUpdate!: Date | null;

    // Platform-specific OAuth tokens
    public twitterAccessToken!: string | null;
    public twitterRefreshToken!: string | null;
    public instagramAccessToken!: string | null;
    public whatsappAccessToken!: string | null;
    public whatsappWabaId!: string | null;
    public whatsappPhoneId!: string | null;
    public facebookAccessToken!: string | null;
    public linkedinAccessToken!: string | null;
    public discordAccessToken!: string | null;
    public telegramAccessToken!: string | null;
    public redditAccessToken!: string | null;
}

User.init({
    deviceId: { type: DataTypes.STRING, allowNull: false, unique: true },
    firebaseUid: { type: DataTypes.STRING, allowNull: true, unique: true },
    isPro: { type: DataTypes.BOOLEAN, defaultValue: false },
    subscriptionTier: { type: DataTypes.STRING, defaultValue: 'free' },
    lastSocialSync: { type: DataTypes.DATE, allowNull: true },
    zernioUserToken: { type: DataTypes.STRING, allowNull: true },
    socialDrafts: { type: DataTypes.JSONB, allowNull: true },
    userName: { type: DataTypes.STRING, allowNull: true },
    aiPersona: { type: DataTypes.STRING, allowNull: true, defaultValue: 'Shadow' },
    preferences: { type: DataTypes.JSONB, defaultValue: {} },
    messageCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    lastResetDate: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    autoReplyDelay: { type: DataTypes.INTEGER, defaultValue: 15 },
    vipList: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: [] },
    guardianEnabled: { type: DataTypes.BOOLEAN, defaultValue: false },
    emergencyContacts: { type: DataTypes.JSONB, defaultValue: [] },
    connectedPlatforms: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: [] },
    unreadMessagesCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    zernioProfileId: { type: DataTypes.STRING, allowNull: true },

    // 📍 Proactive Intelligence Fields
    lastKnownLat: { type: DataTypes.FLOAT, allowNull: true },
    lastKnownLon: { type: DataTypes.FLOAT, allowNull: true },
    lastKnownCity: { type: DataTypes.STRING, allowNull: true },
    lastWeatherSummary: { type: DataTypes.TEXT, allowNull: true },
    lastLocationUpdate: { type: DataTypes.DATE, allowNull: true },

    // Platform-specific OAuth tokens
    twitterAccessToken: { type: DataTypes.TEXT, allowNull: true },
    twitterRefreshToken: { type: DataTypes.TEXT, allowNull: true },
    instagramAccessToken: { type: DataTypes.TEXT, allowNull: true },
    whatsappAccessToken: { type: DataTypes.TEXT, allowNull: true },
    whatsappWabaId: { type: DataTypes.STRING, allowNull: true },
    whatsappPhoneId: { type: DataTypes.STRING, allowNull: true },
    facebookAccessToken: { type: DataTypes.TEXT, allowNull: true },
    linkedinAccessToken: { type: DataTypes.TEXT, allowNull: true },
    discordAccessToken: { type: DataTypes.TEXT, allowNull: true },
    telegramAccessToken: { type: DataTypes.TEXT, allowNull: true },
    redditAccessToken: { type: DataTypes.TEXT, allowNull: true }
}, {
    sequelize,
    modelName: 'User',
    tableName: 'Users'
});

export class DelayedAction extends Model {
    public id!: number;
    public deviceId!: string;
    public type!: string;
    public platform!: string;
    public content!: string;
    public targetId!: string;
    public executeAt!: Date;
    public status!: string;
}

DelayedAction.init({
    deviceId: { type: DataTypes.STRING, allowNull: false },
    type: { type: DataTypes.STRING, allowNull: false },
    platform: { type: DataTypes.STRING, allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: false },
    targetId: { type: DataTypes.STRING, allowNull: false },
    executeAt: { type: DataTypes.DATE, allowNull: false },
    status: { type: DataTypes.STRING, defaultValue: 'pending' }
}, {
    sequelize,
    modelName: 'DelayedAction',
    tableName: 'DelayedActions'
});

/**
 * 🛰️ INTELLIGENCE BUFFER MODEL
 * Stores the rolling 15 items per category.
 */
export class IntelligenceBuffer extends Model {
    public id!: number;
    public category!: string; // 'news', 'movies', 'novels', 'journals', 'astro'
    public items!: any; // JSON array of 15 items
    public lastUpdated!: Date;
}

IntelligenceBuffer.init({
    category: { type: DataTypes.STRING, allowNull: false, unique: true },
    items: { type: DataTypes.JSONB, defaultValue: [] },
    lastUpdated: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
    sequelize,
    modelName: 'IntelligenceBuffer',
    tableName: 'IntelligenceBuffers'
});

/**
 * 📨 SOCIAL EVENT MODEL
 * Stores messages, comments, and posts from webhooks.
 */
export class SocialEvent extends Model {
    public id!: number;
    public deviceId!: string;
    public platform!: string;
    public type!: string; // 'message', 'comment', 'mention', 'post'
    public externalId!: string; // Platform's own ID
    public senderId!: string;
    public senderName!: string;
    public content!: string;
    public metadata!: any; // JSON for attachments, etc.
    public timestamp!: Date;
    public isRead!: boolean;
}

SocialEvent.init({
    deviceId: { type: DataTypes.STRING, allowNull: false },
    platform: { type: DataTypes.STRING, allowNull: false },
    type: { type: DataTypes.STRING, allowNull: false },
    externalId: { type: DataTypes.STRING, allowNull: false },
    senderId: { type: DataTypes.STRING, allowNull: true },
    senderName: { type: DataTypes.STRING, allowNull: true },
    content: { type: DataTypes.TEXT, allowNull: true },
    metadata: { type: DataTypes.JSONB, defaultValue: {} },
    timestamp: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    isRead: { type: DataTypes.BOOLEAN, defaultValue: false }
}, {
    sequelize,
    modelName: 'SocialEvent',
    tableName: 'SocialEvents'
});

export { sequelize };

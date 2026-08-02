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

export { sequelize };

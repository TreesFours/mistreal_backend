import { Sequelize, DataTypes, Model } from 'sequelize';

const sequelize = new Sequelize(process.env.DATABASE_URL!, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
        ssl: {
            require: true,
            rejectUnauthorized: false
        }
    }
});

export class User extends Model {
    public id!: number;
    public deviceId!: string;
    public firebaseUid!: string; // Real permanent ID
    public isPro!: boolean;
    public subscriptionTier!: string;
    public lastSocialSync!: Date | null;
    public zernioUserToken!: string | null;
    public socialDrafts!: any | null;
    public userName!: string | null;
    public preferences!: any | null;
    public messageCount!: number;
    public lastResetDate!: Date;
    public autoReplyDelay!: number; // in minutes
    public vipList!: string[]; // array of usernames/ids
    public guardianEnabled!: boolean;
    public emergencyContacts!: any[]; // [{name, type, value}] where type is 'phone', 'email', 'social'
    public connectedPlatforms!: string[]; // List of platform IDs user has connected
    public unreadMessagesCount!: number;
}

User.init({
    deviceId: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    firebaseUid: {
        type: DataTypes.STRING,
        allowNull: true,
        unique: true
    },
    isPro: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    subscriptionTier: {
        type: DataTypes.STRING,
        defaultValue: 'free'
    },
    lastSocialSync: {
        type: DataTypes.DATE,
        allowNull: true
    },
    zernioUserToken: {
        type: DataTypes.STRING,
        allowNull: true
    },
    socialDrafts: {
        type: DataTypes.JSONB,
        allowNull: true
    },
    userName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    preferences: {
        type: DataTypes.JSONB,
        defaultValue: {}
    },
    messageCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    lastResetDate: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
    },
    autoReplyDelay: {
        type: DataTypes.INTEGER,
        defaultValue: 15
    },
    vipList: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: []
    },
    guardianEnabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    emergencyContacts: {
        type: DataTypes.JSONB,
        defaultValue: []
    },
    connectedPlatforms: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: []
    },
    unreadMessagesCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    }
}, {
    sequelize,
    modelName: 'User'
});

export class DelayedAction extends Model {
    public id!: number;
    public deviceId!: string;
    public type!: string;
    public platform!: string;
    public content!: string;
    public targetId!: string;
    public executeAt!: Date;
    public status!: string; // 'pending', 'completed', 'cancelled'
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
    modelName: 'DelayedAction'
});

export { sequelize };

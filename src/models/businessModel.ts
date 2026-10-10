import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * Server-side mirror of the Business Hub feature (the local Room copy
 * BusinessEntity/BusinessItemEntity is still the device's own source of
 * truth for the owner's edits). Originally just enough for Ad.businessId to
 * FK against — expanded to carry everything needed for OTHER users to
 * actually discover and contact this business, since there was previously
 * no cross-device business directory at all (only `/register` existed; no
 * search/list endpoint, so a business was only ever visible on the device
 * that registered it).
 */
export class Business extends Model {
    public businessId!: string;
    public ownerDeviceId!: string;
    public ownerFirebaseUid!: string | null;
    public name!: string;
    public description!: string | null;
    public category!: string;
    public address!: string | null;
    public latitude!: number | null;
    public longitude!: number | null;
    public logoUrl!: string | null;
    // [{platform, handle}] — a public @handle the business owner declares,
    // NOT an opaque Zernio contactId. A customer resolves it to a real,
    // DM-able contactId themselves via the same platform-username search the
    // chat drawer already uses (ZernioAdapter.searchPlatform) — this field
    // never stores a contactId directly since that's specific to whichever
    // Zernio profile looked it up.
    public connectedPlatforms!: { platform: string; handle: string }[];
    // Owner identity shown on the profile — either their live-captured
    // Verified Face (resolved client-side, never uploaded here) or a
    // separately-uploaded photo, per the user's explicit choice of "either."
    public ownerName!: string | null;
    public ownerPhotoUrl!: string | null;
}

Business.init({
    businessId: { type: DataTypes.STRING, primaryKey: true },
    ownerDeviceId: { type: DataTypes.STRING, allowNull: false },
    ownerFirebaseUid: { type: DataTypes.STRING, allowNull: true },
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    category: { type: DataTypes.STRING, allowNull: false },
    address: { type: DataTypes.STRING, allowNull: true },
    latitude: { type: DataTypes.FLOAT, allowNull: true },
    longitude: { type: DataTypes.FLOAT, allowNull: true },
    logoUrl: { type: DataTypes.STRING, allowNull: true },
    connectedPlatforms: { type: DataTypes.JSONB, defaultValue: [] },
    ownerName: { type: DataTypes.STRING, allowNull: true },
    ownerPhotoUrl: { type: DataTypes.STRING, allowNull: true }
}, {
    sequelize,
    modelName: 'Business',
    tableName: 'Businesses'
});

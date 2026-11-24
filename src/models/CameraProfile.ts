import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';

/**
 * 📷 CAMERA PROFILE — live-cam discovery feed
 * A persistent, user-submitted camera/stream entry — nothing like this
 * existed before (confirmed: every prior "camera" list in this app, e.g.
 * WatchHostScreen.kt's sampleEarthCams or EarthCamOverlay.kt's
 * DEFAULT_CAMERAS, was hardcoded UI with zero backend behind it, and
 * included RTSP URLs that nothing in the app can actually play).
 *
 * Only `youtube` and `hls` stream types are accepted — confirmed those are
 * the only two formats this app can actually render (YoutubePlayerWebView,
 * and ExoPlayer once the media3-exoplayer-hls module is added). RTSP/MJPEG
 * submissions are rejected at the route layer, not stored as a silently
 * broken entry.
 *
 * Moderation is a manual admin review queue (the product decision made for
 * this feature) — structurally mirrors Review.ts's pending/published
 * state-machine shape more than any "camera" precedent, since none exists.
 */
export class CameraProfile extends Model {
    public id!: string;
    public submitterDeviceId!: string;
    public title!: string;
    public location!: string | null;
    public streamUrl!: string;
    public streamType!: string; // 'youtube' | 'hls'
    public status!: string; // 'pending' | 'approved' | 'rejected'
    public createdAt!: Date;
}

CameraProfile.init({
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    submitterDeviceId: { type: DataTypes.STRING, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    location: { type: DataTypes.STRING, allowNull: true },
    streamUrl: { type: DataTypes.STRING, allowNull: false },
    streamType: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, defaultValue: 'pending' },
    createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
    sequelize,
    modelName: 'CameraProfile',
    tableName: 'CameraProfiles',
    updatedAt: false
});

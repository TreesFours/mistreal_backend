import { google } from 'googleapis';
import { Readable } from 'stream';
import { encrypt, decrypt } from '../../utils/secretCrypto';
import { User } from '../../models/userModel';
import logger from '../../utils/logger';

// Separate from youtubeService.ts (that one is the API-key-only curated feed —
// no user identity involved at all). This is real per-user OAuth: Zernio has
// no YouTube upload capability whatsoever (confirmed — its /posts endpoint
// never covers YouTube), so posting has to go around Zernio entirely and talk
// to Google directly.
const SCOPES = [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly'
];

const getOAuthClient = (redirectUri: string) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not configured — register an OAuth client in Google Cloud Console.');
    }
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
};

export const YoutubeNativeAuth = {
    getAuthUrl: (deviceId: string, redirectUri: string): string => {
        const oauth2Client = getOAuthClient(redirectUri);
        const state = Buffer.from(JSON.stringify({ deviceId, platform: 'youtube' })).toString('base64');
        return oauth2Client.generateAuthUrl({
            access_type: 'offline', // required to receive a refresh_token, not just a short-lived access_token
            prompt: 'consent',      // forces Google to re-issue a refresh_token even on a repeat connect
            scope: SCOPES,
            state
        });
    },

    exchangeCodeAndStore: async (deviceId: string, code: string, redirectUri: string): Promise<void> => {
        const oauth2Client = getOAuthClient(redirectUri);
        const { tokens } = await oauth2Client.getToken(code);

        if (!tokens.refresh_token) {
            // Can happen if Google's consent screen was skipped (stale prior
            // grant) despite prompt=consent — fail loud rather than silently
            // saving a "connected" state that can never actually upload.
            throw new Error('YOUTUBE_NO_REFRESH_TOKEN: Google did not return a refresh token — disconnect and reconnect YouTube.');
        }

        let user = await User.findOne({ where: { deviceId } });
        if (!user) user = await User.create({ deviceId, connectedPlatforms: [] });

        user.youtubeRefreshToken = encrypt(tokens.refresh_token);
        const connected: string[] = user.connectedPlatforms || [];
        if (!connected.includes('youtube')) {
            user.set('connectedPlatforms', [...connected, 'youtube']);
            user.changed('connectedPlatforms', true);
        }
        await user.save();
        logger.info(`✅ YouTube connected (native Google OAuth) for device ${deviceId}`);
    },

    isConnected: async (deviceId: string): Promise<boolean> => {
        const user = await User.findOne({ where: { deviceId } });
        return !!user?.youtubeRefreshToken;
    },

    disconnect: async (deviceId: string): Promise<void> => {
        const user = await User.findOne({ where: { deviceId } });
        if (!user) return;
        user.youtubeRefreshToken = null;
        await user.save();
    },

    // Built fresh per upload rather than cached — googleapis transparently
    // exchanges the stored refresh_token for a live access_token as needed,
    // so there's no separate expiry-tracking to maintain on our side.
    getAuthorizedClient: async (deviceId: string) => {
        const user = await User.findOne({ where: { deviceId } });
        if (!user?.youtubeRefreshToken) throw new Error('YouTube not connected for this device.');

        const redirectUri = `${process.env.APP_URL || 'https://mistreal-backend.onrender.com'}/api/social/youtube/callback`;
        const oauth2Client = getOAuthClient(redirectUri);
        oauth2Client.setCredentials({ refresh_token: decrypt(user.youtubeRefreshToken) });
        return oauth2Client;
    }
};

export const uploadYoutubeVideo = async (
    deviceId: string,
    videoBuffer: Buffer,
    title: string,
    description: string,
    privacyStatus: 'public' | 'unlisted' | 'private' = 'public'
): Promise<{ videoId: string; url: string }> => {
    const auth = await YoutubeNativeAuth.getAuthorizedClient(deviceId);
    const youtube = google.youtube({ version: 'v3', auth });

    const response = await youtube.videos.insert({
        part: ['snippet', 'status'],
        requestBody: {
            snippet: { title, description },
            status: { privacyStatus }
        },
        media: {
            body: Readable.from(videoBuffer)
        }
    });

    const videoId = response.data.id;
    if (!videoId) throw new Error('YouTube did not return a video id after upload.');
    return { videoId, url: `https://youtube.com/watch?v=${videoId}` };
};

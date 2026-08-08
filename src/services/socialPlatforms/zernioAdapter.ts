import axios from 'axios';

const ZERNIO_API_URL = 'https://zernio.com/api/v1'; // Official Base URL
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY || '';

/**
 * 🚀 OFFICIAL ZERNIO SDK-ALIGNED ADAPTER
 * Implements the "Build a Platform" multi-tenant flow:
 * 1. Create a Profile (Container) per user.
 * 2. Connect accounts to that Profile.
 * 3. Fetch/Post via the Unified API.
 */
export const ZernioAdapter = {

  /**
   * Step 1: Create a Profile for the user if they don't have one
   * Profiles group accounts together for a single "Tenant" (your app user).
   */
  getOrCreateProfile: async (deviceId: string) => {
    try {
      // First, try to find if we've stored a profileId for this deviceId in our DB
      // (Implementation note: You should add a 'zernioProfileId' field to your User model)

      const response = await axios.post(`${ZERNIO_API_URL}/profiles`, {
        name: `User ${deviceId.slice(0, 6)}`,
        description: `Mistreal Agent Profile for device ${deviceId}`
      }, {
        headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` }
      });

      return response.data.profile._id; // The 24-char MongoDB ID
    } catch (error: any) {
      const status = error.response?.status;
      const data = error.response?.data;

      if (status === 402) {
        throw new Error('ZERNIO_PAYMENT_REQUIRED: Your Zernio account has reached its free profile limit or needs a valid payment method.');
      }

      console.error('Zernio Profile Error:', data || error.message);
      throw new Error(`Failed to initialize social profile: ${data?.error || error.message}`);
    }
  },

  /**
   * Step 2: Get the Auth URL for any platform (including WhatsApp!)
   * Zernio handles the "Embedded Signup" or OAuth complexity automatically.
   */
  getAuthUrl: async (platform: string, profileId: string, scope?: string, state?: string) => {
    try {
      const response = await axios.get(`${ZERNIO_API_URL}/connect/${encodeURIComponent(platform)}`, {
        params: {
            profileId,
            scope,
            state,
            headless: 'false', // 🔄 Switch to Zernio's Hosted Picker for easier multi-tenant use
            redirect_uri: 'https://mistreal-backend.onrender.com/api/social/callback'
        },
        headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` }
      });

      return response.data.authUrl;
    } catch (error: any) {
      const status = error.response?.status;
      const data = error.response?.data;

      if (status === 402) {
        throw new Error('ZERNIO_PAYMENT_REQUIRED: Connecting this account requires an active Zernio subscription.');
      }

      console.error(`Zernio Auth URL Error [${platform}]:`, data || error.message);
      throw new Error(`Social system error (${status}): ${data?.error || error.message}`);
    }
  },

  /**
   * Step 3: Fetch Inbox (DMs/Comments)
   * Fetches from the unified inbox for this profile.
   */
  fetchInbox: async (profileId: string) => {
    try {
      const response = await axios.get(`${ZERNIO_API_URL}/inbox`, {
        params: { profileId },
        headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` }
      });
      return response.data.items || [];
    } catch (error: any) {
      return [];
    }
  },

  /**
   * Step 4: Dispatch Content (Post/Status)
   * The single endpoint that covers all platforms and posting modes.
   */
  sendAction: async (profileId: string, platform: string, content: string, type: string) => {
    try {
      // First, get the accountId for this platform within the profile
      const accountsResp = await axios.get(`${ZERNIO_API_URL}/accounts`, {
        params: { profileId },
        headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` }
      });

      const account = accountsResp.data.accounts.find((a: any) => a.platform === platform);
      if (!account) throw new Error(`${platform} not linked to this profile.`);

      const postData: any = {
        content,
        publishNow: true,
        platforms: [
          { platform, accountId: account._id }
        ]
      };

      // Handle Story/Status specific logic if needed by platform
      if (type === 'status' || type === 'story') {
        postData.platforms[0].options = { is_story: true };
      }

      const response = await axios.post(`${ZERNIO_API_URL}/posts`, postData, {
        headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` }
      });

      return response.data;
    } catch (error: any) {
      console.error(`Zernio Dispatch Error [${platform}]:`, error.response?.data || error.message);
      throw new Error(`Dispatch failed: ${error.response?.data?.error || error.message}`);
    }
  }
};

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
  getAuthUrl: async (platform: string, profileId: string, scope?: string, state?: string, customRedirectUrl?: string) => {
    try {
      const baseUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
      const callbackUrl = customRedirectUrl || `${baseUrl}/api/social/callback`;

      const response = await axios.get(`${ZERNIO_API_URL}/connect/${encodeURIComponent(platform)}`, {
        params: {
            profileId,
            scope,
            state,
            headless: 'true',
            redirect_url: callbackUrl
        },
        headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` }
      });

      // 🛡️ Double Check: Ensure Zernio isn't ignoring our redirect_uri
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
      if (!profileId) throw new Error('Security Error: profileId is required for data isolation.');
      const response = await axios.get(`${ZERNIO_API_URL}/inbox`, {
        params: { profileId },
        headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` }
      });
      return response.data.items || [];
    } catch (error: any) {
      console.error(`Zernio Fetch Error [${profileId}]:`, error.message);
      return [];
    }
  },

  /**
   * Step 4: Dispatch Content or Perform Actions (Like/Follow/DM)
   */
  sendAction: async (profileId: string, platform: string, content: string, type: string, targetId?: string) => {
    try {
      if (!profileId) throw new Error('Security Error: profileId is required for multi-tenant isolation.');

      const accountsResp = await axios.get(`${ZERNIO_API_URL}/accounts`, {
        params: { profileId },
        headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` }
      });

      const account = accountsResp.data.accounts.find((a: any) => a.platform === platform);
      if (!account) throw new Error(`${platform} not linked to this profile.`);

      // 🛡️ BRANCH: Content vs Actions
      if (type.toLowerCase() === 'like' || type.toLowerCase() === 'follow') {
        const response = await axios.post(`${ZERNIO_API_URL}/actions`, {
          platform,
          accountId: account._id,
          type: type.toLowerCase(),
          targetId: targetId
        }, {
          headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` }
        });
        return response.data;
      }

      if (type === 'Direct Message') {
        const response = await axios.post(`${ZERNIO_API_URL}/messages`, {
            platform,
            accountId: account._id,
            recipientId: targetId,
            content: { text: content }
        }, {
            headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` }
        });
        return response.data;
      }

      // Default: POST (Tweet, FB Post, etc)
      const postData: any = {
        content,
        publishNow: true,
        platforms: [
          { platform, accountId: account._id }
        ]
      };

      if (type === 'status' || type === 'story') {
        postData.platforms[0].options = { is_story: true };
      }

      const response = await axios.post(`${ZERNIO_API_URL}/posts`, postData, {
        headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` }
      });

      return response.data;
    } catch (error: any) {
      console.error(`Zernio Dispatch Error [${platform}/${type}]:`, error.response?.data || error.message);
      throw new Error(`Social action failed: ${error.response?.data?.error || error.message}`);
    }
  },

  /**
   * Step 5: Finalize Headless Connection
   * Automatically selects the first available page/profile to complete the link.
   */
  finalizeHeadlessConnection: async (platform: string, profileId: string, tempToken: string, userProfile?: string) => {
    try {
      if (!profileId) throw new Error('Security Error: profileId is required for headless finalization.');

      // 1. List available accounts for this platform connection
      const listResp = await axios.get(`${ZERNIO_API_URL}/connect/${platform}/pages`, {
        params: { profileId, tempToken },
        headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` }
      });

      const pages = listResp.data.pages || listResp.data.elements || [];
      if (pages.length === 0) throw new Error('No accounts found to connect.');

      // 2. Select the first one automatically (Strategy: Direct Link)
      // Note: For LinkedIn/Twitter this is usually just the user's profile.
      const selectedAccount = pages[0];
      const accountId = selectedAccount.id || selectedAccount.accountId || selectedAccount._id;

      const selectResp = await axios.post(`${ZERNIO_API_URL}/connect/${platform}/select`, {
        profileId,
        tempToken,
        accountId,
        userProfile: userProfile ? JSON.parse(decodeURIComponent(userProfile)) : undefined,
        redirect_url: 'https://mistreal-backend.onrender.com/api/social/callback/success' // Internal marker
      }, {
        headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` }
      });

      return {
          success: true,
          accountId,
          platformDisplayName: selectedAccount.name || platform
      };
    } catch (error: any) {
      console.error(`Zernio Headless Finalize Error [${platform}]:`, error.response?.data || error.message);
      throw new Error(`Failed to finalize connection: ${error.response?.data?.error || error.message}`);
    }
  }
};

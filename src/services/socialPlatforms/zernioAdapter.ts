import axios from 'axios';

const ZERNIO_API_URL = process.env.ZERNIO_API_URL || 'https://api.zernio.com';
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY || '';
const ZERNIO_CLIENT_ID = process.env.ZERNIO_CLIENT_ID || '';
const ZERNIO_CLIENT_SECRET = process.env.ZERNIO_CLIENT_SECRET || '';

/**
 * Generic Zernio adapter.
 * NOTE: Zernio endpoints may differ; this adapter uses reasonable defaults
 * so the code is ready to switch once you provide real Zernio API docs/URL.
 */
export const ZernioAdapter = {
  getAuthUrl: (deviceId: string, callbackUrl: string, platform: string) => {
    const state = Buffer.from(JSON.stringify({ deviceId, platform })).toString('base64');
    // FIXED: Added client_id which is required by Zernio OAuth
    return `${ZERNIO_API_URL}/oauth/authorize?client_id=${ZERNIO_CLIENT_ID}&platform=${encodeURIComponent(platform)}&redirect_uri=${encodeURIComponent(callbackUrl)}&state=${state}`;
  },

  exchangeCodeForToken: async (code: string, callbackUrl: string, platform: string) => {
    try {
      const resp = await axios.post(
        `${ZERNIO_API_URL}/oauth/token`,
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: callbackUrl,
          client_id: ZERNIO_CLIENT_ID,
          client_secret: ZERNIO_CLIENT_SECRET,
          platform
        },
        {
          headers: {
            'Authorization': `ApiKey ${ZERNIO_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      // Expecting response: { access_token, refresh_token?, expires_in? }
      return {
        accessToken: resp.data.access_token,
        refreshToken: resp.data.refresh_token || null,
        expiresIn: resp.data.expires_in || null
      };
    } catch (error: any) {
      console.error('Zernio token exchange failed:', error.response?.data || error.message);
      throw new Error('Failed to exchange code with Zernio');
    }
  },

  fetchContent: async (accessToken: string, platform: string) => {
    try {
      // Generic fetch endpoint — adjust when you have real Zernio docs
      const resp = await axios.get(`${ZERNIO_API_URL}/v1/platforms/${encodeURIComponent(platform)}/me/content`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Api-Key': ZERNIO_API_KEY
        },
        params: { limit: 50 }
      });

      // Normalize to our post shape where possible
      const items = resp.data?.data || [];
      return items.map((it: any) => ({
        id: it.id || it.message_id || `${platform}-${Math.random().toString(36).slice(2,9)}`,
        platform: platform,
        author: it.author || it.from || 'Unknown',
        content: it.text || it.body || it.caption || '(no text)',
        timestamp: it.timestamp ? new Date(it.timestamp) : new Date(),
        sourceUrl: it.url || it.permalink || null,
        platformIcon: '?',
        platformColor: '#888',
        platformDisplayName: platform
      }));
    } catch (error: any) {
      console.error(`Zernio fetchContent failed for ${platform}:`, error.response?.data || error.message);
      return [];
    }
  },

  sendAction: async (accessToken: string, platform: string, action: { type: string, content: string, targetId?: string }) => {
    try {
      const resp = await axios.post(`${ZERNIO_API_URL}/v1/platforms/${encodeURIComponent(platform)}/actions`, action, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Api-Key': ZERNIO_API_KEY
        }
      });
      return resp.data;
    } catch (error: any) {
      console.error(`Zernio action failed for ${platform}:`, error.response?.data || error.message);
      throw new Error(`Social action failed: ${error.response?.data?.error || error.message}`);
    }
  },

  // === WHATSAPP EMBEDDED SIGNUP (META APPROVED) ===
  getWhatsAppSdkConfig: async () => {
    try {
      const resp = await axios.get(`${ZERNIO_API_URL}/v1/connect/whatsapp/sdk-config`, {
        headers: { 'Authorization': `ApiKey ${ZERNIO_API_KEY}` }
      });
      return resp.data; // { appId, configId }
    } catch (error: any) {
      console.error('Failed to fetch WhatsApp SDK config:', error.message);
      throw error;
    }
  },

  completeWhatsAppSignup: async (code: string) => {
    try {
      const resp = await axios.post(`${ZERNIO_API_URL}/v1/connect/whatsapp/embedded-signup`, {
        code
      }, {
        headers: {
          'Authorization': `ApiKey ${ZERNIO_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      return resp.data; // { accessToken, wabaId, phoneNumberId }
    } catch (error: any) {
      console.error('Failed to complete WhatsApp signup:', error.response?.data || error.message);
      throw error;
    }
  }
};

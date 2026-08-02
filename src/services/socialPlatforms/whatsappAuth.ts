// WhatsApp Business API Handler
import axios from 'axios';

const WHATSAPP_API_BASE = 'https://graph.instagram.com/v18.0';

export class WhatsAppOAuth {
  static getAuthUrl(deviceId: string, callbackUrl: string): string {
    const clientId = process.env.WHATSAPP_CLIENT_ID;
    if (!clientId) {
      throw new Error('WHATSAPP_CLIENT_ID not configured');
    }

    const state = Buffer.from(
      JSON.stringify({ deviceId, platform: 'whatsapp' })
    ).toString('base64');

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      scope: 'whatsapp_business_account_management,whatsapp_business_messaging',
      response_type: 'code',
      state: state
    });

    return `https://api.instagram.com/oauth/authorize?${params.toString()}`;
  }

  static async exchangeCodeForToken(code: string, callbackUrl: string): Promise<any> {
    const clientId = process.env.WHATSAPP_CLIENT_ID;
    const clientSecret = process.env.WHATSAPP_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('WhatsApp OAuth credentials not configured');
    }

    try {
      const response = await axios.post(
        'https://graph.instagram.com/oauth/access_token',
        {
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          redirect_uri: callbackUrl,
          code
        }
      );

      return {
        accessToken: response.data.access_token,
        userId: response.data.user_id,
        tokenType: response.data.token_type
      };
    } catch (error: any) {
      console.error('WhatsApp token exchange failed:', error.response?.data || error.message);
      throw new Error('Failed to exchange WhatsApp code for token');
    }
  }

  static async fetchMessages(accessToken: string, phoneNumberId: string): Promise<any[]> {
    try {
      // Fetch recent messages
      const response = await axios.get(
        `${WHATSAPP_API_BASE}/${phoneNumberId}/messages`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            fields: 'id,from,to,type,timestamp,status,message',
            limit: 20
          }
        }
      );

      const messages = response.data.data || [];

      return messages.map((msg: any) => ({
        id: msg.id,
        platform: 'whatsapp',
        author: msg.from || 'Unknown',
        content: msg.message || '(Media message)',
        timestamp: new Date(parseInt(msg.timestamp) * 1000),
        type: msg.type,
        status: msg.status,
        platformIcon: '💬',
        platformColor: '#25D366',
        platformDisplayName: 'WhatsApp'
      }));
    } catch (error: any) {
      console.error('Failed to fetch WhatsApp messages:', error.message);
      return [];
    }
  }
}

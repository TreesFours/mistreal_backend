// Instagram Graph API OAuth Handler
import axios from 'axios';

const INSTAGRAM_GRAPH_BASE = 'https://api.instagram.com';

export class InstagramOAuth {
  static getAuthUrl(deviceId: string, callbackUrl: string): string {
    const clientId = process.env.INSTAGRAM_CLIENT_ID;
    if (!clientId) {
      throw new Error('INSTAGRAM_CLIENT_ID not configured');
    }

    const state = Buffer.from(
      JSON.stringify({ deviceId, platform: 'instagram' })
    ).toString('base64');

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      scope: 'user_profile,user_media',
      response_type: 'code',
      state: state
    });

    return `https://api.instagram.com/oauth/authorize?${params.toString()}`;
  }

  static async exchangeCodeForToken(code: string, callbackUrl: string): Promise<any> {
    const clientId = process.env.INSTAGRAM_CLIENT_ID;
    const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Instagram OAuth credentials not configured');
    }

    try {
      const response = await axios.post(`${INSTAGRAM_GRAPH_BASE}/oauth/access_token`, {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: callbackUrl,
        code
      });

      return {
        accessToken: response.data.access_token,
        userId: response.data.user_id,
        tokenType: response.data.token_type
      };
    } catch (error: any) {
      console.error('Instagram token exchange failed:', error.response?.data || error.message);
      throw new Error('Failed to exchange Instagram code for token');
    }
  }

  static async fetchUserPosts(accessToken: string): Promise<any[]> {
    try {
      // Get user profile info
      const userResponse = await axios.get(`${INSTAGRAM_GRAPH_BASE}/me`, {
        params: {
          fields: 'id,username,name,profile_picture_url',
          access_token: accessToken
        }
      });

      const userId = userResponse.data.id;
      const username = userResponse.data.username;

      // Fetch user's media
      const mediaResponse = await axios.get(
        `${INSTAGRAM_GRAPH_BASE}/${userId}/media`,
        {
          params: {
            fields: 'id,caption,timestamp,media_type,media_url,permalink,like_count,comments_count',
            access_token: accessToken,
            limit: 20
          }
        }
      );

      const media = mediaResponse.data.data || [];

      return media.map((post: any) => ({
        id: post.id,
        platform: 'instagram',
        author: username,
        content: post.caption || '(No caption)',
        timestamp: new Date(post.timestamp),
        imageUrl: post.media_type === 'IMAGE' ? post.media_url : null,
        videoUrl: post.media_type === 'VIDEO' ? post.media_url : null,
        likes: post.like_count || 0,
        comments: post.comments_count || 0,
        sourceUrl: post.permalink,
        platformIcon: '📷',
        platformColor: '#E4405F',
        platformDisplayName: 'Instagram'
      }));
    } catch (error: any) {
      console.error('Failed to fetch Instagram posts:', error.message);
      return [];
    }
  }
}

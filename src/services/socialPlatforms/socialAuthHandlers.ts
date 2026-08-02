// Facebook/LinkedIn OAuth Handlers
import axios from 'axios';

// FACEBOOK
export class FacebookOAuth {
  static getAuthUrl(deviceId: string, callbackUrl: string): string {
    const clientId = process.env.FACEBOOK_CLIENT_ID;
    if (!clientId) {
      throw new Error('FACEBOOK_CLIENT_ID not configured');
    }

    const state = Buffer.from(
      JSON.stringify({ deviceId, platform: 'facebook' })
    ).toString('base64');

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      scope: 'public_profile,user_posts,user_friends',
      response_type: 'code',
      state: state,
      auth_type: 'rerequest'
    });

    return `https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`;
  }

  static async exchangeCodeForToken(code: string, callbackUrl: string): Promise<any> {
    const clientId = process.env.FACEBOOK_CLIENT_ID;
    const clientSecret = process.env.FACEBOOK_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Facebook OAuth credentials not configured');
    }

    try {
      const response = await axios.get(
        'https://graph.facebook.com/v18.0/oauth/access_token',
        {
          params: {
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: callbackUrl,
            code
          }
        }
      );

      return {
        accessToken: response.data.access_token,
        tokenType: response.data.token_type
      };
    } catch (error: any) {
      console.error('Facebook token exchange failed:', error.response?.data || error.message);
      throw new Error('Failed to exchange Facebook code for token');
    }
  }

  static async fetchUserPosts(accessToken: string): Promise<any[]> {
    try {
      const response = await axios.get('https://graph.facebook.com/me/posts', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          fields: 'id,message,created_time,permalink_url,story,type,likes.limit(1).summary(true),comments.limit(1).summary(true)',
          limit: 20
        }
      });

      const posts = response.data.data || [];

      return posts.map((post: any) => ({
        id: post.id,
        platform: 'facebook',
        author: 'You',
        content: post.message || post.story || '(Posted)',
        timestamp: new Date(post.created_time),
        likes: post.likes?.summary?.total_count || 0,
        comments: post.comments?.summary?.total_count || 0,
        sourceUrl: post.permalink_url,
        platformIcon: 'f',
        platformColor: '#1877F2',
        platformDisplayName: 'Facebook'
      }));
    } catch (error: any) {
      console.error('Failed to fetch Facebook posts:', error.message);
      return [];
    }
  }
}

// LINKEDIN
export class LinkedInOAuth {
  static getAuthUrl(deviceId: string, callbackUrl: string): string {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    if (!clientId) {
      throw new Error('LINKEDIN_CLIENT_ID not configured');
    }

    const state = Buffer.from(
      JSON.stringify({ deviceId, platform: 'linkedin' })
    ).toString('base64');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: callbackUrl,
      scope: 'r_basicprofile,r_liteprofile,w_member_social,r_member_social',
      state: state
    });

    return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
  }

  static async exchangeCodeForToken(code: string, callbackUrl: string): Promise<any> {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('LinkedIn OAuth credentials not configured');
    }

    try {
      const response = await axios.post(
        'https://www.linkedin.com/oauth/v2/accessToken',
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: callbackUrl,
          client_id: clientId,
          client_secret: clientSecret
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );

      return {
        accessToken: response.data.access_token,
        expiresIn: response.data.expires_in,
        tokenType: response.data.token_type
      };
    } catch (error: any) {
      console.error('LinkedIn token exchange failed:', error.response?.data || error.message);
      throw new Error('Failed to exchange LinkedIn code for token');
    }
  }

  static async fetchUserPosts(accessToken: string): Promise<any[]> {
    try {
      const response = await axios.get('https://api.linkedin.com/v2/me/posts', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      const posts = response.data.elements || [];

      return posts.map((post: any) => ({
        id: post.id,
        platform: 'linkedin',
        author: 'You',
        content: post.commentary || '(Posted)',
        timestamp: new Date(post.created?.time || Date.now()),
        sourceUrl: `https://www.linkedin.com/feed/update/${post.id}`,
        platformIcon: 'in',
        platformColor: '#0A66C2',
        platformDisplayName: 'LinkedIn'
      }));
    } catch (error: any) {
      console.error('Failed to fetch LinkedIn posts:', error.message);
      return [];
    }
  }
}

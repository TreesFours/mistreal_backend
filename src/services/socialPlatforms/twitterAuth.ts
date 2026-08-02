// Twitter/X OAuth Handler
import axios from 'axios';
import crypto from 'crypto';

const TWITTER_API_BASE = 'https://twitter.com/i/oauth2';
const TWITTER_API_V2 = 'https://api.twitter.com/2';

export class TwitterOAuth {
  static getAuthUrl(deviceId: string, callbackUrl: string): string {
    const clientId = process.env.TWITTER_CLIENT_ID;
    if (!clientId) {
      throw new Error('TWITTER_CLIENT_ID not configured');
    }

    const state = Buffer.from(
      JSON.stringify({ deviceId, platform: 'twitter' })
    ).toString('base64');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: callbackUrl,
      scope: 'tweet.read tweet.write users.read follows.read follows.write',
      state: state,
      code_challenge: this.generateCodeChallenge(),
      code_challenge_method: 'plain'
    });

    return `${TWITTER_API_BASE}/authorize?${params.toString()}`;
  }

  static async exchangeCodeForToken(code: string, callbackUrl: string): Promise<any> {
    const clientId = process.env.TWITTER_CLIENT_ID;
    const clientSecret = process.env.TWITTER_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Twitter OAuth credentials not configured');
    }

    try {
      const response = await axios.post(
        `${TWITTER_API_BASE}/token`,
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: callbackUrl,
          client_id: clientId,
          code_verifier: 'plain' // Using plain PKCE for simplicity
        },
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          auth: {
            username: clientId,
            password: clientSecret
          }
        }
      );

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
        tokenType: response.data.token_type
      };
    } catch (error: any) {
      console.error('Twitter token exchange failed:', error.response?.data || error.message);
      throw new Error('Failed to exchange Twitter code for token');
    }
  }

  static async fetchUserPosts(accessToken: string): Promise<any[]> {
    try {
      // Get authenticated user ID first
      const meResponse = await axios.get(`${TWITTER_API_V2}/users/me`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      const userId = meResponse.data.data.id;

      // Fetch user's tweets
      const tweetsResponse = await axios.get(
        `${TWITTER_API_V2}/users/${userId}/tweets`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            'tweet.fields': 'created_at,public_metrics,author_id',
            'user.fields': 'name,username',
            'expansions': 'author_id',
            'max_results': 10
          }
        }
      );

      const tweets = tweetsResponse.data.data || [];
      const users = tweetsResponse.data.includes?.users || [];

      return tweets.map((tweet: any) => {
        const author = users.find((u: any) => u.id === tweet.author_id);
        return {
          id: tweet.id,
          platform: 'twitter',
          author: author?.username || 'Unknown',
          content: tweet.text,
          timestamp: new Date(tweet.created_at),
          likes: tweet.public_metrics?.like_count || 0,
          retweets: tweet.public_metrics?.retweet_count || 0,
          replies: tweet.public_metrics?.reply_count || 0,
          sourceUrl: `https://twitter.com/${author?.username}/status/${tweet.id}`,
          platformIcon: '🐦',
          platformColor: '#1DA1F2',
          platformDisplayName: 'X (Twitter)'
        };
      });
    } catch (error: any) {
      console.error('Failed to fetch Twitter posts:', error.message);
      return [];
    }
  }

  private static generateCodeChallenge(): string {
    // For PKCE plain method, challenge = verifier
    return 'plain'; // Simple for now; in production, use proper PKCE
  }
}

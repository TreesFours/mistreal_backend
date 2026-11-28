import axios from 'axios';
import { isPlatformMatching } from '../../utils/platformId';

const ZERNIO_API_URL = 'https://zernio.com/api/v1'; // Official Base URL
const getApiKey = () => process.env.ZERNIO_API_KEY || '';

// Zernio's real Post/Message schemas only give a flat mediaUrls[] of strings —
// no per-attachment type field — so the image/video split socialService.ts
// renders from has to be guessed from the URL extension.
const guessAttachmentType = (url: string): 'image' | 'video' =>
  /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url) ? 'video' : 'image';

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
      const safeId = (deviceId || 'device_default').toString();
      const response = await axios.post(`${ZERNIO_API_URL}/profiles`, {
        name: `User ${safeId.slice(0, 6)}_${Math.random().toString(36).substring(2, 6)}`,
        description: `Mistreal Agent Profile for device ${safeId}`
      }, {
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });

      return response.data.profile._id; // The 24-char MongoDB ID
    } catch (error: any) {
      const status = error.response?.status;
      const data = error.response?.data;

      if (status === 402) {
        throw new Error('ZERNIO_PAYMENT_REQUIRED: Your Zernio account has reached its free profile limit or needs a valid payment method.');
      }

      // 🛡️ Graceful Recovery: If profile name already exists, reuse existingProfileId from Zernio response
      if (data?.code === 'profile_name_conflict' && data?.details?.existingProfileId) {
        console.info(`ℹ️ Zernio profile name conflict resolved. Reusing existing profileId: ${data.details.existingProfileId}`);
        return data.details.existingProfileId;
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
            redirect_url: callbackUrl
        },
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });

      // 🛡️ Double Check: Ensure Zernio isn't ignoring our redirect_uri
      return response.data.authUrl || response.data.url || response.data.redirect_url;
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
   * Fetch Inbox (DMs) — CONFIRMED against docs.zernio.com's OpenAPI spec:
   * there is no flat /inbox endpoint (that 404'd as endpoint_not_found in
   * production logs). The real shape is two-step: list conversations, then
   * pull each conversation's messages. A Message object carries no sender
   * name/id — only `direction` (inbound|outbound) — so the human identity
   * comes from the parent Conversation's `contactId`, resolved against the
   * CRM contacts list fetched once up front (one bulk call instead of one
   * name-lookup call per conversation, to stay well under the 60 req/min cap
   * the logs show Zernio enforcing).
   *
   * Deliberately returns each flattened message tagged with the
   * CONVERSATION's id (not the raw contactId) as its "author id" — that's
   * the id sendAction's Direct Message branch needs to reply into the same
   * thread via POST /inbox/conversations/{conversationId}/messages.
   */
  fetchInbox: async (profileId: string): Promise<{ available: boolean; items: any[] }> => {
    try {
      if (!profileId) throw new Error('Security Error: profileId is required for data isolation.');

      const [conversationsResp, contactsResult] = await Promise.all([
        axios.get(`${ZERNIO_API_URL}/inbox/conversations`, {
          params: { profileId, limit: 20 },
          headers: { 'Authorization': `Bearer ${getApiKey()}` }
        }),
        ZernioAdapter.fetchContacts(profileId)
      ]);

      const conversations = conversationsResp.data?.conversations || conversationsResp.data?.data || conversationsResp.data || [];
      if (!Array.isArray(conversations) || conversations.length === 0) return { available: true, items: [] };

      const contacts = contactsResult.items;
      const contactNameById = new Map<string, string>(
        contacts.map((c: any) => [c.id || c._id, c.name || c.username])
      );

      // Cap fan-out: one /messages request per conversation, most-recently-active first.
      const sorted = [...conversations].sort((a: any, b: any) =>
        new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime()
      ).slice(0, 15);

      const perConversation = await Promise.all(sorted.map(async (conv: any) => {
        try {
          const msgResp = await axios.get(`${ZERNIO_API_URL}/inbox/conversations/${conv.id}/messages`, {
            params: { limit: 20 },
            headers: { 'Authorization': `Bearer ${getApiKey()}` }
          });
          const messages = msgResp.data?.messages || msgResp.data?.data || msgResp.data || [];
          if (!Array.isArray(messages)) return [];
          const contactName = contactNameById.get(conv.contactId) || 'Social Contact';
          return messages.map((m: any) => ({
            _id: m.id,
            platform: m.platform || conv.platform,
            author: { id: conv.id, name: contactName },
            content: { text: m.text || '', attachments: (m.mediaUrls || []).map((url: string) => ({ url, type: guessAttachmentType(url) })) },
            createdAt: m.sentAt || conv.lastMessageAt,
            metadata: { direction: m.direction, zernioContactId: conv.contactId },
            type: 'message'
          }));
        } catch (perConvError: any) {
          console.error(`Zernio message fetch failed for conversation ${conv.id}: ${perConvError.message}`);
          return [];
        }
      }));

      return { available: true, items: perConversation.flat() };
    } catch (error: any) {
      console.error(`Zernio Inbox Error [${profileId}]:`, error.response?.data || error.message);
      return { available: false, items: [] };
    }
  },

  /**
   * Fetch Feed — CONFIRMED against docs.zernio.com's OpenAPI spec: there is
   * no /feed endpoint (also 404'd in production logs). GET /posts exists,
   * but it's Zernio's social-MANAGEMENT API — it returns posts WE published
   * through Zernio, not a pulled-in timeline of other accounts' content.
   * There's no author/likes/comments field in the real Post schema (we're
   * always the author); a post can fan out to multiple platforms at once
   * via its `platforms[]` array, so one Zernio post becomes one normalized
   * item per platform entry.
   */
  fetchFeed: async (profileId: string): Promise<{ available: boolean; items: any[] }> => {
    try {
      if (!profileId) throw new Error('profileId required');
      const response = await axios.get(`${ZERNIO_API_URL}/posts`, {
        params: { profileId, limit: 50 },
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });
      const posts = response.data?.posts || response.data?.data || response.data || [];
      if (!Array.isArray(posts)) return { available: true, items: [] };

      // One item per Zernio post, NOT one per platform it was published to —
      // a multi-platform post used to get exploded into N separate feed
      // items (and, downstream in socialService.ts, N separate persisted
      // SocialEvent rows) with no link between them. Zernio's own /posts
      // response already carries the full platforms[] array on the one
      // post object; merging here is the actual root-cause fix rather than
      // a display-layer patch, since the duplication started at this exact
      // explode-into-N loop.
      const items: any[] = [];
      for (const post of posts) {
        const platformEntries = Array.isArray(post.platforms) && post.platforms.length > 0
          ? post.platforms
          : [{ platform: 'unknown' }];
        const primary = platformEntries[0];
        items.push({
          _id: post.id,
          platform: primary.platform,
          author: { id: 'self', name: 'You' },
          content: { text: post.content || '', attachments: (post.mediaUrls || []).map((url: string) => ({ url, type: guessAttachmentType(url) })) },
          createdAt: post.publishedAt || post.createdAt,
          metadata: {
            sourceUrl: primary.publishedUrl || null,
            status: post.status,
            // Full per-platform detail preserved (not discarded) for any
            // consumer that wants it, and so the client can show a "+N"
            // indicator instead of silently only ever seeing the primary
            // platform this post went to.
            platforms: platformEntries.map((pe: any) => ({
              platform: pe.platform,
              publishedUrl: pe.publishedUrl || null,
              status: pe.status || post.status
            }))
          },
          type: 'post'
        });
      }
      return { available: true, items };
    } catch (error: any) {
      console.error(`Zernio Feed Error [${profileId}]:`, error.response?.data || error.message);
      return { available: false, items: [] };
    }
  },

  /**
   * Dispatch Content or Perform Actions (Like/Follow/Comment/DM/Post) — rebuilt
   * against the real endpoints confirmed via docs.zernio.com's OpenAPI spec.
   * The previous /actions, /messages, and /comments endpoints below don't
   * exist on Zernio's real API at all (same class of bug as /inbox and /feed).
   *
   * Known real limitation, surfaced honestly rather than silently swallowed:
   * follow/unfollow hits POST /inbox/contacts/{contactId}/follow, which needs
   * a Zernio CRM contactId — a post's author name (what the feed UI currently
   * passes as targetId for follow) is NOT a contactId, so following a post
   * author only works once that person already exists as a resolved contact
   * (e.g. they've DMed the connected account before). This degrades to a
   * clear error rather than a fake success.
   */
  sendAction: async (profileId: string, platform: string, content: string, type: string, targetId?: string, mediaUrl?: string, mediaUrls?: string[]) => {
    try {
      if (!profileId) throw new Error('Security Error: profileId is required for multi-tenant isolation.');

      const accountsResp = await axios.get(`${ZERNIO_API_URL}/accounts`, {
        params: { profileId },
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });
      const accounts = accountsResp.data?.accounts || accountsResp.data?.data || accountsResp.data || [];

      // Was a strict === — Zernio's /accounts response doesn't necessarily
      // spell a platform the same way the client does (casing, "x" vs
      // "twitter", etc.), while connection/reconciliation elsewhere already
      // normalizes before comparing. That mismatch meant an account could
      // show as connected (reconciliation tolerates it) while every post
      // failed here with "not linked to this profile."
      const account = accounts.find((a: any) => isPlatformMatching(a.platform || a.type || '', platform));
      if (!account) throw new Error(`${platform} not linked to this profile.`);
      const accountId = account.id || account.accountId || account._id;

      const lowerType = type.toLowerCase();

      if (lowerType === 'like' || lowerType === 'unlike') {
        if (!targetId) throw new Error('A postId is required to like/unlike.');
        const response = await axios.post(`${ZERNIO_API_URL}/posts/${targetId}/like`, {
          like: lowerType === 'like'
        }, { headers: { 'Authorization': `Bearer ${getApiKey()}` } });
        return response.data;
      }

      if (lowerType === 'follow' || lowerType === 'unfollow') {
        if (!targetId) throw new Error('A Zernio contactId is required to follow/unfollow.');
        const response = await axios.post(`${ZERNIO_API_URL}/inbox/contacts/${targetId}/follow`, {
          follow: lowerType === 'follow'
        }, { headers: { 'Authorization': `Bearer ${getApiKey()}` } });
        return response.data;
      }

      if (type === 'Direct Message') {
        // targetId here is the Zernio CONVERSATION id (see fetchInbox — it's
        // deliberately surfaced as the "author id" for exactly this purpose).
        if (!targetId) throw new Error('A conversationId is required to send a DM.');
        const effectiveMediaUrls = (mediaUrls && mediaUrls.length > 0) ? mediaUrls : (mediaUrl ? [mediaUrl] : undefined);
        const response = await axios.post(`${ZERNIO_API_URL}/inbox/conversations/${targetId}/messages`, {
          text: content,
          mediaUrls: effectiveMediaUrls
        }, { headers: { 'Authorization': `Bearer ${getApiKey()}` } });
        return response.data;
      }

      if (lowerType === 'delete message' || lowerType === 'delete_message' || lowerType === 'delete') {
        if (!targetId) throw new Error('A messageId is required to delete a message.');
        const response = await axios.delete(`${ZERNIO_API_URL}/inbox/messages/${targetId}`, {
          headers: { 'Authorization': `Bearer ${getApiKey()}` }
        });
        return response.data;
      }

      if (lowerType === 'comment') {
        if (!targetId) throw new Error('A postId is required to comment.');
        const response = await axios.post(`${ZERNIO_API_URL}/posts/${targetId}/comment`, {
          text: content,
          accountId
        }, { headers: { 'Authorization': `Bearer ${getApiKey()}` } });
        return response.data;
      }

      // Default: create/publish a post (Tweet, FB Post, etc). Confirmed body
      // shape has no story/status flag — that's not a verified capability of
      // this endpoint, so it's not attempted here rather than guessed at.
      // mediaUrls fallback mirrors the Direct Message branch above — this
      // used to build from mediaUrl alone, silently dropping every
      // attachment past the first whenever a caller passed the mediaUrls
      // array (which the function signature already accepted).
      const effectivePostMediaUrls = (mediaUrls && mediaUrls.length > 0) ? mediaUrls : (mediaUrl ? [mediaUrl] : undefined);
      const postData: any = {
        content,
        publishNow: true,
        platforms: [{ platform, accountId }],
        mediaUrls: effectivePostMediaUrls
      };

      const response = await axios.post(`${ZERNIO_API_URL}/posts`, postData, {
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });

      return response.data;
    } catch (error: any) {
      console.error(`Zernio Dispatch Error [${platform}/${type}]:`, error.response?.data || error.message);
      throw new Error(`Social action failed: ${error.response?.data?.error || error.message}`);
    }
  },

  /**
   * Publishes ONE post across multiple platforms at once — confirmed
   * against zernio.com's real OpenAPI spec that `platforms` already accepts
   * more than one {platform, accountId} entry in a single call ("this
   * single call publishes or schedules the post to every account in
   * platforms, across any platform"), and that the response carries one
   * unified top-level post id usable later for GET/comment regardless of
   * how many platforms it went to. `sendAction`'s default branch above
   * never exercised that — it always built a one-entry array. This is the
   * piece that lets Mistreal keep ONE post record instead of one per
   * platform (see Post model).
   */
  publishMultiPlatformPost: async (profileId: string, content: string, platforms: string[], mediaUrl?: string, mediaUrls?: string[]) => {
    try {
      if (!profileId) throw new Error('Security Error: profileId is required for multi-tenant isolation.');
      if (!platforms || platforms.length === 0) throw new Error('At least one platform is required.');

      const accountsResp = await axios.get(`${ZERNIO_API_URL}/accounts`, {
        params: { profileId },
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });
      const accounts = accountsResp.data?.accounts || accountsResp.data?.data || accountsResp.data || [];

      const targets: { platform: string; accountId: string }[] = [];
      const unlinked: string[] = [];
      for (const platform of platforms) {
        const account = accounts.find((a: any) => isPlatformMatching(a.platform || a.type || '', platform));
        if (account) {
          targets.push({ platform, accountId: account.id || account.accountId || account._id });
        } else {
          unlinked.push(platform);
        }
      }
      if (targets.length === 0) {
        throw new Error(`None of the requested platforms are linked to this profile: ${unlinked.join(', ')}`);
      }

      const postData: any = {
        content,
        publishNow: true,
        platforms: targets,
        mediaUrls: (mediaUrls && mediaUrls.length > 0) ? mediaUrls : (mediaUrl ? [mediaUrl] : undefined)
      };

      const response = await axios.post(`${ZERNIO_API_URL}/posts`, postData, {
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });

      // unlinked is surfaced rather than silently dropped — a post that was
      // supposed to go to 3 platforms but only 2 are actually connected
      // should say so, not just quietly publish to fewer than asked.
      return { ...response.data, unlinkedPlatforms: unlinked };
    } catch (error: any) {
      console.error('Zernio multi-platform publish error:', error.response?.data || error.message);
      throw new Error(`Multi-platform post failed: ${error.response?.data?.error || error.message}`);
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
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });

      // Zernio sometimes returns data in 'pages', 'elements', or 'accounts' depending on the platform
      const pages = listResp.data.pages || listResp.data.elements || listResp.data.accounts || [];
      if (pages.length === 0) {
          console.warn(`⚠️ No sub-accounts found for ${platform}. User might need to create a page/profile first.`);
          return { success: false, error: 'NO_ACCOUNTS_FOUND' };
      }

      // 2. Select the first one automatically (Strategy: Direct Link)
      const selectedAccount = pages[0];
      const accountId = selectedAccount.id || selectedAccount.accountId || selectedAccount._id || selectedAccount.username;

      const baseUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
      const selectResp = await axios.post(`${ZERNIO_API_URL}/connect/${platform}/select`, {
        profileId,
        tempToken,
        accountId,
        userProfile: userProfile ? JSON.parse(decodeURIComponent(userProfile)) : undefined,
        redirect_url: `${baseUrl}/api/social/callback/success`
      }, {
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
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
  },

  /**
   * Search for new contacts on a platform
   */
  searchPlatform: async (profileId: string, platform: string, query: string): Promise<{ available: boolean; items: any[] }> => {
    try {
      // Note: Zernio doesn't have a single "search" for all platforms,
      // but many platform connectors support it.
      const response = await axios.get(`${ZERNIO_API_URL}/contacts/search`, {
        params: { profileId, platform, q: query },
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });
      return { available: true, items: response.data.contacts || [] };
    } catch (e: any) {
      console.warn(`Search failed for ${platform}: ${e.message}`);
      return { available: false, items: [] };
    }
  },

  /**
   * Fetch absolute contact list for a profile/platform
   */
  fetchContacts: async (profileId: string, platform?: string): Promise<{ available: boolean; items: any[] }> => {
    try {
      const response = await axios.get(`${ZERNIO_API_URL}/contacts`, {
        params: { profileId, platform },
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });
      return { available: true, items: response.data.contacts || [] };
    } catch (e: any) {
      console.error(`Zernio Contacts Fetch Error: ${e.message}`);
      return { available: false, items: [] };
    }
  },

  /**
   * Fetch connected accounts for a Zernio Profile
   * Verifies which platforms are actually linked and active.
   */
  fetchAccounts: async (profileId: string): Promise<{ available: boolean; items: any[] }> => {
    try {
      if (!profileId) return { available: true, items: [] };
      const response = await axios.get(`${ZERNIO_API_URL}/accounts`, {
        params: { profileId },
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });
      return { available: true, items: response.data.accounts || response.data.data || [] };
    } catch (e: any) {
      console.error(`Zernio Accounts Fetch Error [${profileId}]:`, e.response?.data || e.message);
      return { available: false, items: [] };
    }
  },

  /**
   * Follower/friend/like counts for a connected account — UNCONFIRMED
   * endpoint. Zernio's analytics docs page references
   * `/v1/accounts/follower-stats` for exactly this, but that endpoint's own
   * docs page 404'd on direct fetch and it isn't listed in the main nav —
   * plausible, not verified. Attempted the same defensive way every other
   * call in this file already is: try the real call, and on ANY failure
   * (404, wrong shape, auth error) return `{ available: false }` rather
   * than a fake zero presented as real data. Never let the profile screen
   * depend on this succeeding.
   */
  fetchFollowerStats: async (profileId: string, accountId: string): Promise<{ available: boolean; followers?: number; friends?: number; likes?: number }> => {
    try {
      if (!profileId || !accountId) return { available: false };
      const response = await axios.get(`${ZERNIO_API_URL}/accounts/follower-stats`, {
        params: { profileId, accountId },
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });
      const data = response.data?.stats || response.data?.data || response.data;
      if (!data || typeof data !== 'object') return { available: false };
      return {
        available: true,
        followers: typeof data.followers === 'number' ? data.followers : undefined,
        friends: typeof data.friends === 'number' ? data.friends : undefined,
        likes: typeof data.likes === 'number' ? data.likes : undefined
      };
    } catch (e: any) {
      console.warn(`Zernio follower-stats unavailable [${accountId}]: ${e.response?.status || e.message}`);
      return { available: false };
    }
  },

  /**
   * Register (or confirm) our webhook subscription with Zernio — confirmed
   * real endpoints via docs.zernio.com's OpenAPI spec: POST/GET /webhooks.
   * The receiver side (webhookRoutes.ts / WebhookService) already existed
   * and handles ~25 event cases, but nothing ever told Zernio to actually
   * send events there — this was the other half of that gap. Idempotent:
   * skips creation if a webhook already exists for our callback URL, so
   * this is safe to call on every server boot.
   */
  ensureWebhookRegistered: async (events: string[]) => {
    const appUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
    const callbackUrl = `${appUrl}/api/webhook/zernio`;
    const secret = process.env.ZERNIO_WEBHOOK_SECRET;
    if (!secret) {
      console.warn('⚠️ ZERNIO_WEBHOOK_SECRET not set — skipping webhook registration (fail-safe, not fatal).');
      return;
    }
    try {
      const listResp = await axios.get(`${ZERNIO_API_URL}/webhooks`, {
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });
      const existing = (listResp.data?.webhooks || listResp.data?.data || listResp.data || [])
        .find((w: any) => w.url === callbackUrl || w.endpoint === callbackUrl);

      if (existing) {
        console.info(`✅ Zernio webhook already registered for ${callbackUrl} (id ${existing.id}).`);
        return;
      }

      const response = await axios.post(`${ZERNIO_API_URL}/webhooks`, {
        url: callbackUrl,
        events,
        secret
      }, { headers: { 'Authorization': `Bearer ${getApiKey()}` } });
      console.info(`✅ Zernio webhook registered for ${callbackUrl} (${events.length} event types).`);
      return response.data;
    } catch (error: any) {
      // Fail-safe by design — a registration failure must never block server
      // startup or any unrelated functionality.
      console.error(`⚠️ Zernio webhook registration skipped: ${error.response?.data?.error || error.message}`);
    }
  },

  /**
   * Unlink/Delete an account from a Zernio Profile
   */
  deleteAccount: async (profileId: string, accountId: string) => {
    try {
      if (!profileId || !accountId) throw new Error('profileId and accountId are required for deletion.');
      const response = await axios.delete(`${ZERNIO_API_URL}/accounts/${accountId}`, {
        params: { profileId },
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });
      return response.data;
    } catch (e: any) {
      console.error(`Zernio Delete Account Error [${accountId}]:`, e.response?.data || e.message);
      throw new Error(`Failed to delete account from Zernio: ${e.response?.data?.error || e.message}`);
    }
  },

  // ============================================================
  // ZERNIO ADS API — confirmed real in a prior session against their
  // public OpenAPI spec/pricing page (base /v1/ads, real campaign CRUD
  // across Meta/Google/TikTok/LinkedIn/Pinterest/X/OpenAI/Reddit/Microsoft
  // Ads), but NOT re-verified against a live spec fetch in THIS session —
  // same lower-confidence tier as the ElevenLabs integration, not the
  // same tier as every endpoint above this point in the file (each of
  // which has its own "CONFIRMED" annotation from being checked directly).
  // Two prerequisites beyond a normal connected social profile, neither
  // verifiable from this codebase: (1) a separately connected AD account
  // per platform via getAdsConnectAuthUrl below, (2) Zernio's own "Ads
  // add-on" enabled on this workspace — every call below 403s with
  // ads_addon_required otherwise, surfaced verbatim rather than swallowed.
  // ============================================================

  /**
   * Ad-account connection — mirrors getAuthUrl's exact /connect/{platform}
   * shape above, with an accountType=ads param to request an AD account
   * grant instead of a normal profile connection. The accountType param
   * name/value is an assumption (not re-confirmed this session); if Zernio
   * rejects it, check their real /connect query param names directly.
   */
  getAdsConnectAuthUrl: async (platform: string, profileId: string, state?: string, customRedirectUrl?: string) => {
    try {
      const baseUrl = process.env.APP_URL || 'https://mistreal-backend.onrender.com';
      const callbackUrl = customRedirectUrl || `${baseUrl}/api/ad-campaigns/callback`;

      const response = await axios.get(`${ZERNIO_API_URL}/connect/${encodeURIComponent(platform)}`, {
        params: { profileId, accountType: 'ads', state, redirect_url: callbackUrl },
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });
      return response.data.authUrl || response.data.url || response.data.redirect_url;
    } catch (error: any) {
      const status = error.response?.status;
      const data = error.response?.data;
      if (data?.error === 'ads_addon_required' || status === 403) {
        throw new Error('ADS_ADDON_REQUIRED: Enable the Ads add-on on this Zernio workspace before connecting an ad account.');
      }
      console.error(`Zernio Ads Connect Error [${platform}]:`, data || error.message);
      throw new Error(`Ads connection error (${status}): ${data?.error || error.message}`);
    }
  },

  createAdCampaign: async (adAccountId: string, campaign: Record<string, any>) => {
    try {
      const response = await axios.post(`${ZERNIO_API_URL}/ads`, { adAccountId, ...campaign }, {
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });
      return response.data;
    } catch (error: any) {
      const data = error.response?.data;
      if (data?.error === 'ads_addon_required') throw new Error('ADS_ADDON_REQUIRED: Enable the Ads add-on on this Zernio workspace first.');
      console.error('Zernio Create Campaign Error:', data || error.message);
      throw new Error(`Failed to create ad campaign: ${data?.error || error.message}`);
    }
  },

  updateAdCampaign: async (campaignId: string, updates: Record<string, any>) => {
    try {
      const response = await axios.put(`${ZERNIO_API_URL}/ads/${campaignId}`, updates, {
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });
      return response.data;
    } catch (error: any) {
      const data = error.response?.data;
      if (data?.error === 'ads_addon_required') throw new Error('ADS_ADDON_REQUIRED: Enable the Ads add-on on this Zernio workspace first.');
      console.error(`Zernio Update Campaign Error [${campaignId}]:`, data || error.message);
      throw new Error(`Failed to update ad campaign: ${data?.error || error.message}`);
    }
  },

  deleteAdCampaign: async (campaignId: string) => {
    try {
      const response = await axios.delete(`${ZERNIO_API_URL}/ads/${campaignId}`, {
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });
      return response.data;
    } catch (error: any) {
      const data = error.response?.data;
      console.error(`Zernio Delete Campaign Error [${campaignId}]:`, data || error.message);
      throw new Error(`Failed to delete ad campaign: ${data?.error || error.message}`);
    }
  },

  listAdCampaigns: async (adAccountId: string) => {
    try {
      const response = await axios.get(`${ZERNIO_API_URL}/ads`, {
        params: { adAccountId },
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });
      return response.data?.campaigns || response.data?.data || response.data || [];
    } catch (error: any) {
      const data = error.response?.data;
      if (data?.error === 'ads_addon_required') throw new Error('ADS_ADDON_REQUIRED: Enable the Ads add-on on this Zernio workspace first.');
      console.error('Zernio List Campaigns Error:', data || error.message);
      throw new Error(`Failed to list ad campaigns: ${data?.error || error.message}`);
    }
  },

  getAdCampaignAnalytics: async (campaignId: string) => {
    try {
      const response = await axios.get(`${ZERNIO_API_URL}/ads/${campaignId}/analytics`, {
        headers: { 'Authorization': `Bearer ${getApiKey()}` }
      });
      return response.data;
    } catch (error: any) {
      const data = error.response?.data;
      console.error(`Zernio Campaign Analytics Error [${campaignId}]:`, data || error.message);
      throw new Error(`Failed to load campaign analytics: ${data?.error || error.message}`);
    }
  }
};

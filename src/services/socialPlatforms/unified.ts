// backend/src/services/socialPlatforms/unified.ts
// Truly Dynamic Social Orchestrator

import { getSocialSummary } from '../socialService';

export class UnifiedSocialService {
  /**
   * Professional Sync Orchestrator
   * Fetches from all connected platforms for the user
   */
  static async syncAllPlatforms(user: any): Promise<any> {
    if (!user.connectedPlatforms || user.connectedPlatforms.length === 0) {
        return {
            summary: "No connected platforms. Go to Settings to connect.",
            platformUpdates: [],
            posts: [],
            platformStatus: {},
            rawContent: ""
        };
    }

    return await getSocialSummary(user, user.isPro);
  }
}

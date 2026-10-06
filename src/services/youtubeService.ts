import axios from 'axios';
import { CachedYoutubeVideo } from '../models/youtubeVideoModel';
import logger from '../utils/logger';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

// A handful of curated queries, not user-driven search — search.list costs
// 100 quota units per call against a ~10,000/day default quota, so this list
// stays short and the refresh cadence stays long (see index.ts's worker).
const CURATED_QUERIES = ['technology news', 'science explained', 'world travel', 'cooking recipes'];

export const refreshCuratedVideos = async () => {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return; // fail-safe — feature just stays empty, never crashes anything

    for (const query of CURATED_QUERIES) {
        try {
            const searchResponse = await axios.get(`${YOUTUBE_API_BASE}/search`, {
                params: {
                    part: 'snippet',
                    q: query,
                    type: 'video',
                    maxResults: 5,
                    key: apiKey
                }
            });

            const videoIds = (searchResponse.data?.items || [])
                .map((item: any) => item.id?.videoId)
                .filter(Boolean);
            if (videoIds.length === 0) continue;

            // videos.list with part=statistics costs only 1 unit — cheap,
            // worth the extra call to get real view/like counts.
            const statsResponse = await axios.get(`${YOUTUBE_API_BASE}/videos`, {
                params: { part: 'snippet,statistics', id: videoIds.join(','), key: apiKey }
            });

            for (const item of statsResponse.data?.items || []) {
                await CachedYoutubeVideo.upsert({
                    videoId: item.id,
                    title: item.snippet?.title || 'Untitled',
                    thumbnailUrl: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url,
                    channelTitle: item.snippet?.channelTitle,
                    publishedAt: item.snippet?.publishedAt,
                    viewCount: item.statistics?.viewCount ? Number(item.statistics.viewCount) : null,
                    likeCount: item.statistics?.likeCount ? Number(item.statistics.likeCount) : null,
                    queryTag: query
                });
            }
            logger.info(`🎬 [YouTube] Cached ${videoIds.length} videos for query "${query}"`);
        } catch (e: any) {
            logger.warn(`⚠️ [YouTube] Refresh failed for query "${query}": ${e.response?.data?.error?.message || e.message}`);
        }
    }
};

export const getCachedVideos = async (limit: number = 20) => {
    return await CachedYoutubeVideo.findAll({
        order: [['publishedAt', 'DESC']],
        limit
    });
};

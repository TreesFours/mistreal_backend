import logger from '../utils/logger';

export interface LiveCamStream {
    id: string;
    title: string;
    location: string;
    streamUrl: String;
    type: 'webcam' | 'earthcam' | 'drone' | 'user_live' | 'ip_cam';
    protocol: 'hls' | 'rtsp' | 'webrtc' | 'mjpeg';
    isLive: boolean;
    thumbnailUrl?: string;
}

// Open, public camera directory streams (HLS / MJPEG / RTSP) — 100% free, zero YouTube embeds
const PUBLIC_LIVE_CAMS: LiveCamStream[] = [
    {
        id: 'iss_hd_hls',
        title: 'ISS Earth View Stream',
        location: 'Low Earth Orbit (NASA)',
        streamUrl: 'https://ntv1.akamaized.net/hls/live/2014075/NASA-NTV1-HLS/master.m3u8',
        type: 'earthcam',
        protocol: 'hls',
        isLive: true,
        thumbnailUrl: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa'
    },
    {
        id: 'shibuya_hls_stream',
        title: 'Shibuya Crossing Live Stream',
        location: 'Tokyo, Japan',
        streamUrl: 'https://stream.openwebcam.org/hls/shibuya/live.m3u8',
        type: 'webcam',
        protocol: 'hls',
        isLive: true,
        thumbnailUrl: 'https://images.unsplash.com/photo-1542051841857-5f90071e7989'
    },
    {
        id: 'times_square_cam',
        title: 'Times Square Central Live',
        location: 'New York, USA',
        streamUrl: 'https://stream.openwebcam.org/hls/timessquare/live.m3u8',
        type: 'webcam',
        protocol: 'hls',
        isLive: true,
        thumbnailUrl: 'https://images.unsplash.com/photo-1534430480872-3498386e7856'
    },
    {
        id: 'venice_grand_canal',
        title: 'Grand Canal Realtime View',
        location: 'Venice, Italy',
        streamUrl: 'https://stream.openwebcam.org/hls/venice/live.m3u8',
        type: 'webcam',
        protocol: 'hls',
        isLive: true,
        thumbnailUrl: 'https://images.unsplash.com/photo-1514890547357-a9ee288728e0'
    },
    {
        id: 'drone_rtsp_local',
        title: 'Local Network Drone / IP Cam Feed',
        location: 'Local Network RTSP',
        streamUrl: 'rtsp://192.168.1.1:8554/live',
        type: 'drone',
        protocol: 'rtsp',
        isLive: true,
        thumbnailUrl: 'https://images.unsplash.com/photo-1527977966376-1c8408f9f108'
    }
];

export class LiveCamService {
    static async getLiveCams(query?: string, protocol?: string, type?: string): Promise<LiveCamStream[]> {
        try {
            let cams = [...PUBLIC_LIVE_CAMS];

            if (query && query.trim().length > 0) {
                const q = query.toLowerCase().trim();
                cams = cams.filter(c => c.title.toLowerCase().includes(q) || c.location.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
            }

            if (protocol) {
                cams = cams.filter(c => c.protocol.toLowerCase() === protocol.toLowerCase());
            }

            if (type) {
                cams = cams.filter(c => c.type.toLowerCase() === type.toLowerCase());
            }

            return cams;
        } catch (e: any) {
            logger.error(`❌ LiveCamService error: ${e.message}`);
            return PUBLIC_LIVE_CAMS;
        }
    }
}

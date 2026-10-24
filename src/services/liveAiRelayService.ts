import WebSocket from 'ws';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { checkDomainRateLimit } from '../utils/domainRateLimiter';
import logger from '../utils/logger';

/**
 * Relays a live, real-time voice+video conversation with Gemini — the
 * backend-routed alternative to calling Firebase AI Logic directly from
 * the client (that path was tried first and reverted: it needs a Firebase
 * BOM new enough to require a newer Kotlin compiler than this project
 * uses). This keeps GEMINI_API_KEY server-side like every other AI feature
 * here, and makes the existing abuse-valve (checkDomainRateLimit) apply to
 * Live AI too — direct-to-Firebase would have bypassed it entirely.
 *
 * One Google WebSocket per connected client socket — protocol confirmed
 * directly against Google's own reference (ai.google.dev/api/live), not
 * guessed: setup message first, then a continuous stream of realtimeInput
 * audio/video chunks, with Gemini's spoken replies arriving as
 * serverContent.modelTurn.parts[].inlineData chunks.
 *
 * GEMINI_LIVE_MODEL is env-configurable rather than hardcoded — the exact
 * model identifier for this raw (non-Firebase) endpoint was never confirmed
 * against a source that documents this specific surface, only inferred
 * from Firebase AI Logic's own model list, which may not match. A wrong
 * guess here should be a one-line env change, not a code change.
 */
const GOOGLE_LIVE_WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'models/gemini-2.0-flash-exp';

type Ack = ((response: { success: boolean; [key: string]: any }) => void) | undefined;

export const registerLiveAiRelay = (io: SocketIOServer): void => {
    const liveAi = io.of('/live-ai');

    liveAi.on('connection', (socket: Socket) => {
        let googleWs: WebSocket | null = null;

        socket.on('session:start', (payload: { deviceId?: string }, ack: Ack) => {
            const limitError = checkDomainRateLimit(payload?.deviceId);
            if (limitError) return ack?.({ success: false, error: limitError });

            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) return ack?.({ success: false, error: 'Live AI is not configured.' });

            if (googleWs) {
                googleWs.close();
                googleWs = null;
            }

            // If the Google socket fails before ever opening, 'open' never
            // fires and 'error' is what the ws lib delivers instead — track
            // whether ack has already run so the client's startSession()
            // always resolves exactly once, success or failure, rather than
            // hanging forever on a connection that never opened.
            let acked = false;
            const safeAck = (response: { success: boolean; [key: string]: any }) => {
                if (acked) return;
                acked = true;
                ack?.(response);
            };
            let hasOpened = false;

            try {
                const ws = new WebSocket(`${GOOGLE_LIVE_WS_URL}?key=${apiKey}`);
                googleWs = ws;

                ws.on('open', () => {
                    hasOpened = true;
                    ws.send(JSON.stringify({
                        setup: {
                            model: GEMINI_LIVE_MODEL,
                            generationConfig: { responseModalities: ['AUDIO'] }
                        }
                    }));
                    logger.info(`🎙️ [LIVE AI] Session started for device ${payload?.deviceId || 'unknown'}`);
                    safeAck({ success: true });
                });

                ws.on('message', (raw: WebSocket.RawData) => {
                    try {
                        const msg = JSON.parse(raw.toString());
                        const parts = msg?.serverContent?.modelTurn?.parts;
                        if (Array.isArray(parts)) {
                            for (const part of parts) {
                                const inline = part?.inlineData;
                                if (inline?.data) {
                                    socket.emit('audio:chunk', { data: inline.data, mimeType: inline.mimeType });
                                }
                            }
                        }
                        if (msg?.serverContent?.turnComplete) {
                            socket.emit('turn:complete', {});
                        }
                    } catch (e: any) {
                        logger.error(`❌ [LIVE AI] Failed to parse Gemini message: ${e.message}`);
                    }
                });

                ws.on('error', (err: Error) => {
                    logger.error(`❌ [LIVE AI] Google WebSocket error: ${err.message}`);
                    socket.emit('session:error', { error: err.message });
                    safeAck({ success: false, error: err.message });
                });

                ws.on('close', () => {
                    // Only a genuine end-of-session if it actually opened —
                    // otherwise 'error' above already told the client what
                    // happened, and this would just overwrite that with a
                    // misleading plain "ended".
                    if (hasOpened) socket.emit('session:ended', {});
                    if (googleWs === ws) googleWs = null;
                });
            } catch (e: any) {
                logger.error(`❌ [LIVE AI] Failed to open Google WebSocket: ${e.message}`);
                safeAck({ success: false, error: e.message });
            }
        });

        // Pure forwarding — the server never inspects audio/video content,
        // same "just relay it" posture as watchSignalingService.ts/
        // callSignalingService.ts, just to Google instead of another peer.
        socket.on('audio:chunk', (payload: { data: string }) => {
            if (!googleWs || googleWs.readyState !== WebSocket.OPEN || !payload?.data) return;
            googleWs.send(JSON.stringify({
                realtimeInput: { audio: { data: payload.data, mimeType: 'audio/pcm;rate=16000' } }
            }));
        });

        socket.on('video:frame', (payload: { data: string }) => {
            if (!googleWs || googleWs.readyState !== WebSocket.OPEN || !payload?.data) return;
            googleWs.send(JSON.stringify({
                realtimeInput: { video: { data: payload.data, mimeType: 'image/jpeg' } }
            }));
        });

        const endSession = () => {
            googleWs?.close();
            googleWs = null;
        };
        socket.on('session:end', endSession);
        socket.on('disconnect', endSession);
    });
};

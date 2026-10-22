import crypto from 'crypto';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { WatchSession } from '../models/WatchSession';
import logger from '../utils/logger';

/**
 * Pure signaling relay for the Watch Hub (live screencast/share) feature —
 * this server never sees video/audio, only session bookkeeping and the
 * offer/answer/ICE messages two WebRTC peers need to find each other.
 * Everything here is in-memory + ephemeral by design: a server restart
 * just means every live session has to be restarted by its host, which is
 * fine since the WatchSession DB row only exists for discovery (the Market/
 * Meetup UI showing "live now"), not as a source of truth the stream
 * depends on.
 */
const sessionIdToHostSocketId = new Map<string, string>();

const genSessionId = (): string => crypto.randomBytes(8).toString('hex');

type Ack = ((response: { success: boolean; [key: string]: any }) => void) | undefined;

export const registerWatchSignaling = (io: SocketIOServer): void => {
    const watch = io.of('/watch');

    watch.on('connection', (socket: Socket) => {
        logger.info(`📡 [WATCH] Socket connected: ${socket.id}`);

        socket.on('host:start', async (payload: { deviceId: string; contextType?: string; contextId?: string }, ack: Ack) => {
            try {
                const sessionId = genSessionId();
                await WatchSession.create({
                    id: sessionId,
                    hostDeviceId: payload.deviceId,
                    contextType: payload.contextType || 'standalone',
                    contextId: payload.contextId || null,
                    status: 'live'
                });
                sessionIdToHostSocketId.set(sessionId, socket.id);
                socket.join(`session:${sessionId}`);
                socket.data.sessionId = sessionId;
                socket.data.isHost = true;
                ack?.({ success: true, sessionId });
                logger.info(`📡 [WATCH] Host ${payload.deviceId} started session ${sessionId}`);
            } catch (error: any) {
                logger.error(`❌ [WATCH] host:start failed for device ${payload.deviceId}: ${error.message}`);
                ack?.({ success: false, error: error.message });
            }
        });

        socket.on('viewer:join', async (payload: { sessionId: string; deviceId: string }, ack: Ack) => {
            try {
                const session = await WatchSession.findOne({ where: { id: payload.sessionId, status: 'live' } });
                if (!session) {
                    logger.warn(`⚠️ [WATCH] viewer:join rejected — session ${payload.sessionId} not found/ended (device ${payload.deviceId})`);
                    return ack?.({ success: false, error: 'Session not found or has ended' });
                }

                const hostSocketId = sessionIdToHostSocketId.get(payload.sessionId);
                if (!hostSocketId) {
                    logger.warn(`⚠️ [WATCH] viewer:join rejected — host not connected for session ${payload.sessionId} (device ${payload.deviceId})`);
                    return ack?.({ success: false, error: 'Host is not currently connected' });
                }

                socket.join(`session:${payload.sessionId}`);
                socket.data.sessionId = payload.sessionId;
                socket.data.isHost = false;
                ack?.({ success: true });
                logger.info(`📡 [WATCH] Viewer ${payload.deviceId} joined session ${payload.sessionId}`);

                // Tells the host "this viewer wants in" — the host creates a
                // new PeerConnection for them and sends an offer back via
                // signal:offer addressed to viewerSocketId.
                watch.to(hostSocketId).emit('viewer:joined', {
                    sessionId: payload.sessionId,
                    viewerDeviceId: payload.deviceId,
                    viewerSocketId: socket.id
                });
            } catch (error: any) {
                logger.error(`❌ [WATCH] viewer:join threw for session ${payload.sessionId}: ${error.message}`);
                ack?.({ success: false, error: error.message });
            }
        });

        // Pure relay — the server never inspects sdp/candidate content,
        // just forwards it to the specific socket the sender named, but only
        // if that target is actually in the same session room as the sender
        // (otherwise a client could name an arbitrary socket id and inject
        // signaling into a negotiation it isn't part of).
        const relay = (event: string) => (payload: { toSocketId: string;[key: string]: any }) => {
            const sessionId = socket.data.sessionId as string | undefined;
            if (!sessionId) {
                logger.warn(`⚠️ [WATCH] Dropped ${event} from ${socket.id} — sender has no active session`);
                return;
            }
            const targetSocket = watch.sockets.get(payload.toSocketId);
            if (!targetSocket || !targetSocket.rooms.has(`session:${sessionId}`)) {
                logger.warn(`⚠️ [WATCH] Dropped ${event} from ${socket.id} — target ${payload.toSocketId} not in session:${sessionId}`);
                return;
            }
            watch.to(payload.toSocketId).emit(event, { ...payload, fromSocketId: socket.id });
        };
        socket.on('signal:offer', relay('signal:offer'));
        socket.on('signal:answer', relay('signal:answer'));
        socket.on('signal:ice', relay('signal:ice'));
        socket.on('viewer:rejected', relay('viewer:rejected'));

        socket.on('host:stop', async (payload: { sessionId: string }) => {
            if (sessionIdToHostSocketId.get(payload.sessionId) !== socket.id) {
                logger.warn(`⚠️ [WATCH] Rejected host:stop from ${socket.id} — not the host of session ${payload.sessionId}`);
                return;
            }
            logger.info(`📡 [WATCH] Host stopped session ${payload.sessionId}`);
            await endSession(payload.sessionId, watch);
        });

        socket.on('disconnect', async () => {
            const sessionId = socket.data.sessionId as string | undefined;
            logger.info(`📡 [WATCH] Socket disconnected: ${socket.id}${sessionId ? ` (session ${sessionId}, host=${!!socket.data.isHost})` : ''}`);
            if (!sessionId) return;
            if (socket.data.isHost) {
                await endSession(sessionId, watch);
            } else {
                watch.to(`session:${sessionId}`).emit('viewer:left', { sessionId, viewerSocketId: socket.id });
            }
        });
    });
};

const endSession = async (sessionId: string, watch: ReturnType<SocketIOServer['of']>): Promise<void> => {
    sessionIdToHostSocketId.delete(sessionId);
    watch.to(`session:${sessionId}`).emit('host:stopped', { sessionId });
    try {
        await WatchSession.update({ status: 'ended', endedAt: new Date() }, { where: { id: sessionId, status: 'live' } });
    } catch (error: any) {
        logger.error(`❌ [WATCH] Failed to mark session ${sessionId} ended: ${error.message}`);
    }
};

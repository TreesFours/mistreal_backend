import crypto from 'crypto';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { sendPushToDevice } from '../utils/push';
import logger from '../utils/logger';

/**
 * Signaling for 1:1 in-app video/audio calls between two Mistreal users —
 * the symmetric counterpart to watchSignalingService.ts's host/N-viewer
 * broadcast (that one has an inherent host/viewer asymmetry; a call has
 * neither side privileged). Same "the server never sees media, only
 * bookkeeping + offer/answer/ICE" design, and the same room-membership
 * check on every relay that watchSignalingService.ts needed fixing to add
 * (a client naming an arbitrary target socket must never be enough to
 * reach it) — baked in from the start here instead.
 *
 * Reachability: a callee already connected to this namespace gets
 * call:incoming immediately; regardless, an FCM push also fires (see
 * push.ts) since "connected to this socket right now" can't be assumed —
 * that's the whole reason this file exists instead of just extending Watch
 * Hub's signaling.
 */
const deviceIdToSocketId = new Map<string, string>();

type CallState = {
    callerDeviceId: string;
    calleeDeviceId: string;
    status: 'ringing' | 'active';
    createdAt: number;
};
const activeCalls = new Map<string, CallState>();

// The client already gives up on an unanswered call after 45s
// (CallService.RING_TIMEOUT_MS) and sends call:hangup, which cleans this
// map up normally — this sweep only exists for the case that never
// reaches, e.g. the caller's app/process dying before its own timeout
// fires. Generous margin past the client timeout since this is just a
// memory-leak backstop, not something that needs to be tight.
const STALE_RINGING_MS = 90_000;
setInterval(() => {
    const now = Date.now();
    for (const [callId, state] of activeCalls) {
        if (state.status === 'ringing' && now - state.createdAt > STALE_RINGING_MS) {
            activeCalls.delete(callId);
        }
    }
}, 60_000);

const genCallId = (): string => crypto.randomBytes(8).toString('hex');

type Ack = ((response: { success: boolean; [key: string]: any }) => void) | undefined;

export const registerCallSignaling = (io: SocketIOServer): void => {
    const call = io.of('/call');

    call.on('connection', (socket: Socket) => {
        socket.on('register', (payload: { deviceId: string }) => {
            if (!payload?.deviceId) return;
            deviceIdToSocketId.set(payload.deviceId, socket.id);
            socket.data.deviceId = payload.deviceId;
            logger.info(`📞 [CALL] Registered device ${payload.deviceId} on socket ${socket.id}`);
        });

        socket.on('call:invite', async (payload: { calleeDeviceId: string }, ack: Ack) => {
            const callerDeviceId = socket.data.deviceId as string | undefined;
            if (!callerDeviceId) return ack?.({ success: false, error: 'Call device not registered' });
            if (!payload?.calleeDeviceId) return ack?.({ success: false, error: 'calleeDeviceId is required' });

            const callId = genCallId();
            activeCalls.set(callId, { callerDeviceId, calleeDeviceId: payload.calleeDeviceId, status: 'ringing', createdAt: Date.now() });
            socket.join(`call:${callId}`);
            socket.data.callId = callId;

            const calleeSocketId = deviceIdToSocketId.get(payload.calleeDeviceId);
            if (calleeSocketId) {
                call.to(calleeSocketId).emit('call:incoming', { callId, callerDeviceId });
            } else {
                // Already locally reachable over the socket — skip the FCM
                // round-trip, it'd be redundant latency on the common case.
                const pushed = await sendPushToDevice(payload.calleeDeviceId, {
                    type: 'incoming_call', callId, callerDeviceId
                });
                if (!pushed) {
                    activeCalls.delete(callId);
                    return ack?.({ success: false, error: 'Callee is unreachable' });
                }
            }

            ack?.({ success: true, callId });
            logger.info(`📞 [CALL] ${callerDeviceId} invited ${payload.calleeDeviceId} (call ${callId})`);
        });

        socket.on('call:accept', (payload: { callId: string }, ack: Ack) => {
            const calleeDeviceId = socket.data.deviceId as string | undefined;
            const state = activeCalls.get(payload?.callId);
            if (!state || !calleeDeviceId || state.calleeDeviceId !== calleeDeviceId) {
                return ack?.({ success: false, error: 'No such call for this device' });
            }
            state.status = 'active';
            socket.join(`call:${payload.callId}`);
            socket.data.callId = payload.callId;

            const callerSocketId = deviceIdToSocketId.get(state.callerDeviceId);
            // The caller creates the first WebRTC offer (same "whoever
            // started this names the first target" shape as Watch Hub's
            // host) — it needs the callee's socket id to address that
            // offer, since nothing else in this event gives it one.
            if (callerSocketId) call.to(callerSocketId).emit('call:accepted', { callId: payload.callId, calleeSocketId: socket.id });
            ack?.({ success: true });
            logger.info(`📞 [CALL] ${calleeDeviceId} accepted call ${payload.callId}`);
        });

        socket.on('call:decline', (payload: { callId: string }) => {
            const deviceId = socket.data.deviceId as string | undefined;
            const state = activeCalls.get(payload?.callId);
            if (!state || state.calleeDeviceId !== deviceId) return;
            const callerSocketId = deviceIdToSocketId.get(state.callerDeviceId);
            if (callerSocketId) call.to(callerSocketId).emit('call:declined', { callId: payload.callId });
            activeCalls.delete(payload.callId);
            logger.info(`📞 [CALL] ${deviceId} declined call ${payload.callId}`);
        });

        socket.on('call:hangup', (payload: { callId: string }) => {
            endCall(payload?.callId, socket.data.deviceId as string | undefined, call);
        });

        // Pure relay, same room-membership guard watchSignalingService.ts's
        // relay uses — the target must actually be the other party on
        // THIS call, not just any socket id the sender happens to name.
        const relay = (event: string) => (payload: { callId: string; toSocketId: string; [key: string]: any }) => {
            const state = activeCalls.get(payload?.callId);
            const deviceId = socket.data.deviceId as string | undefined;
            if (!state || !deviceId || (state.callerDeviceId !== deviceId && state.calleeDeviceId !== deviceId)) return;
            const targetSocket = call.sockets.get(payload.toSocketId);
            if (!targetSocket || !targetSocket.rooms.has(`call:${payload.callId}`)) return;
            call.to(payload.toSocketId).emit(event, { ...payload, fromSocketId: socket.id });
        };
        socket.on('signal:offer', relay('signal:offer'));
        socket.on('signal:answer', relay('signal:answer'));
        socket.on('signal:ice', relay('signal:ice'));

        socket.on('disconnect', () => {
            const deviceId = socket.data.deviceId as string | undefined;
            if (deviceId && deviceIdToSocketId.get(deviceId) === socket.id) {
                deviceIdToSocketId.delete(deviceId);
            }
            endCall(socket.data.callId as string | undefined, deviceId, call);
        });
    });
};

const endCall = (
    callId: string | undefined, deviceId: string | undefined, call: ReturnType<SocketIOServer['of']>
): void => {
    if (!callId) return;
    const state = activeCalls.get(callId);
    if (!state || !deviceId || (state.callerDeviceId !== deviceId && state.calleeDeviceId !== deviceId)) return;
    call.to(`call:${callId}`).emit('call:ended', { callId });
    activeCalls.delete(callId);
    logger.info(`📞 [CALL] Call ${callId} ended`);
};

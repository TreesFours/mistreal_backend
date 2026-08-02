import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { sendSocialAction } from './socialService';
import { User } from '../models/userModel';
import logger from '../utils/logger';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const connection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});

// 1. Create the Social Action Queue
export const socialActionQueue = new Queue('socialActions', { connection });

// 2. Create the Worker to process scheduled tasks
const worker = new Worker('socialActions', async (job: Job) => {
    const { deviceId, action } = job.data;

    logger.info(`🤖 Processing scheduled social action for ${deviceId}`, { jobId: job.id });

    try {
        const user = await User.findOne({ where: { deviceId } });
        if (!user) {
            throw new Error(`User ${deviceId} not found for scheduled action`);
        }
        await sendSocialAction(user, action);
        logger.info(`✅ Successfully dispatched scheduled action for ${deviceId}`);
    } catch (error: any) {
        logger.error(`❌ Failed to dispatch scheduled action for ${deviceId}:`, error.message);
        throw error;
    }
}, { connection });

// 🛡️ Zero-Defect Fix #3: Graceful Backend Shutdown
// This prevents "Zombie" connections to Redis during server updates
const gracefulShutdown = async (signal: string) => {
    logger.info(`🛑 Received ${signal}. Shutting down BullMQ worker...`);
    await worker.close();
    await connection.quit();
    logger.info(`👋 Redis connection closed gracefully.`);
    process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

worker.on('failed', (job: Job | undefined, err: Error) => {
    logger.error(`🚨 Job ${job?.id} failed permanently:`, err.message);
});

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { sendSocialAction } from './socialService';
import { User } from '../models/userModel';
import logger from '../utils/logger';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

// 1. Create the Social Action Queue
export const socialActionQueue = new Queue('socialActions', { connection });

// 2. Create the Worker to process scheduled tasks
const worker = new Worker('socialActions', async (job: Job) => {
    const { deviceId, action, userToken } = job.data;

    logger.info(`🤖 Processing scheduled social action for ${deviceId}`, { jobId: job.id });

    try {
        await sendSocialAction(userToken, action);
        logger.info(`✅ Successfully dispatched scheduled action for ${deviceId}`);
    } catch (error: any) {
        logger.error(`❌ Failed to dispatch scheduled action for ${deviceId}:`, error.message);
        throw error; // BullMQ will handle retries automatically
    }
}, { connection });

worker.on('failed', (job, err) => {
    logger.error(`🚨 Job ${job?.id} failed permanently:`, err.message);
});

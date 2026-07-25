import winston from 'winston';

const scrubber = winston.format((info) => {
    const sensitiveKeys = ['zernioUserToken', 'content', 'prompt', 'audioData', 'imageDatas', 'purchaseToken'];

    if (info.level === 'error') {
        return info; // Do not scrub error objects to preserve debugging metadata
    }

    if (typeof info.message === 'object') {
        const scrubbed = { ...info.message };
        sensitiveKeys.forEach(key => {
            if (scrubbed[key]) scrubbed[key] = '[REDACTED]';
        });
        info.message = scrubbed;
    } else if (typeof info.message === 'string') {
        // Simple string scrubbing (optional)
    }

    return info;
});

const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        scrubber(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console()
    ],
});

export default logger;

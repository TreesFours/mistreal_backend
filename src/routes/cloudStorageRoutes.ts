import { Router, Request, Response } from 'express';
import { CloudStorageConfig } from '../models/CloudStorageConfig';
import { listFiles } from '../services/cloudStorageService';
import { encrypt } from '../utils/secretCrypto';
import logger from '../utils/logger';

const router = Router();

router.post('/configs', async (req: Request, res: Response) => {
    try {
        const { deviceId, label, providerType, baseUrl, username, password } = req.body;
        if (!deviceId || !label || !baseUrl || !username || !password) {
            return res.status(200).json({ success: false, error: 'deviceId, label, baseUrl, username and password are required' });
        }

        const config = await CloudStorageConfig.create({
            deviceId, label,
            providerType: providerType || 'webdav',
            baseUrl, username,
            encryptedPassword: encrypt(password),
            isActive: false
        });

        res.json({ success: true, config: toSafeConfig(config) });
    } catch (e: any) {
        logger.error(`❌ POST /cloud-storage/configs error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.get('/configs', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        if (!deviceId) return res.status(200).json({ success: false, configs: [], error: 'deviceId required' });
        const configs = await CloudStorageConfig.findAll({ where: { deviceId }, order: [['createdAt', 'DESC']] });
        res.json({ success: true, configs: configs.map(toSafeConfig) });
    } catch (e: any) {
        res.status(200).json({ success: false, configs: [], error: e.message });
    }
});

// Only one active config per device — activating one deactivates the rest,
// enforced here rather than at the DB level since it's a per-device
// business rule, not a data-integrity constraint.
router.post('/configs/activate', async (req: Request, res: Response) => {
    try {
        const { deviceId, configId } = req.body;
        if (!deviceId || !configId) return res.status(200).json({ success: false, error: 'deviceId and configId are required' });

        const target = await CloudStorageConfig.findOne({ where: { id: configId, deviceId } });
        if (!target) return res.status(200).json({ success: false, error: 'Config not found for this device' });

        await CloudStorageConfig.update({ isActive: false }, { where: { deviceId } });
        target.isActive = true;
        await target.save();

        res.json({ success: true, config: toSafeConfig(target) });
    } catch (e: any) {
        logger.error(`❌ POST /cloud-storage/configs/activate error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

router.delete('/configs/:id', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        await CloudStorageConfig.destroy({ where: { id: req.params.id, deviceId } });
        res.json({ success: true });
    } catch (e: any) {
        res.status(200).json({ success: false, error: e.message });
    }
});

router.get('/files', async (req: Request, res: Response) => {
    try {
        const deviceId = req.query.deviceId as string;
        const path = (req.query.path as string) || '/';
        if (!deviceId) return res.status(200).json({ success: false, files: [], error: 'deviceId required' });

        const config = await CloudStorageConfig.findOne({ where: { deviceId, isActive: true } });
        if (!config) return res.status(200).json({ success: false, files: [], error: 'No active cloud storage account for this device' });

        const files = await listFiles(config, path);
        res.json({ success: true, files });
    } catch (e: any) {
        logger.error(`❌ GET /cloud-storage/files error: ${e.message}`);
        res.status(200).json({ success: false, files: [], error: e.message });
    }
});

// Password never leaves this server once saved — same write-only
// convention the AI BYOK status endpoints already use.
const toSafeConfig = (config: CloudStorageConfig) => ({
    id: config.id,
    deviceId: config.deviceId,
    label: config.label,
    providerType: config.providerType,
    baseUrl: config.baseUrl,
    username: config.username,
    isActive: config.isActive
});

export default router;

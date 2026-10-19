import { Router, Request, Response } from 'express';
import { Game } from '../models/Game';
import logger from '../utils/logger';

const router = Router();

const APP_URL = process.env.APP_URL || 'https://mistreal-backend.onrender.com';

/** Resolves either sourceType into the one URL the client actually loads. */
const toPlayUrl = (game: Game): string =>
    game.sourceType === 'hosted'
        ? `${APP_URL}/games-static/${game.hostedSlug}/index.html`
        : (game.externalUrl as string);

const toSummary = (game: Game) => ({
    id: game.id,
    title: game.title,
    description: game.description,
    thumbnailUrl: game.thumbnailUrl,
    category: game.category,
    playUrl: toPlayUrl(game)
});

router.get('/', async (req: Request, res: Response) => {
    try {
        const { category } = req.query;
        const where: Record<string, any> = { isActive: true };
        if (category) where.category = category;

        const games = await Game.findAll({ where, order: [['createdAt', 'DESC']] });
        res.json({ success: true, games: games.map(toSummary) });
    } catch (e: any) {
        logger.error(`❌ GET /games error: ${e.message}`);
        res.status(200).json({ success: false, games: [], error: e.message });
    }
});

router.get('/:id', async (req: Request, res: Response) => {
    try {
        const game = await Game.findByPk(req.params.id);
        if (!game || !game.isActive) {
            return res.status(200).json({ success: false, game: null, error: 'Game not found' });
        }
        res.json({ success: true, game: toSummary(game) });
    } catch (e: any) {
        logger.error(`❌ GET /games/:id error: ${e.message}`);
        res.status(200).json({ success: false, game: null, error: e.message });
    }
});

/**
 * Admin-only catalog insert — a shared-secret header, not a full auth
 * system, since this is an internal tool for adding games, not a
 * user-facing endpoint. Lets the catalog grow (the whole point of this
 * feature) without a client release or a database console session.
 */
router.post('/', async (req: Request, res: Response) => {
    try {
        const adminKey = req.header('x-admin-key');
        if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
            return res.status(200).json({ success: false, error: 'Unauthorized' });
        }

        const { title, description, thumbnailUrl, category, sourceType, externalUrl, hostedSlug } = req.body;
        if (!title || !sourceType) {
            return res.status(200).json({ success: false, error: 'title and sourceType are required' });
        }
        if (sourceType === 'external' && !externalUrl) {
            return res.status(200).json({ success: false, error: 'externalUrl is required for sourceType "external"' });
        }
        if (sourceType === 'hosted' && !hostedSlug) {
            return res.status(200).json({ success: false, error: 'hostedSlug is required for sourceType "hosted"' });
        }

        const game = await Game.create({ title, description, thumbnailUrl, category, sourceType, externalUrl, hostedSlug });
        res.json({ success: true, game: toSummary(game) });
    } catch (e: any) {
        logger.error(`❌ POST /games error: ${e.message}`);
        res.status(200).json({ success: false, error: e.message });
    }
});

export default router;

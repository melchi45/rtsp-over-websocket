import { Router } from 'express';
import { probeYoutubeVideo } from '../services/youtubeProbe';

export function buildYoutubeRouter(): Router {
  const router = Router();

  router.get('/probe', async (req, res) => {
    const youtubeUrl = typeof req.query.url === 'string' ? req.query.url : undefined;
    if (!youtubeUrl) {
      res.status(400).json({ error: 'query param "url" is required' });
      return;
    }
    try {
      const probe = await probeYoutubeVideo(youtubeUrl);
      res.json(probe);
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}

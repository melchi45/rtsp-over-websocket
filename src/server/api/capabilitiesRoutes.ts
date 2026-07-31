import { Router } from 'express';
import { listCapabilities } from '../services/codecCapabilities';
import { RESOLUTION_LADDER } from '../types';

export function buildCapabilitiesRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const codecs = await listCapabilities();
      res.json({ resolutions: RESOLUTION_LADDER, ...codecs });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}

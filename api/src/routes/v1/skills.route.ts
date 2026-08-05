import { Router } from 'express';
import { skillsManager } from '../../services/skills-manager.js';

export const skillsRouter = Router();

skillsRouter.get('/', (req, res) => {
  try {
    const q = (req.query.q as string | undefined)?.trim();
    res.json({ skills: skillsManager.search(q) });
  } catch (err) {
    res.status(503).json({ error: 'Skills unavailable', detail: String(err) });
  }
});

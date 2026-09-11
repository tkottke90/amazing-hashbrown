import { Router } from 'express';
import type { Request, Response } from 'express';
import { skillsManager } from '../../services/skills-manager.js';
import { GATED_SKILL_REGISTRATIONS } from '../../agents/gated-skill-registrations.js';
import {
  searchSkillsHandler,
  getSkillHandler,
  createSkillHandler,
  editSkillHandler,
  deleteSkillHandler,
  readSkillFileHandler,
  writeSkillFileHandler,
  deleteSkillFileHandler,
  getSkillEvalsHandler,
  saveSkillEvalsHandler,
  type HandlerFailure,
} from './skills.handlers.js';

export const skillsRouter = Router();

const GATED_NAMES = GATED_SKILL_REGISTRATIONS.map((r) => r.skillCommand);

function sendFailure(res: Response, failure: HandlerFailure): void {
  res.status(failure.status).json({
    error: failure.error,
    ...(failure.fieldErrors ? { fieldErrors: failure.fieldErrors } : {}),
  });
}

skillsRouter.get('/', async (req: Request, res: Response) => {
  const q = (req.query.q as string | undefined)?.trim();
  const all = req.query.all === 'true';
  const result = await searchSkillsHandler(skillsManager, q, all);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json(result.data);
});

skillsRouter.get('/:name', async (req: Request, res: Response) => {
  const result = await getSkillHandler(skillsManager, req.params['name'] as string);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json(result.data);
});

skillsRouter.post('/', async (req: Request, res: Response) => {
  const result = await createSkillHandler(skillsManager, req.body);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.status(201).json(result.data);
});

skillsRouter.patch('/:name', async (req: Request, res: Response) => {
  const result = await editSkillHandler(skillsManager, req.params['name'] as string, req.body);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json(result.data);
});

skillsRouter.delete('/:name', async (req: Request, res: Response) => {
  const result = await deleteSkillHandler(skillsManager, req.params['name'] as string, GATED_NAMES);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json(result.data);
});

skillsRouter.get('/:name/files/:dir/:basename', async (req: Request, res: Response) => {
  const result = await readSkillFileHandler(
    skillsManager,
    req.params['name'] as string,
    req.params['dir'] as string,
    req.params['basename'] as string,
  );
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json(result.data);
});

skillsRouter.put('/:name/files/:dir/:basename', async (req: Request, res: Response) => {
  const result = await writeSkillFileHandler(
    skillsManager,
    req.params['name'] as string,
    req.params['dir'] as string,
    req.params['basename'] as string,
    req.body,
  );
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json(result.data);
});

skillsRouter.delete('/:name/files/:dir/:basename', async (req: Request, res: Response) => {
  const result = await deleteSkillFileHandler(
    skillsManager,
    req.params['name'] as string,
    req.params['dir'] as string,
    req.params['basename'] as string,
  );
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json(result.data);
});

skillsRouter.get('/:name/evals', async (req: Request, res: Response) => {
  const result = await getSkillEvalsHandler(skillsManager, req.params['name'] as string);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json(result.data);
});

skillsRouter.put('/:name/evals', async (req: Request, res: Response) => {
  const result = await saveSkillEvalsHandler(skillsManager, req.params['name'] as string, req.body);
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json(result.data);
});

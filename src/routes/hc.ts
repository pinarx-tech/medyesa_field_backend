import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { PrismaClient, Role } from '@prisma/client';
import { buildAuthPreHandler, requireRoles } from '../plugins/auth.js';
import { ActivityRepo } from '../repos/activityRepo.js';
import { DoctorRepo } from '../repos/doctorRepo.js';
import { TerritoryRepo } from '../repos/territoryRepo.js';
import { UserRepo } from '../repos/userRepo.js';
import {
  assignDoctorToTerritoryBodySchema,
  assignMrTerritoryBodySchema,
  createDoctorBodySchema,
  createTerritoryBodySchema,
  hcActivityQuerySchema,
  territoryDoctorParamsSchema,
  updateDoctorBodySchema,
  updateNotificationPrefsBodySchema,
  updateTerritoryBodySchema,
  uuidIdParamSchema,
} from '../schemas/hc.js';

export async function registerHcRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = buildAuthPreHandler(prisma);
  const onlyHc = [authenticate, requireRoles([Role.headController])];

  typed.get('/v1/hc/dashboard', { preHandler: onlyHc }, async (req) => {
    const repo = new ActivityRepo(prisma, req.authUser!);
    return repo.getHcDashboard();
  });

  typed.get('/v1/hc/doctors', { preHandler: onlyHc }, async (req) => {
    const repo = new DoctorRepo(prisma, req.authUser!);
    return { doctors: await repo.listForCompany() };
  });

  typed.post(
    '/v1/hc/doctors',
    { preHandler: onlyHc, schema: { body: createDoctorBodySchema } },
    async (req, reply) => {
      const repo = new DoctorRepo(prisma, req.authUser!);
      const doctor = await repo.create(req.body);
      return reply.status(201).send({ doctor });
    },
  );

  typed.patch(
    '/v1/hc/doctors/:id',
    {
      preHandler: onlyHc,
      schema: { params: uuidIdParamSchema, body: updateDoctorBodySchema },
    },
    async (req) => {
      const repo = new DoctorRepo(prisma, req.authUser!);
      return { doctor: await repo.update(req.params.id, req.body) };
    },
  );

  typed.post(
    '/v1/hc/doctors/:id/archive',
    { preHandler: onlyHc, schema: { params: uuidIdParamSchema } },
    async (req) => {
      const repo = new DoctorRepo(prisma, req.authUser!);
      return { doctor: await repo.archive(req.params.id) };
    },
  );

  typed.get('/v1/hc/territories', { preHandler: onlyHc }, async (req) => {
    const repo = new TerritoryRepo(prisma, req.authUser!);
    return { territories: await repo.listForCompany() };
  });

  typed.post(
    '/v1/hc/territories',
    { preHandler: onlyHc, schema: { body: createTerritoryBodySchema } },
    async (req, reply) => {
      const repo = new TerritoryRepo(prisma, req.authUser!);
      const territory = await repo.create(req.body);
      return reply.status(201).send({ territory });
    },
  );

  typed.patch(
    '/v1/hc/territories/:id',
    {
      preHandler: onlyHc,
      schema: { params: uuidIdParamSchema, body: updateTerritoryBodySchema },
    },
    async (req) => {
      const repo = new TerritoryRepo(prisma, req.authUser!);
      return { territory: await repo.update(req.params.id, req.body) };
    },
  );

  typed.post(
    '/v1/hc/territories/:id/archive',
    { preHandler: onlyHc, schema: { params: uuidIdParamSchema } },
    async (req) => {
      const repo = new TerritoryRepo(prisma, req.authUser!);
      return { territory: await repo.archive(req.params.id) };
    },
  );

  typed.post(
    '/v1/hc/territories/:id/doctors',
    {
      preHandler: onlyHc,
      schema: {
        params: uuidIdParamSchema,
        body: assignDoctorToTerritoryBodySchema,
      },
    },
    async (req, reply) => {
      const repo = new TerritoryRepo(prisma, req.authUser!);
      const assignment = await repo.addDoctor(req.params.id, req.body.doctorId);
      return reply.status(201).send({ assignment });
    },
  );

  typed.delete(
    '/v1/hc/territories/:id/doctors/:doctorId',
    { preHandler: onlyHc, schema: { params: territoryDoctorParamsSchema } },
    async (req) => {
      const repo = new TerritoryRepo(prisma, req.authUser!);
      return repo.removeDoctor(req.params.id, req.params.doctorId);
    },
  );

  typed.post(
    '/v1/hc/mrs/:id/territory',
    {
      preHandler: onlyHc,
      schema: { params: uuidIdParamSchema, body: assignMrTerritoryBodySchema },
    },
    async (req) => {
      const repo = new TerritoryRepo(prisma, req.authUser!);
      return repo.reassignMrTerritory(req.params.id, req.body.territoryId);
    },
  );

  typed.get('/v1/hc/mrs', { preHandler: onlyHc }, async (req) => {
    const repo = new UserRepo(prisma, req.authUser!);
    return { mrs: await repo.listCompanyMrs() };
  });

  typed.get(
    '/v1/hc/mrs/:id/activity',
    { preHandler: onlyHc, schema: { params: uuidIdParamSchema } },
    async (req) => {
      const repo = new ActivityRepo(prisma, req.authUser!);
      return repo.getMrTimeline(req.params.id);
    },
  );

  typed.get(
    '/v1/hc/activity',
    { preHandler: onlyHc, schema: { querystring: hcActivityQuerySchema } },
    async (req) => {
      const repo = new ActivityRepo(prisma, req.authUser!);
      return { events: await repo.listCompanyActivity(req.query) };
    },
  );

  typed.get(
    '/v1/hc/notifications/prefs',
    { preHandler: onlyHc },
    async (req) => {
      const repo = new ActivityRepo(prisma, req.authUser!);
      return { prefs: await repo.getNotificationPrefs() };
    },
  );

  typed.patch(
    '/v1/hc/notifications/prefs',
    {
      preHandler: onlyHc,
      schema: { body: updateNotificationPrefsBodySchema },
    },
    async (req) => {
      const repo = new ActivityRepo(prisma, req.authUser!);
      return { prefs: await repo.updateNotificationPrefs(req.body) };
    },
  );
}

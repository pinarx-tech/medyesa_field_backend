import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { PrismaClient, Role } from '@prisma/client';
import { buildAuthPreHandler, requireRoles } from '../plugins/auth.js';
import { ActivityRepo } from '../repos/activityRepo.js';
import { ClinicRepo } from '../repos/clinicRepo.js';
import { DoctorOnboardRepo } from '../repos/doctorOnboardRepo.js';
import { DoctorRepo } from '../repos/doctorRepo.js';
import { HcActivityRepo } from '../repos/hcActivityRepo.js';
import { HcDashboardRepo } from '../repos/hcDashboardRepo.js';
import { HcMonitoringRepo } from '../repos/hcMonitoringRepo.js';
import { HcRecoveryRepo } from '../repos/hcRecoveryRepo.js';
import { TerritoryRepo } from '../repos/territoryRepo.js';
import { UserRepo } from '../repos/userRepo.js';
import {
  assignDoctorToTerritoryBodySchema,
  assignMrTerritoryBodySchema,
  clinicSearchQuerySchema,
  correctVisitBodySchema,
  createClinicBodySchema,
  createDoctorBodySchema,
  createTerritoryBodySchema,
  hcActivityQuerySchema,
  hcDateQuerySchema,
  onboardDoctorBodySchema,
  reopenWorkdayBodySchema,
  territoryDoctorParamsSchema,
  updateClinicBodySchema,
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

  // Part 1 — Redesigned 6-Metric Dashboard
  typed.get(
    '/v1/hc/dashboard',
    { preHandler: onlyHc, schema: { querystring: hcDateQuerySchema } },
    async (req) => {
      const repo = new HcDashboardRepo(prisma, req.authUser!);
      return repo.getDashboard(req.query);
    },
  );

  // Part 2 — Doctors, One-Page Atomic Onboard & Clinics
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

  typed.post(
    '/v1/hc/doctors/onboard',
    { preHandler: onlyHc, schema: { body: onboardDoctorBodySchema } },
    async (req, reply) => {
      const repo = new DoctorOnboardRepo(prisma, req.authUser!);
      const result = await repo.onboard(req.body);
      return reply.status(result.deduplicated ? 200 : 201).send(result);
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

  typed.get(
    '/v1/hc/clinics',
    { preHandler: onlyHc, schema: { querystring: clinicSearchQuerySchema } },
    async (req) => {
      const repo = new ClinicRepo(prisma, req.authUser!);
      return { clinics: await repo.listForCompany(req.query.q) };
    },
  );

  typed.post(
    '/v1/hc/clinics',
    { preHandler: onlyHc, schema: { body: createClinicBodySchema } },
    async (req, reply) => {
      const repo = new ClinicRepo(prisma, req.authUser!);
      const clinic = await repo.create(req.body);
      return reply.status(201).send({ clinic });
    },
  );

  typed.patch(
    '/v1/hc/clinics/:id',
    {
      preHandler: onlyHc,
      schema: { params: uuidIdParamSchema, body: updateClinicBodySchema },
    },
    async (req) => {
      const repo = new ClinicRepo(prisma, req.authUser!);
      return { clinic: await repo.update(req.params.id, req.body) };
    },
  );

  // Territories & MR Territory Reassignment
  typed.get('/v1/hc/territories', { preHandler: onlyHc }, async (req) => {
    const repo = new TerritoryRepo(prisma, req.authUser!);
    return { territories: await repo.listForCompany() };
  });

  typed.get(
    '/v1/hc/territories/:id',
    { preHandler: onlyHc, schema: { params: uuidIdParamSchema } },
    async (req) => {
      const repo = new TerritoryRepo(prisma, req.authUser!);
      return repo.getDetail(req.params.id);
    },
  );

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

  // Part 4 — MR List & 5-State Monitoring
  typed.get('/v1/hc/mrs', { preHandler: onlyHc }, async (req) => {
    const repo = new UserRepo(prisma, req.authUser!);
    return { mrs: await repo.listCompanyMrs() };
  });

  typed.get(
    '/v1/hc/mrs/:id/monitoring',
    {
      preHandler: onlyHc,
      schema: { params: uuidIdParamSchema, querystring: hcDateQuerySchema },
    },
    async (req) => {
      const repo = new HcMonitoringRepo(prisma, req.authUser!);
      return repo.getMrMonitoring(req.params.id, req.query);
    },
  );

  typed.get(
    '/v1/hc/mrs/:id/activity',
    { preHandler: onlyHc, schema: { params: uuidIdParamSchema } },
    async (req) => {
      const repo = new ActivityRepo(prisma, req.authUser!);
      return repo.getMrTimeline(req.params.id);
    },
  );

  // Part 3 — 6-Category Operational Activity History
  typed.get(
    '/v1/hc/activity',
    { preHandler: onlyHc, schema: { querystring: hcActivityQuerySchema } },
    async (req) => {
      const repo = new HcActivityRepo(prisma, req.authUser!);
      return repo.listOperationalActivity(req.query);
    },
  );

  // Part 5 — Audited Human-Error Recovery
  typed.post(
    '/v1/hc/workdays/:id/reopen',
    {
      preHandler: onlyHc,
      schema: { params: uuidIdParamSchema, body: reopenWorkdayBodySchema },
    },
    async (req) => {
      const repo = new HcRecoveryRepo(prisma, req.authUser!);
      return repo.reopenWorkDay(req.params.id, req.body);
    },
  );

  typed.post(
    '/v1/hc/visits/:id/correct',
    {
      preHandler: onlyHc,
      schema: { params: uuidIdParamSchema, body: correctVisitBodySchema },
    },
    async (req, reply) => {
      const repo = new HcRecoveryRepo(prisma, req.authUser!);
      const result = await repo.correctVisit(req.params.id, req.body);
      return reply.status(201).send(result);
    },
  );

  // Notification preferences
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

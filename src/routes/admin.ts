import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AccountStatus, PrismaClient, Role } from '@prisma/client';
import { buildAuthPreHandler, requireRoles } from '../plugins/auth.js';
import { CompanyRepo } from '../repos/companyRepo.js';
import { UserRepo } from '../repos/userRepo.js';
import {
  adminResetPasswordBodySchema,
  companyIdParamSchema,
  createCompanyBodySchema,
  createUserBodySchema,
  listUsersQuerySchema,
  updateCompanyBodySchema,
  updateUserBodySchema,
  userIdParamSchema,
} from '../schemas/admin.js';

export async function registerAdminRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const authenticate = buildAuthPreHandler(prisma);
  const onlyPlatformAdmin = [authenticate, requireRoles([Role.platformAdmin])];

  typed.get(
    '/v1/admin/companies',
    { preHandler: onlyPlatformAdmin },
    async (req) => {
      const repo = new CompanyRepo(prisma, req.authUser!);
      return { companies: await repo.listAllWithSeats() };
    },
  );

  typed.post(
    '/v1/admin/companies',
    {
      preHandler: onlyPlatformAdmin,
      schema: { body: createCompanyBodySchema },
    },
    async (req, reply) => {
      const repo = new CompanyRepo(prisma, req.authUser!);
      const company = await repo.create(req.body);
      return reply.status(201).send({ company });
    },
  );

  typed.get(
    '/v1/admin/companies/:id',
    {
      preHandler: onlyPlatformAdmin,
      schema: { params: companyIdParamSchema },
    },
    async (req) => {
      const repo = new CompanyRepo(prisma, req.authUser!);
      return { company: await repo.getDetail(req.params.id) };
    },
  );

  typed.patch(
    '/v1/admin/companies/:id',
    {
      preHandler: onlyPlatformAdmin,
      schema: {
        params: companyIdParamSchema,
        body: updateCompanyBodySchema,
      },
    },
    async (req) => {
      const repo = new CompanyRepo(prisma, req.authUser!);
      return { company: await repo.update(req.params.id, req.body) };
    },
  );

  typed.delete(
    '/v1/admin/companies/:id',
    {
      preHandler: onlyPlatformAdmin,
      schema: { params: companyIdParamSchema },
    },
    async (req) => {
      const repo = new CompanyRepo(prisma, req.authUser!);
      return repo.deletePermanent(req.params.id);
    },
  );

  typed.get(
    '/v1/admin/users',
    {
      preHandler: onlyPlatformAdmin,
      schema: { querystring: listUsersQuerySchema },
    },
    async (req) => {
      const repo = new UserRepo(prisma, req.authUser!);
      return { users: await repo.listAdmin(req.query) };
    },
  );

  typed.post(
    '/v1/admin/users',
    {
      preHandler: onlyPlatformAdmin,
      schema: { body: createUserBodySchema },
    },
    async (req, reply) => {
      const repo = new UserRepo(prisma, req.authUser!);
      const { user, temporaryPassword } = await repo.createUser(req.body);
      return reply.status(201).send({ user, temporaryPassword });
    },
  );

  typed.patch(
    '/v1/admin/users/:id',
    {
      preHandler: onlyPlatformAdmin,
      schema: {
        params: userIdParamSchema,
        body: updateUserBodySchema,
      },
    },
    async (req) => {
      const repo = new UserRepo(prisma, req.authUser!);
      return { user: await repo.updateUser(req.params.id, req.body) };
    },
  );

  typed.post(
    '/v1/admin/users/:id/suspend',
    {
      preHandler: onlyPlatformAdmin,
      schema: { params: userIdParamSchema },
    },
    async (req) => {
      const repo = new UserRepo(prisma, req.authUser!);
      return {
        user: await repo.setAccountStatus(
          req.params.id,
          AccountStatus.suspended,
        ),
      };
    },
  );

  typed.post(
    '/v1/admin/users/:id/reactivate',
    {
      preHandler: onlyPlatformAdmin,
      schema: { params: userIdParamSchema },
    },
    async (req) => {
      const repo = new UserRepo(prisma, req.authUser!);
      return {
        user: await repo.setAccountStatus(req.params.id, AccountStatus.active),
      };
    },
  );

  typed.post(
    '/v1/admin/users/:id/deactivate',
    {
      preHandler: onlyPlatformAdmin,
      schema: { params: userIdParamSchema },
    },
    async (req) => {
      const repo = new UserRepo(prisma, req.authUser!);
      return {
        user: await repo.setAccountStatus(
          req.params.id,
          AccountStatus.deactivated,
        ),
      };
    },
  );

  typed.post(
    '/v1/admin/users/:id/reset-password',
    {
      preHandler: onlyPlatformAdmin,
      schema: {
        params: userIdParamSchema,
        body: adminResetPasswordBodySchema,
      },
    },
    async (req) => {
      const repo = new UserRepo(prisma, req.authUser!);
      return repo.adminResetPassword(req.params.id, req.body.newPassword);
    },
  );

  typed.delete(
    '/v1/admin/users/:id',
    {
      preHandler: onlyPlatformAdmin,
      schema: { params: userIdParamSchema },
    },
    async (req) => {
      const repo = new UserRepo(prisma, req.authUser!);
      return repo.deletePermanent(req.params.id);
    },
  );
}

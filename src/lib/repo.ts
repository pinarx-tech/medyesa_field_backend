import { DataClassification, PrismaClient, Role } from '@prisma/client';
import { AppError } from './errors.js';

export interface RequestContext {
  userId: string;
  companyId: number | null;
  companyName: string | null;
  companyCode: string | null;
  companyClassification: DataClassification;
  role: Role;
  employeeId: string;
  displayName: string;
  ipAddress?: string;
}

export class Repo {
  constructor(
    protected readonly prisma: PrismaClient,
    protected readonly ctx: RequestContext,
  ) {}

  /** Always call this for tenant-scoped reads and writes. */
  protected scopeCompany(): number {
    if (this.ctx.companyId == null) {
      throw new AppError(
        'no_company_scope',
        403,
        'Account has no company scope for this operation.',
      );
    }
    return this.ctx.companyId;
  }

  /** Returns the authenticated company's classification without an extra DB round-trip. */
  protected scopeClassification(): DataClassification {
    return this.ctx.companyClassification;
  }

  /** For platform admins operating explicitly across companies. */
  protected scopeCompanyExplicit(companyId: number): number {
    if (this.ctx.role !== Role.platformAdmin) {
      throw new AppError('forbidden', 403, 'Platform admin role required.');
    }
    return companyId;
  }

  /** For MR-scoped self-only reads and writes. */
  protected scopeSelf(userId: string): string {
    if (this.ctx.role !== Role.mr || this.ctx.userId !== userId) {
      throw new AppError('forbidden', 403, 'Operation restricted to self.');
    }
    return userId;
  }
}

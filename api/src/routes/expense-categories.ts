import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { localDevelopmentMode } from "../config.js";
import { db } from "../db/client.js";
import { expenseCategories, expenseSubcategories } from "../db/schema.js";
import { hasPermission } from "../permissions.js";
import type { TenantReferenceValidationError } from "../tenant-ownership.js";

const workspaceParams = z.object({ workspaceId: z.string().uuid() });
const subcategoryParams = workspaceParams.extend({ subcategoryId: z.string().uuid() });
const subcategoryInput = z.object({ categoryId: z.string().uuid(), name: z.string().trim().min(2).max(100) });
const subcategoryUpdate = z.object({ name: z.string().trim().min(2).max(100).optional(), active: z.boolean().optional() });

const localCategories = [
  ["Labour Related", ["Wages", "Bonus Payment"]], ["Fuel & POL", ["Diesel", "Petrol", "Lubricants"]],
  ["Fertilizers & Chemicals", ["Fertilizer", "Pesticide", "Other"]], ["Irrigation & Water", ["Irrigation Material", "Pump Maintenance"]],
  ["Machinery & Vehicles", ["Spare Parts", "Vehicle Repair", "Equipment Rental"]], ["Kitchen & Camp", ["Groceries", "Vegetables", "Meat", "Drinking Water", "Gas Cylinder"]],
  ["Harvest & Packaging", ["Cartons", "Packaging Material", "Transport"]], ["Maintenance & Repairs", ["Electrical", "Plumbing", "Building Repair", "Farm Maintenance"]],
  ["Administration", ["Mobile & Internet", "Government Fees"]], ["Other", ["Miscellaneous"]],
] as const;

function hasWorkspace(request: FastifyRequest, workspaceId: string) {
  return request.appUser?.workspaceId === workspaceId
    && request.appUser.memberships.some((membership) => membership.active && membership.workspaceId === workspaceId);
}

export async function resolveExpenseCategory(workspaceId: string, categoryId?: unknown, subcategoryId?: unknown) {
  if (typeof categoryId === "string" && typeof subcategoryId === "string") {
    const [selected] = await db.select({
      categoryId: expenseCategories.id, category: expenseCategories.name,
      subcategoryId: expenseSubcategories.id, subcategory: expenseSubcategories.name,
    }).from(expenseSubcategories).innerJoin(expenseCategories, eq(expenseCategories.id, expenseSubcategories.categoryId))
      .where(and(
        eq(expenseCategories.id, categoryId), eq(expenseSubcategories.id, subcategoryId),
        eq(expenseCategories.active, true), eq(expenseSubcategories.active, true),
        or(isNull(expenseCategories.workspaceId), eq(expenseCategories.workspaceId, workspaceId)),
        or(isNull(expenseSubcategories.workspaceId), eq(expenseSubcategories.workspaceId, workspaceId)),
      )).limit(1);
    return selected ?? null;
  }
  const [fallback] = await db.select({
    categoryId: expenseCategories.id, category: expenseCategories.name,
    subcategoryId: expenseSubcategories.id, subcategory: expenseSubcategories.name,
  }).from(expenseSubcategories).innerJoin(expenseCategories, eq(expenseCategories.id, expenseSubcategories.categoryId))
    .where(and(isNull(expenseCategories.workspaceId), eq(expenseCategories.name, "Other"), isNull(expenseSubcategories.workspaceId), eq(expenseSubcategories.name, "Miscellaneous")))
    .limit(1);
  return fallback ?? null;
}

export async function validateExpenseCategoryReference(
  workspaceId: string,
  categoryId?: unknown,
  subcategoryId?: unknown,
): Promise<{ category: Awaited<ReturnType<typeof resolveExpenseCategory>>; error: TenantReferenceValidationError | null }> {
  if (typeof categoryId !== "string" || !categoryId) {
    return {
      category: null,
      error: {
        code: "expense_category_missing",
        entity: "expense category",
        entityId: categoryId == null ? null : String(categoryId),
        entityName: null,
        workspaceId,
        farmId: null,
        seasonId: null,
        expectedWorkspace: workspaceId,
        actualWorkspace: null,
        message: "Expense category is required.",
      },
    };
  }
  if (typeof subcategoryId !== "string" || !subcategoryId) {
    return {
      category: null,
      error: {
        code: "expense_subcategory_missing",
        entity: "expense subcategory",
        entityId: subcategoryId == null ? null : String(subcategoryId),
        entityName: null,
        workspaceId,
        farmId: null,
        seasonId: null,
        expectedWorkspace: workspaceId,
        actualWorkspace: null,
        message: "Expense subcategory is required.",
      },
    };
  }
  const [subcategoryRecord] = await db.select({
    id: expenseSubcategories.id,
    name: expenseSubcategories.name,
    workspaceId: expenseSubcategories.workspaceId,
    categoryId: expenseSubcategories.categoryId,
    active: expenseSubcategories.active,
  }).from(expenseSubcategories).where(eq(expenseSubcategories.id, subcategoryId)).limit(1);
  if (!subcategoryRecord) {
    return {
      category: null,
      error: {
        code: "expense_subcategory_not_found",
        entity: "expense subcategory",
        entityId: subcategoryId,
        entityName: null,
        workspaceId,
        farmId: null,
        seasonId: null,
        expectedWorkspace: workspaceId,
        actualWorkspace: null,
        message: `Expense subcategory id ${subcategoryId} does not exist.`,
      },
    };
  }
  const [categoryRecord] = await db.select({
    id: expenseCategories.id,
    name: expenseCategories.name,
    workspaceId: expenseCategories.workspaceId,
    active: expenseCategories.active,
  }).from(expenseCategories).where(eq(expenseCategories.id, categoryId)).limit(1);
  if (!categoryRecord) {
    return {
      category: null,
      error: {
        code: "expense_category_not_found",
        entity: "expense category",
        entityId: categoryId,
        entityName: null,
        workspaceId,
        farmId: null,
        seasonId: null,
        expectedWorkspace: workspaceId,
        actualWorkspace: null,
        message: `Expense category id ${categoryId} does not exist.`,
      },
    };
  }
  if (categoryRecord.workspaceId && categoryRecord.workspaceId !== workspaceId) {
    return {
      category: null,
      error: {
        code: "expense_category_workspace_mismatch",
        entity: "expense category",
        entityId: categoryId,
        entityName: categoryRecord.name,
        workspaceId,
        farmId: null,
        seasonId: null,
        expectedWorkspace: workspaceId,
        actualWorkspace: categoryRecord.workspaceId,
        message: `Expense category '${categoryRecord.name}' belongs to another workspace.`,
      },
    };
  }
  if (subcategoryRecord.workspaceId && subcategoryRecord.workspaceId !== workspaceId) {
    return {
      category: null,
      error: {
        code: "expense_subcategory_workspace_mismatch",
        entity: "expense subcategory",
        entityId: subcategoryId,
        entityName: subcategoryRecord.name,
        workspaceId,
        farmId: null,
        seasonId: null,
        expectedWorkspace: workspaceId,
        actualWorkspace: subcategoryRecord.workspaceId,
        message: `Expense subcategory '${subcategoryRecord.name}' belongs to another workspace.`,
      },
    };
  }
  if (!categoryRecord.active) {
    return {
      category: null,
      error: {
        code: "expense_category_inactive",
        entity: "expense category",
        entityId: categoryId,
        entityName: categoryRecord.name,
        workspaceId,
        farmId: null,
        seasonId: null,
        expectedWorkspace: workspaceId,
        actualWorkspace: categoryRecord.workspaceId ?? workspaceId,
        message: `Expense category '${categoryRecord.name}' is inactive.`,
      },
    };
  }
  if (!subcategoryRecord.active) {
    return {
      category: null,
      error: {
        code: "expense_subcategory_inactive",
        entity: "expense subcategory",
        entityId: subcategoryId,
        entityName: subcategoryRecord.name,
        workspaceId,
        farmId: null,
        seasonId: null,
        expectedWorkspace: workspaceId,
        actualWorkspace: subcategoryRecord.workspaceId ?? workspaceId,
        message: `Expense subcategory '${subcategoryRecord.name}' is inactive.`,
      },
    };
  }
  if (subcategoryRecord.categoryId !== categoryRecord.id) {
    return {
      category: null,
      error: {
        code: "expense_subcategory_category_mismatch",
        entity: "expense subcategory",
        entityId: subcategoryId,
        entityName: subcategoryRecord.name,
        workspaceId,
        farmId: null,
        seasonId: null,
        expectedWorkspace: workspaceId,
        actualWorkspace: subcategoryRecord.workspaceId ?? workspaceId,
        message: `Expense subcategory '${subcategoryRecord.name}' does not belong to category '${categoryRecord.name}'.`,
      },
    };
  }
  const category = await resolveExpenseCategory(workspaceId, categoryId, subcategoryId);
  if (!category) {
    return {
      category: null,
      error: {
        code: "expense_category_scope_mismatch",
        entity: "expense category",
        entityId: categoryId,
        entityName: categoryRecord.name,
        workspaceId,
        farmId: null,
        seasonId: null,
        expectedWorkspace: workspaceId,
        actualWorkspace: categoryRecord.workspaceId ?? workspaceId,
        message: `Expense category '${categoryRecord.name}' does not belong to the selected workspace.`,
      },
    };
  }
  return { category, error: null };
}

export async function expenseCategoryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/workspace/:workspaceId/expense-categories", { preHandler: requireUser }, async (request, reply) => {
    const params = workspaceParams.safeParse(request.params);
    if (!request.appUser || !params.success || !hasWorkspace(request, params.data.workspaceId)) return reply.code(403).send({ message: "Workspace membership is required." });
    if (localDevelopmentMode) return {
      categories: localCategories.map(([name, subcategories], categoryIndex) => ({
        id: `local-category-${categoryIndex}`, name, sortOrder: categoryIndex * 10, isSystem: true,
        subcategories: subcategories.map((subcategory, subcategoryIndex) => ({ id: `local-subcategory-${categoryIndex}-${subcategoryIndex}`, name: subcategory, sortOrder: subcategoryIndex * 10, isSystem: true, active: true })),
      })),
    };
    const categories = await db.select().from(expenseCategories)
      .where(and(isNull(expenseCategories.workspaceId), eq(expenseCategories.isSystem, true), eq(expenseCategories.active, true)))
      .orderBy(asc(expenseCategories.sortOrder));
    const subcategories = await db.select().from(expenseSubcategories)
      .where(and(or(isNull(expenseSubcategories.workspaceId), eq(expenseSubcategories.workspaceId, params.data.workspaceId)), eq(expenseSubcategories.active, true)))
      .orderBy(asc(expenseSubcategories.sortOrder));
    return { categories: categories.map((category) => ({ ...category, subcategories: subcategories.filter((subcategory) => subcategory.categoryId === category.id) })) };
  });

  app.post("/v1/workspace/:workspaceId/expense-subcategories", { preHandler: requireUser }, async (request, reply) => {
    const params = workspaceParams.safeParse(request.params);
    const input = subcategoryInput.safeParse(request.body);
    if (!request.appUser || !params.success || !input.success || !hasWorkspace(request, params.data.workspaceId)) return reply.code(403).send({ message: "Workspace membership is required." });
    if (!hasPermission(request.appUser, "MANAGE_EXPENSE_CATEGORIES", params.data.workspaceId)) return reply.code(403).send({ message: "Workspace owner permission is required." });
    const [category] = await db.select({ id: expenseCategories.id }).from(expenseCategories)
      .where(and(eq(expenseCategories.id, input.data.categoryId), isNull(expenseCategories.workspaceId), eq(expenseCategories.isSystem, true))).limit(1);
    if (!category) return reply.code(400).send({ message: "Choose a system expense category." });
    const [subcategory] = await db.insert(expenseSubcategories).values({ ...input.data, workspaceId: params.data.workspaceId }).returning();
    return reply.code(201).send({ subcategory });
  });

  app.patch("/v1/workspace/:workspaceId/expense-subcategories/:subcategoryId", { preHandler: requireUser }, async (request, reply) => {
    const params = subcategoryParams.safeParse(request.params);
    const input = subcategoryUpdate.safeParse(request.body);
    if (!request.appUser || !params.success || !input.success || !hasWorkspace(request, params.data.workspaceId)) return reply.code(403).send({ message: "Workspace membership is required." });
    if (!hasPermission(request.appUser, "MANAGE_EXPENSE_CATEGORIES", params.data.workspaceId)) return reply.code(403).send({ message: "Workspace owner permission is required." });
    const [subcategory] = await db.update(expenseSubcategories).set({ ...input.data, updatedAt: new Date() })
      .where(and(eq(expenseSubcategories.id, params.data.subcategoryId), eq(expenseSubcategories.workspaceId, params.data.workspaceId), eq(expenseSubcategories.isSystem, false))).returning();
    if (!subcategory) return reply.code(403).send({ message: "System subcategories cannot be modified." });
    return { subcategory };
  });
}

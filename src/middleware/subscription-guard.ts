import { RequestHandler } from "express";
import { prisma } from "../config/prisma";
import { subscriptionService, FeatureKey } from "../services/subscription.service";
import { AppError } from "../utils/errors";

export const requireActiveSubscription: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.auth?.businessAccountId) throw new AppError(403, "Business account context required", "BUSINESS_ACCOUNT_REQUIRED");
    await subscriptionService.getCurrentRecord(req.auth.businessAccountId);
    next();
  } catch (error) {
    next(error);
  }
};

export const requireFeature = (featureKey: FeatureKey): RequestHandler => async (req, _res, next) => {
  try {
    if (!req.auth?.businessAccountId) throw new AppError(403, "Business account context required", "BUSINESS_ACCOUNT_REQUIRED");
    await subscriptionService.assertFeatureAllowed(req.auth.businessAccountId, featureKey, req.auth.businessId ?? undefined);
    next();
  } catch (error) {
    next(error);
  }
};

export const canCreateBusiness = (businessAccountId: string) => subscriptionService.assertWithinLimit(businessAccountId, "businessesCount");
export const canAddStaff = (businessAccountId: string, businessId?: string) => subscriptionService.assertWithinLimit(businessAccountId, "staffCount", businessId);
export const canCreateService = (businessAccountId: string, businessId?: string) => subscriptionService.assertWithinLimit(businessAccountId, "servicesCount", businessId);
export const canCreateAppointment = (businessAccountId: string, businessId?: string) => subscriptionService.assertWithinLimit(businessAccountId, "appointmentsUsed", businessId);
export const canUseConversation = (businessAccountId: string) => subscriptionService.assertPreparedLimit(businessAccountId, "conversationsUsed");
export const canUseAiReply = (businessAccountId: string) => subscriptionService.assertPreparedLimit(businessAccountId, "aiRepliesUsed");
export const getAccountUsage = async (businessAccountId: string) => (await subscriptionService.getCurrent(businessAccountId)).accountUsage;
export const getBusinessUsage = async (businessId: string) => {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw new AppError(404, "Business not found", "BUSINESS_NOT_FOUND");
  return (await subscriptionService.getCurrent(business.businessAccountId, businessId)).businessUsage;
};
export const getBusinessPlanLimits = async (businessAccountId: string) => (await subscriptionService.getCurrent(businessAccountId)).limits;
export const assertFeatureAllowed = (businessAccountId: string, featureKey: FeatureKey, businessId?: string) => subscriptionService.assertFeatureAllowed(businessAccountId, featureKey, businessId);

export const updateBusinessesUsage = (businessAccountId: string, delta: number) => subscriptionService.updateAccountUsage(businessAccountId, "businessesCount", delta);
export const updateStaffUsage = (businessAccountId: string, delta: number, businessId?: string) => subscriptionService.updateAccountUsage(businessAccountId, "staffCount", delta, businessId);
export const updateServicesUsage = (businessAccountId: string, delta: number, businessId?: string) => subscriptionService.updateAccountUsage(businessAccountId, "servicesCount", delta, businessId);
export const updateAppointmentsUsage = async (businessAccountId: string, businessId: string, delta = 1) => {
  await Promise.all([
    subscriptionService.updateAccountUsage(businessAccountId, "appointmentsUsed", delta, businessId),
    subscriptionService.updateBusinessUsage(businessId, "appointmentsUsed", delta),
  ]);
};

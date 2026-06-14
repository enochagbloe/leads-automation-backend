import { BusinessPolicyCategory, BusinessRole, ServiceReadinessStatus, WhatsAppIntegrationStatus } from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "../utils/errors";
import { getBusinessAvailabilityForAiContext } from "./availability.service";
import { cacheService } from "./cache.service";
import { getBusinessPoliciesForAiContext } from "./policy.service";
import { getBusinessServiceSummaryForAiContext } from "./service.service";

const KEY = (id: string) => `business:${id}:knowledge-preview`;
const route = { PROFILE: "/settings/business/profile", SERVICES: "/settings/business/services", AVAILABILITY: "/settings/business/availability", POLICIES: "/settings/business/policies", WHATSAPP: "/settings/business/whatsapp" } as const;
const present = (v?: string | null) => Boolean(v?.trim());
const status = (score: number) => score < 40 ? "MISSING" : score < 70 ? "INCOMPLETE" : score < 90 ? "PARTIAL" : "READY";
const section = (score: number, label: string, description: string, r: string) => ({ score, status: status(score), label, description, route: r });
export async function invalidateBusinessKnowledgePreview(businessId: string) { await cacheService.del(KEY(businessId)); }

async function build(businessId: string) {
  const [business, serviceSummary, availability, policyContext, policyCounts, whatsapp] = await Promise.all([
    prisma.business.findFirst({ where: { id: businessId, deletedAt: null }, select: { id:true,name:true,industry:true,description:true,country:true,city:true,address:true,serviceArea:true,phone:true,email:true,website:true,timezone:true,defaultCurrency:true } }),
    getBusinessServiceSummaryForAiContext(businessId), getBusinessAvailabilityForAiContext(businessId), getBusinessPoliciesForAiContext(businessId),
    prisma.businessPolicy.findMany({ where:{ businessId, isArchived:false }, select:{ isActive:true, visibility:true } }),
    prisma.whatsAppIntegration.findFirst({ where:{businessId}, orderBy:{createdAt:"desc"}, select:{status:true, accessTokenEncrypted:true, provider:true} }),
  ]);
  if (!business) throw new AppError(404,"Business not found","BUSINESS_NOT_FOUND");
  const services=serviceSummary.services; const policies=policyContext.policies; const cats=policies.map(p=>p.category);
  const profileScore=(present(business.name)?15:0)+(present(business.industry)?15:0)+(present(business.description)?20:0)+(present(business.country)||present(business.city)?15:0)+(present(business.phone)||present(business.email)?15:0)+(present(business.timezone)?10:0)+(present(business.defaultCurrency)?10:0);
  const readyAi=services.filter(s=>s.readinessStatus===ServiceReadinessStatus.READY_FOR_AI||s.readinessStatus===ServiceReadinessStatus.READY_FOR_BOOKING).length;
  const readyBooking=services.filter(s=>s.readinessStatus===ServiceReadinessStatus.READY_FOR_BOOKING).length;
  const servicesScore=services.length?30+(readyAi?35:0)+(readyBooking?20:0)+(!serviceSummary.gaps.missingPrices.length?10:0)+(!serviceSummary.gaps.missingDurations.length?5:0):0;
  const validHours=availability.weeklyHours.filter(r=>r.isOpen).every(r=>Boolean(r.openTime&&r.closeTime&&r.openTime<r.closeTime));
  const availabilityScore=(present(availability.timezone)?20:0)+(availability.weeklyHours.length===7?30:0)+(availability.summary.openDays?25:0)+(availability.summary.openDays&&validHours?25:0);
  const has=(...x:BusinessPolicyCategory[])=>x.some(c=>cats.includes(c));
  const policiesScore=(policies.length?40:0)+(has(BusinessPolicyCategory.PAYMENT)?15:0)+(has(BusinessPolicyCategory.CANCELLATION,BusinessPolicyCategory.RESCHEDULING)?15:0)+(has(BusinessPolicyCategory.REFUND,BusinessPolicyCategory.DEPOSIT)?15:0)+(has(BusinessPolicyCategory.SERVICE_AREA, BusinessPolicyCategory.TRANSPORTATION)?15:0);
  const connected=whatsapp?.status===WhatsAppIntegrationStatus.CONNECTED||whatsapp?.status===WhatsAppIntegrationStatus.MOCK_CONNECTED;
  const canSend=connected && (whatsapp?.provider==="MOCK_WHATSAPP"||Boolean(whatsapp?.accessTokenEncrypted));
  const whatsappScore=connected?(canSend?100:60):whatsapp?.status===WhatsAppIntegrationStatus.CONNECTING?40:0;
  const overallScore=Math.round(profileScore*.2+servicesScore*.25+availabilityScore*.2+policiesScore*.2+whatsappScore*.15);
  const isAiReady=overallScore>=75&&profileScore>=90&&readyAi>0&&availability.summary.hasCompleteWeeklySchedule&&policies.length>0&&connected;
  const isBookingReady=isAiReady&&readyBooking>0;
  const safe:any[]=[]; const human:any[]=[]; const gaps:any[]=[]; const actions:any[]=[];
  const addGap=(key:string,label:string,description:string,s:"PROFILE"|"SERVICES"|"AVAILABILITY"|"POLICIES"|"WHATSAPP",severity:string,priority:number)=>{gaps.push({key,label,description,section:s,severity,route:route[s]});human.push({key,label,reason:description,severity,route:route[s]});actions.push({key,label,description,route:route[s],priority});};
  if(present(business.name)&&present(business.industry)&&present(business.description))safe.push({key:"business-identity",label:"Business identity",reason:"Business name, industry, and description are configured.",confidence:"HIGH"});
  if(present(business.city)||present(business.country)||present(business.serviceArea))safe.push({key:"business-location",label:"Business location",reason:"Location or service area is configured.",confidence:"HIGH"});
  if(services.length)safe.push({key:"services-offered",label:"Services offered",reason:"At least one active service exists.",confidence:"HIGH"});else addGap("add-services","Add services","No active services are configured.","SERVICES","HIGH",1);
  if(serviceSummary.gaps.missingPrices.length)addGap("add-service-prices","Add prices to services","Some active services are missing prices.","SERVICES","MEDIUM",2);
  if(serviceSummary.gaps.missingDurations.length)addGap("add-service-durations","Add service durations","Some active services are missing durations.","SERVICES","MEDIUM",4);
  if(availability.summary.hasCompleteWeeklySchedule)safe.push({key:"opening-hours",label:"Opening hours",reason:"Weekly availability is configured.",confidence:"HIGH"});else addGap("configure-availability","Configure availability","Weekly availability is missing or incomplete.","AVAILABILITY","MEDIUM",3);
  if(policies.length)safe.push({key:"customer-policies",label:"Customer-facing policies",reason:"Active customer-facing policies are configured.",confidence:"HIGH"});else addGap("add-policies","Add customer policies","No active customer-facing policies are configured.","POLICIES","HIGH",1);
  if(!has(BusinessPolicyCategory.REFUND,BusinessPolicyCategory.DEPOSIT))addGap("add-refund-policy","Add refund policy","No refund or deposit policy is configured.","POLICIES","HIGH",2);
  if(!connected)addGap("connect-whatsapp","Connect WhatsApp","WhatsApp is not connected.","WHATSAPP","HIGH",1);
  actions.sort((a,b)=>a.priority-b.priority||a.key.localeCompare(b.key));
  const priceDisplay=(s:any)=>s.priceType==="FREE"?"Free":s.priceDescription|| (s.basePrice!=null?`${s.currency} ${s.basePrice}`:"Not configured");
  const preview:any={businessId,generatedAt:new Date().toISOString(),readiness:{overallScore,level:isBookingReady?"BOOKING_READY":isAiReady?"AI_READY":overallScore<40?"NOT_READY":"PARTIAL",isAiReady,isBookingReady},sections:{profile:section(profileScore,"Business profile","Business identity and contact readiness.",route.PROFILE),services:section(servicesScore,"Services & Pricing","Active service and pricing readiness.",route.SERVICES),availability:section(availabilityScore,"Availability","Weekly schedule readiness.",route.AVAILABILITY),policies:section(policiesScore,"Policies","Customer-facing policy readiness.",route.POLICIES),whatsapp:section(whatsappScore,"WhatsApp connection","Messaging connection readiness.",route.WHATSAPP)},businessSummary:{name:business.name,industry:business.industry,description:business.description,location:[business.city,business.country].filter(Boolean).join(", ")||undefined,serviceArea:business.serviceArea,phone:business.phone,email:business.email,website:business.website,timezone:business.timezone,currency:business.defaultCurrency},servicesPreview:{total:services.length,active:services.length,readyForAi:readyAi,readyForBooking:readyBooking,missingPrices:serviceSummary.gaps.missingPrices,missingDurations:serviceSummary.gaps.missingDurations,items:services.map(s=>({...s,basePrice:undefined,currency:undefined,priceDisplay:priceDisplay(s)}))},availabilityPreview:{timezone:availability.timezone,hasCompleteWeeklySchedule:availability.summary.hasCompleteWeeklySchedule,openDays:availability.summary.openDays,closedDays:availability.summary.closedDays,gaps:availability.gaps.missingDays},policiesPreview:{total:policyCounts.length,active:policyCounts.filter(p=>p.isActive).length,customerFacing:policies.length,internalOnly:policyCounts.filter(p=>p.isActive&&p.visibility==="INTERNAL_ONLY").length,configuredCategories:[...new Set(cats)],missingRecommendedCategories:policyContext.gaps.missingRecommendedCategories,items:policies.map(({content,...p})=>p)},safeToAnswerTopics:safe,needsHumanConfirmationTopics:human,gaps,recommendedNextActions:actions,aiInstructionsPreview:{canAnswer:safe.map(x=>x.label),shouldAvoid:human.map(x=>x.label),shouldHandoff:["Payment disputes","Price negotiation","Appointment exceptions","Complaints",...human.filter(x=>x.severity==="HIGH").map(x=>x.label)]}};
  return preview;
}
export const businessKnowledgeService={async get(actor:{businessId:string;role:BusinessRole}){if(actor.role===BusinessRole.STAFF)throw new AppError(403,"You do not have permission to view the business knowledge preview.","FORBIDDEN");const cached=await cacheService.get<any>(KEY(actor.businessId));if(cached)return cached;const value=await build(actor.businessId);await cacheService.set(KEY(actor.businessId),value,120);return value;}};
export async function getBusinessKnowledgeForAiContext(businessId:string){const p=await build(businessId);return {business:p.businessSummary,services:p.servicesPreview.items,availability:p.availabilityPreview,policies:p.policiesPreview.items,safeToAnswerTopics:p.safeToAnswerTopics,shouldAvoid:p.aiInstructionsPreview.shouldAvoid,shouldHandoff:p.aiInstructionsPreview.shouldHandoff,gaps:p.gaps};}

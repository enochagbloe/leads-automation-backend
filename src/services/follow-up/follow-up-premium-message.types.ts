import {
  FollowUpContextType,
  PremiumFollowUpGenerationStatus,
  PremiumFollowUpMessageSource,
  PremiumFollowUpSequenceStage,
} from "@prisma/client";
import { PremiumFollowUpContextDecision, PremiumFollowUpPromptVersions } from "./follow-up-premium-decision-context.service";

export type PremiumAppointmentFacts = {
  id: string;
  status: string;
  startTime: string;
  timezone: string;
  location: string | null;
  serviceName: string | null;
} | null;

export type PremiumFollowUpGenerationResult = {
  generationId: string | null;
  generationStatus: Exclude<PremiumFollowUpGenerationStatus, "GENERATING">;
  finalDecision: PremiumFollowUpContextDecision;
  businessId: string | null;
  conversationId: string | null;
  customerId: string | null;
  followUpJobId: string;
  followUpRuleId: string | null;
  contextType: FollowUpContextType | null;
  sequenceStage: PremiumFollowUpSequenceStage;
  successfulAttemptCount: number;
  effectiveAttemptLimit: number;
  generatedMessage: string | null;
  fallbackMessageUsed: boolean;
  messageSource: PremiumFollowUpMessageSource;
  customerGoalUsed: string | null;
  customerObjectionUsed: string | null;
  timingContextUsed: string | null;
  unresolvedRequestUsed: string | null;
  appointmentFactsUsed: PremiumAppointmentFacts;
  promptVersionsUsed: PremiumFollowUpPromptVersions;
  memoryVersionUsed: string | null;
  generationModelUsed: string | null;
  promptConflict: boolean;
  missingKnowledge: boolean;
  validationPassed: boolean;
  validationIssues: string[];
  regenerationAttempted: boolean;
  idempotencyKey: string | null;
  contextVersion: string | null;
  generatedAt: string | null;
};

export type PremiumFollowUpMessageContext = {
  finalDecision: PremiumFollowUpContextDecision;
  contextType: FollowUpContextType;
  sequenceStage: PremiumFollowUpSequenceStage;
  customerName: string | null;
  businessName: string;
  serviceName: string | null;
  customerGoal: string | null;
  customerObjection: string | null;
  timingContext: string | null;
  unresolvedRequest: string | null;
  conversationSummary: string | null;
  appointmentFacts: PremiumAppointmentFacts;
  tone: string | null;
  responseLength: string | null;
  prohibitedPhrases: string[];
  recentMessages: Array<{
    sender: "CUSTOMER" | "STAFF" | "AI" | "SYSTEM";
    content: string;
    createdAt: string;
  }>;
  previousAutomatedMessages: string[];
};

import { AppError } from "../../utils/errors";
import { clearPlaceholders } from "./follow-up.shared";

// Base/shared section: template rendering for all follow-up tiers.
export const followUpTemplateRendererService = {
  render(template: string, context: {
    customerName?: string | null;
    businessName?: string | null;
    serviceName?: string | null;
    appointmentDate?: string | null;
    appointmentTime?: string | null;
    quoteTotal?: string | null;
    paymentLink?: string | null;
  }) {
    const rendered = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => {
      const value = context[key as keyof typeof context];
      return typeof value === "string" && value.trim() ? value.trim() : "";
    });
    const cleaned = clearPlaceholders(rendered);
    if (!cleaned) throw new AppError(422, "Follow-up template could not be rendered.", "TEMPLATE_RENDER_FAILED");
    return cleaned;
  },
};

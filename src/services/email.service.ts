import { Resend } from "resend";
import { env } from "../config/env";

type EmailContent = {
  to: string;
  subject: string;
  html: string;
  text: string;
  type: "email_verification" | "password_reset" | "business_invitation" | "welcome";
};

type ActionTemplateInput = {
  title: string;
  preview: string;
  greetingName: string;
  message: string;
  actionLabel: string;
  actionUrl: string;
  expiryNotice: string;
};

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function actionTemplate(input: ActionTemplateInput) {
  const title = escapeHtml(input.title);
  const preview = escapeHtml(input.preview);
  const greetingName = escapeHtml(input.greetingName);
  const message = escapeHtml(input.message);
  const actionLabel = escapeHtml(input.actionLabel);
  const expiryNotice = escapeHtml(input.expiryNotice);
  const actionUrl = escapeHtml(input.actionUrl);

  return {
    html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f6f8;font-family:Arial,sans-serif;color:#172033;line-height:1.6">
<div style="display:none;max-height:0;overflow:hidden">${preview}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 16px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e6e9ed;border-radius:12px">
<tr><td style="padding:36px">
<p style="margin:0 0 28px;font-size:18px;font-weight:700">BizReply AI</p>
<h1 style="margin:0 0 18px;font-size:26px;line-height:1.25">${title}</h1>
<p style="margin:0 0 12px">Hi ${greetingName},</p>
<p style="margin:0 0 26px">${message}</p>
<p style="margin:0 0 26px"><a href="${actionUrl}" style="display:inline-block;background:#172033;color:#ffffff;padding:13px 20px;text-decoration:none;border-radius:7px;font-weight:700">${actionLabel}</a></p>
<p style="margin:0 0 12px;color:#566071;font-size:14px">${expiryNotice}</p>
<p style="margin:0;color:#566071;font-size:14px">If the button does not work, use this link:</p>
<p style="margin:6px 0 0;word-break:break-all;font-size:13px"><a href="${actionUrl}" style="color:#3157d5">${actionUrl}</a></p>
</td></tr></table>
</td></tr></table>
</body></html>`,
    text: [
      input.title,
      "",
      `Hi ${input.greetingName},`,
      "",
      input.message,
      "",
      `${input.actionLabel}: ${input.actionUrl}`,
      "",
      input.expiryNotice,
    ].join("\n"),
  };
}

function welcomeTemplate(greetingName: string) {
  const name = escapeHtml(greetingName);
  return {
    html: `<!doctype html><html lang="en"><body style="font-family:Arial,sans-serif;color:#172033;line-height:1.6">
<div style="max-width:600px;margin:auto;padding:36px"><p style="font-size:18px;font-weight:700">BizReply AI</p>
<h1>Welcome to BizReply AI</h1><p>Hi ${name},</p>
<p>Your account is ready. We are glad to have you building with BizReply AI.</p></div></body></html>`,
    text: `Welcome to BizReply AI\n\nHi ${greetingName},\n\nYour account is ready. We are glad to have you building with BizReply AI.`,
  };
}

class EmailService {
  private async send(content: EmailContent): Promise<boolean> {
    if (!resend) {
      console.warn("Email send skipped: RESEND_API_KEY is not configured", {
        type: content.type,
        to: content.to,
      });
      return false;
    }

    try {
      const { data, error } = await resend.emails.send({
        from: env.EMAIL_FROM,
        to: content.to,
        subject: content.subject,
        html: content.html,
        text: content.text,
      });

      if (error) {
        console.error("Email send failed", {
          type: content.type,
          to: content.to,
          errorName: error.name,
          errorMessage: error.message,
        });
        return false;
      }

      console.info("Email sent", { type: content.type, to: content.to, messageId: data?.id });
      return true;
    } catch (error) {
      console.error("Email send failed", {
        type: content.type,
        to: content.to,
        errorMessage: error instanceof Error ? error.message : "Unknown provider error",
      });
      return false;
    }
  }

  sendVerification(to: string, businessName: string, token: string) {
    const actionUrl = `${env.FRONTEND_URL}/verify-email?token=${encodeURIComponent(token)}`;
    const template = actionTemplate({
      title: "Verify your email",
      preview: "Confirm your email to activate your BizReply AI account.",
      greetingName: businessName,
      message: "Confirm your email address to activate your BizReply AI account.",
      actionLabel: "Verify email",
      actionUrl,
      expiryNotice: "This verification link expires in 24 hours and can only be used once.",
    });
    return this.send({ to, subject: "Verify your BizReply AI email", type: "email_verification", ...template });
  }

  sendPasswordReset(to: string, businessName: string, token: string) {
    const actionUrl = `${env.FRONTEND_URL}/reset-password?token=${encodeURIComponent(token)}`;
    const template = actionTemplate({
      title: "Reset your password",
      preview: "Use this secure link to reset your BizReply AI password.",
      greetingName: businessName,
      message: "Use the secure link below to choose a new password. Ignore this email if you did not request a reset.",
      actionLabel: "Reset password",
      actionUrl,
      expiryNotice: "This password reset link expires in 30 minutes and can only be used once.",
    });
    return this.send({ to, subject: "Reset your BizReply AI password", type: "password_reset", ...template });
  }

  sendWelcome(to: string, businessName: string) {
    const template = welcomeTemplate(businessName);
    return this.send({ to, subject: "Welcome to BizReply AI", type: "welcome", ...template });
  }

  sendBusinessInvitation(to: string, businessName: string, role: string, token: string) {
    const actionUrl = `${env.FRONTEND_URL}/accept-invite?token=${encodeURIComponent(token)}`;
    const template = actionTemplate({
      title: `Join ${businessName}`,
      preview: `You have been invited to join ${businessName} on BizReply AI.`,
      greetingName: to,
      message: `You have been invited to join ${businessName} as ${role.toLowerCase().replace("_", " ")}.`,
      actionLabel: "Accept invitation",
      actionUrl,
      expiryNotice: "This invitation expires in 7 days and can only be used once.",
    });
    return this.send({ to, subject: `Join ${businessName} on BizReply AI`, type: "business_invitation", ...template });
  }
}

export const emailService = new EmailService();

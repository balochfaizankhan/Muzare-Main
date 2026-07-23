import nodemailer from "nodemailer";
import { config, smtpConfigured } from "./config.js";

type SendInviteEmailInput = {
  to: string;
  workspaceName: string;
  inviterName: string;
  inviterEmail: string;
  roleLabel: string;
  invitationUrl: string;
  expiresAt: Date;
};

type EmailSendResult =
  | { configured: false; sent: false; warning: string }
  | { configured: true; sent: true }
  | { configured: true; sent: false; warning: string };

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (!smtpConfigured) return null;
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: Number(config.SMTP_PORT) === 465,
    auth: config.SMTP_USER ? {
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
    } : undefined,
  });
  return transporter;
}

type SendAccountApprovedEmailInput = {
  to: string;
  displayName: string;
  loginUrl: string;
};

type SendAccountRejectedEmailInput = {
  to: string;
  displayName: string;
};

export async function sendAccountApprovedEmail(input: SendAccountApprovedEmailInput): Promise<EmailSendResult> {
  const transport = getTransporter();
  if (!transport) {
    return { configured: false, sent: false, warning: "Account approved, but email is not configured." };
  }
  try {
    await transport.sendMail({
      from: config.SMTP_FROM,
      to: input.to,
      subject: "Your Muzare account has been approved",
      text: [
        `Hi ${input.displayName},`,
        "Your Muzare account request has been approved. You can now sign in and set up your workspace.",
        `Sign in: ${input.loginUrl}`,
      ].join("\n"),
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #102a2a;">
          <h2 style="margin-bottom: 8px;">Your account has been approved</h2>
          <p style="margin: 0 0 12px;">Hi ${input.displayName}, your Muzare account request has been approved. You can now sign in and set up your workspace.</p>
          <p style="margin: 0 0 16px;">
            <a href="${input.loginUrl}" style="display:inline-block;background:#1f7a2e;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;">Sign In</a>
          </p>
        </div>
      `,
    });
    return { configured: true, sent: true };
  } catch (error) {
    console.error("ACCOUNT_APPROVED_EMAIL_ERROR", error);
    return { configured: true, sent: false, warning: "Account approved, but the notification email could not be sent." };
  }
}

export async function sendAccountRejectedEmail(input: SendAccountRejectedEmailInput): Promise<EmailSendResult> {
  const transport = getTransporter();
  if (!transport) {
    return { configured: false, sent: false, warning: "Account rejected, but email is not configured." };
  }
  try {
    await transport.sendMail({
      from: config.SMTP_FROM,
      to: input.to,
      subject: "Your Muzare account request",
      text: [
        `Hi ${input.displayName},`,
        "Your Muzare account request was not approved at this time.",
      ].join("\n"),
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #102a2a;">
          <h2 style="margin-bottom: 8px;">Your account request was not approved</h2>
          <p style="margin: 0;">Hi ${input.displayName}, your Muzare account request was not approved at this time.</p>
        </div>
      `,
    });
    return { configured: true, sent: true };
  } catch (error) {
    console.error("ACCOUNT_REJECTED_EMAIL_ERROR", error);
    return { configured: true, sent: false, warning: "Account rejected, but the notification email could not be sent." };
  }
}

export async function sendWorkspaceInvitationEmail(input: SendInviteEmailInput): Promise<EmailSendResult> {
  const transport = getTransporter();
  if (!transport) {
    return {
      configured: false,
      sent: false,
      warning: "Invite created, but email is not configured. Share the link manually.",
    };
  }

  try {
    await transport.sendMail({
      from: config.SMTP_FROM,
      to: input.to,
      subject: `You're invited to join ${input.workspaceName} on Muzare`,
      text: [
        `You've been invited to join ${input.workspaceName} on Muzare.`,
        `Invited by: ${input.inviterName} <${input.inviterEmail}>`,
        `Role: ${input.roleLabel}`,
        `Accept invitation: ${input.invitationUrl}`,
        `This invitation expires on ${input.expiresAt.toLocaleString("en-GB")}.`,
      ].join("\n"),
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #102a2a;">
          <h2 style="margin-bottom: 8px;">You're invited to join ${input.workspaceName}</h2>
          <p style="margin: 0 0 12px;">${input.inviterName} (${input.inviterEmail}) invited you to join the workspace as <strong>${input.roleLabel}</strong>.</p>
          <p style="margin: 0 0 16px;">
            <a href="${input.invitationUrl}" style="display:inline-block;background:#1f7a2e;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;">Accept Invitation</a>
          </p>
          <p style="margin: 0 0 8px;">If the button doesn't work, use this link:</p>
          <p style="margin: 0 0 12px; word-break: break-all;">${input.invitationUrl}</p>
          <p style="margin: 0;">This invitation expires on ${input.expiresAt.toLocaleString("en-GB")}.</p>
        </div>
      `,
    });
    return { configured: true, sent: true };
  } catch (error) {
    console.error("WORKSPACE_INVITE_EMAIL_ERROR", error);
    return {
      configured: true,
      sent: false,
      warning: "Invite created, but the email could not be sent. Share the link manually.",
    };
  }
}

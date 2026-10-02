import "server-only";
import { Resend } from "resend";
import { env } from "@/server/env";
import { PermanentJobError } from "@/server/jobs/types";

export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: string; contentType: string }[];
  /** Sent as the Resend Idempotency-Key header so job retries never send twice. */
  idempotencyKey: string;
  /** Short label for logs, e.g. the template name. */
  tag: string;
};

export type SendResult = { id: string | null; skipped: boolean };

export type EmailTransport = (email: OutgoingEmail) => Promise<SendResult>;

let override: EmailTransport | null = null;

/** For tests: capture outgoing email instead of calling Resend. Pass null to restore. */
export function setEmailTransport(transport: EmailTransport | null): void {
  override = transport;
}

/** "j***@example.com": enough to correlate logs without storing the address. */
export function redactEmail(address: string): string {
  const [local, domain] = address.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

// Resend error names that will not succeed on retry.
const PERMANENT = new Set([
  "validation_error",
  "invalid_from_address",
  "invalid_attachment",
  "invalid_parameter",
  "missing_required_field",
  "invalid_idempotent_request",
  "restricted_api_key",
  "invalid_api_key",
]);

/**
 * Sends one email with Resend. Without RESEND_API_KEY (until the owner configures Resend)
 * it logs a redacted line and reports success, so jobs complete normally.
 */
export async function sendEmail(email: OutgoingEmail): Promise<SendResult> {
  if (override) return override(email);
  const e = env();
  if (!e.RESEND_API_KEY) {
    console.info(`[email] RESEND_API_KEY not set; not sent: ${email.tag} to ${redactEmail(email.to)}`);
    return { id: null, skipped: true };
  }
  const resend = new Resend(e.RESEND_API_KEY);
  const { data, error } = await resend.emails.send(
    {
      from: e.EMAIL_FROM,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: email.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content, "utf8"),
        contentType: a.contentType,
      })),
      tags: [{ name: "template", value: email.tag.replace(/[^A-Za-z0-9_-]/g, "_") }],
    },
    { idempotencyKey: email.idempotencyKey },
  );
  if (error) {
    const message = `Resend ${error.name}: ${error.message}`.slice(0, 500);
    if (PERMANENT.has(error.name)) throw new PermanentJobError(message);
    throw new Error(message);
  }
  return { id: data?.id ?? null, skipped: false };
}

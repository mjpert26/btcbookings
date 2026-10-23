/**
 * Reminder choices for the booking page editor. Shared by the client form and the server
 * action so the labels and allowed values stay in one place.
 */

export const MERCHANT_REMINDER_CHANNELS = [
  { value: "email", label: "Email" },
  { value: "sms", label: "Text message (SMS)" },
] as const;

export const AGENT_REMINDER_CHANNELS = [
  { value: "email", label: "Email" },
  { value: "slack", label: "Slack direct message" },
  { value: "sms", label: "Text message (SMS)" },
] as const;

export const AGENT_REMINDER_CHOICES = [
  { value: 5, label: "5 minutes before" },
  { value: 15, label: "15 minutes before" },
  { value: 30, label: "30 minutes before" },
  { value: 60, label: "1 hour before" },
  { value: 1440, label: "1 day before" },
] as const;

export type MerchantChannelValue = (typeof MERCHANT_REMINDER_CHANNELS)[number]["value"];
export type AgentChannelValue = (typeof AGENT_REMINDER_CHANNELS)[number]["value"];

/** Defaults for a new booking page: merchant email reminders only. */
export const DEFAULT_MERCHANT_CHANNELS: MerchantChannelValue[] = ["email"];
export const DEFAULT_AGENT_CHANNELS: AgentChannelValue[] = [];
export const DEFAULT_AGENT_OFFSETS: number[] = [15];

/**
 * Job kinds and their payloads. This is the contract between the module that enqueues a
 * job and the module that handles it. Payloads carry ids only; handlers load fresh state.
 *
 * | kind                      | handler module       | enqueued by                        |
 * |---------------------------|----------------------|------------------------------------|
 * | graph_event_upsert        | graph                | booking (create, reschedule)        |
 * | graph_event_delete        | graph                | booking (cancel, host change)       |
 * | graph_subscription_ensure | graph                | sign-in, renewal cron               |
 * | graph_delta_sync          | graph                | notifications, delta cron           |
 * | email_send                | email                | booking, graph conflict detection   |
 * | sf_lead_create            | salesforce           | booking (on confirm, if enabled)    |
 * | slack_membership_sync     | slack                | membership changes (any source)     |
 * | booking_reassign          | booking              | queue sync (removal_policy=reassign)|
 */
export type JobPayloads = {
  graph_event_upsert: { bookingId: string };
  graph_event_delete: { bookingId: string; userId: string; graphEventId: string | null };
  graph_subscription_ensure: { userId: string };
  graph_delta_sync: { userId: string };
  email_send: {
    template:
      | "booking_confirmed"
      | "booking_rescheduled"
      | "booking_cancelled"
      | "booking_reminder"
      | "host_conflict_flagged"
      | "host_booking_notice";
    bookingId: string;
    /** "invitee" or a user id for host-facing mail. */
    recipient: "invitee" | { userId: string };
    /** Reminder offset in minutes, for booking_reminder. */
    offsetMin?: number;
  };
  sf_lead_create: { bookingId: string };
  slack_membership_sync: { teamId: string; teamMemberId: string };
  booking_reassign: { bookingId: string; fromUserId: string; reason: string };
};

export type JobKind = keyof JobPayloads;

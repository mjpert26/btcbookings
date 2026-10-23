import "server-only";
import { z } from "zod";
import { can, type Capability } from "@/lib/permissions";
import type { Caller } from "@/server/api/context";
import { cancelBooking, getBooking, listBookings, listBookingsSchema, rescheduleBooking, scheduleBooking, scheduleSchema } from "@/server/api/services/bookings";
import {
  availableSlots,
  changeQuestions,
  createEventType,
  createEventTypeSchema,
  deleteEventType,
  getEventType,
  listEventTypes,
  listEventTypesSchema,
  slotsQuerySchema,
  updateEventType,
  updateEventTypeSchema,
} from "@/server/api/services/eventTypes";
import {
  addTeamMember,
  createUser,
  createUserSchema,
  getTeam,
  listAudit,
  listAuditSchema,
  listTeams,
  listUsers,
  listUsersSchema,
  removeTeamMember,
  updateUser,
  updateUserSchema,
  whoAmI,
} from "@/server/api/services/directory";

/**
 * MCP tools. Each tool runs as the signed-in user through the shared API services, so row-level
 * security and the permission matrix apply exactly as in the web app. Tools that need a
 * capability the caller's role lacks are not listed and are refused if called.
 */

export type ToolDef = {
  name: string;
  title: string;
  description: string;
  input: z.ZodType;
  capability?: Capability;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run: (caller: Caller, args: never) => Promise<unknown>;
};

const id = (what: string) => z.string().uuid().describe(`${what} id (UUID)`);
const questionSchema = z.object({
  key: z.string().describe("Lowercase key, letters, numbers and underscores, starting with a letter"),
  type: z.enum(["text", "textarea", "phone", "email", "dropdown", "checkbox"]),
  label: z.object({ en: z.string().optional(), es: z.string().optional() }).describe("Label in English and/or Spanish"),
  required: z.boolean().optional(),
  options: z.array(z.object({ value: z.string(), label: z.object({ en: z.string().optional(), es: z.string().optional() }) })).optional().describe("Dropdown options"),
});

function tool<S extends z.ZodType>(def: Omit<ToolDef, "input" | "run"> & { input: S; run: (caller: Caller, args: z.output<S>) => Promise<unknown> }): ToolDef {
  return def as unknown as ToolDef;
}

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

export const TOOLS: ToolDef[] = [
  tool({
    name: "whoami",
    title: "Who am I",
    description: "Returns the signed-in user, their role (Admin, Manager or Agent), capabilities and teams.",
    input: z.object({}),
    annotations: READ,
    run: (caller) => whoAmI(caller),
  }),
  tool({
    name: "list_bookings",
    title: "List bookings",
    description:
      "Lists bookings the user may see, soonest first. Agents see only bookings where they are a host; managers and admins see all (use mine=true for only their own). Times are ISO 8601 in UTC.",
    input: listBookingsSchema.partial({ limit: true, offset: true }),
    annotations: READ,
    run: (caller, args) => listBookings(caller, args),
  }),
  tool({
    name: "get_booking",
    title: "Get booking",
    description: "Returns one booking with hosts, the invitee's answers and its history.",
    input: z.object({ bookingId: id("Booking") }),
    annotations: READ,
    run: (caller, args) => getBooking(caller, args.bookingId),
  }),
  tool({
    name: "find_available_times",
    title: "Find available times",
    description: "Lists open start times on a booking page between two instants (at most 62 days). Use before schedule_meeting.",
    input: slotsQuerySchema.extend({ eventTypeId: id("Booking page") }),
    annotations: READ,
    run: (caller, args) => availableSlots(caller, args.eventTypeId, { from: args.from, to: args.to, durationMin: args.durationMin }),
  }),
  tool({
    name: "schedule_meeting",
    title: "Schedule a meeting",
    description:
      "Books a meeting on an active booking page for an invitee, exactly like booking on the public page: the host's Outlook calendar is updated and the invitee receives the confirmation email. Pick a start time from find_available_times.",
    input: scheduleSchema,
    annotations: { ...WRITE, openWorldHint: true },
    run: (caller, args) => scheduleBooking(caller, args),
  }),
  tool({
    name: "cancel_booking",
    title: "Cancel a booking",
    description: "Cancels a booking as its host (or page owner, team admin or admin). The invitee is notified and the Outlook event is removed.",
    input: z.object({ bookingId: id("Booking"), reason: z.string().max(500).optional() }),
    annotations: { ...DESTRUCTIVE, openWorldHint: true },
    run: (caller, args) => cancelBooking(caller, args.bookingId, args.reason ?? null),
  }),
  tool({
    name: "reschedule_booking",
    title: "Reschedule a booking",
    description: "Moves a booking to a new start time. The invitee and hosts are notified and Outlook is updated. Returns the new booking.",
    input: z.object({ bookingId: id("Booking"), start: z.iso.datetime({ offset: true }) }),
    annotations: { ...WRITE, openWorldHint: true },
    run: (caller, args) => rescheduleBooking(caller, args.bookingId, { start: args.start }),
  }),
  tool({
    name: "list_booking_pages",
    title: "List booking pages",
    description: "Lists booking pages (event types) the user can see, with their public URLs. Agents see their own and their teams' pages.",
    input: listEventTypesSchema.partial({ limit: true, offset: true }),
    annotations: READ,
    run: (caller, args) => listEventTypes(caller, args),
  }),
  tool({
    name: "get_booking_page",
    title: "Get booking page",
    description: "Returns a booking page's settings, questions and hosts.",
    input: z.object({ eventTypeId: id("Booking page") }),
    annotations: READ,
    run: (caller, args) => getEventType(caller, args.eventTypeId),
  }),
  tool({
    name: "create_booking_page",
    title: "Create a booking page",
    description:
      "Creates a booking page for the user, for a team they manage (teamId), or, for admins, for another user (ownerUserId). New pages are inactive unless isActive is true.",
    input: createEventTypeSchema,
    annotations: WRITE,
    run: (caller, args) => createEventType(caller, args),
  }),
  tool({
    name: "update_booking_page",
    title: "Update a booking page",
    description: "Changes any subset of a booking page's settings, including turning it on or off (isActive).",
    input: z.object({ eventTypeId: id("Booking page"), changes: updateEventTypeSchema }),
    annotations: WRITE,
    run: (caller, args) => updateEventType(caller, args.eventTypeId, args.changes),
  }),
  tool({
    name: "delete_booking_page",
    title: "Delete a booking page",
    description: "Deletes a booking page that has no bookings. Pages with bookings must be deactivated instead.",
    input: z.object({ eventTypeId: id("Booking page") }),
    annotations: DESTRUCTIVE,
    run: async (caller, args) => {
      await deleteEventType(caller, args.eventTypeId);
      return { deleted: true };
    },
  }),
  tool({
    name: "add_question",
    title: "Add a booking question",
    description: "Adds a question to a booking page's form, optionally at a position (0 = first).",
    input: z.object({ eventTypeId: id("Booking page"), question: questionSchema, position: z.number().int().min(0).optional() }),
    annotations: WRITE,
    run: (caller, args) => changeQuestions(caller, args.eventTypeId, { kind: "add", question: args.question, position: args.position }),
  }),
  tool({
    name: "update_question",
    title: "Update a booking question",
    description: "Changes a question's label, type, options or whether it is required.",
    input: z.object({ eventTypeId: id("Booking page"), key: z.string(), changes: questionSchema.partial() }),
    annotations: WRITE,
    run: (caller, args) => changeQuestions(caller, args.eventTypeId, { kind: "update", key: args.key, changes: args.changes }),
  }),
  tool({
    name: "remove_question",
    title: "Remove a booking question",
    description: "Removes a question from a booking page's form. Answers already given are kept on past bookings.",
    input: z.object({ eventTypeId: id("Booking page"), key: z.string() }),
    annotations: DESTRUCTIVE,
    run: (caller, args) => changeQuestions(caller, args.eventTypeId, { kind: "remove", key: args.key }),
  }),
  tool({
    name: "set_questions",
    title: "Replace booking questions",
    description: "Replaces the whole question list (also used to reorder).",
    input: z.object({ eventTypeId: id("Booking page"), questions: z.array(questionSchema).max(30) }),
    annotations: WRITE,
    run: (caller, args) => changeQuestions(caller, args.eventTypeId, { kind: "replace", questions: args.questions }),
  }),
  tool({
    name: "list_teams",
    title: "List teams",
    description: "Lists teams (partner groups) with member and page counts.",
    input: z.object({}),
    annotations: READ,
    run: (caller) => listTeams(caller),
  }),
  tool({
    name: "get_team",
    title: "Get team",
    description: "Returns a team's members and admins.",
    input: z.object({ teamId: id("Team") }),
    annotations: READ,
    run: (caller, args) => getTeam(caller, args.teamId),
  }),
  tool({
    name: "add_team_member",
    title: "Add a team member",
    description: "Adds a rep to a team by company email (team admins and admins). Salesforce queue-driven teams follow their sync rules.",
    input: z.object({ teamId: id("Team"), email: z.string().email() }),
    annotations: WRITE,
    run: (caller, args) => addTeamMember(caller, args.teamId, { email: args.email }),
  }),
  tool({
    name: "remove_team_member",
    title: "Remove a team member",
    description: "Removes a manually added rep from a team (team admins and admins). Queue members are managed in Salesforce.",
    input: z.object({ teamId: id("Team"), teamMemberId: id("Team member") }),
    annotations: DESTRUCTIVE,
    run: async (caller, args) => {
      await removeTeamMember(caller, args.teamId, args.teamMemberId);
      return { removed: true };
    },
  }),
  tool({
    name: "list_users",
    title: "List users",
    description: "Lists users with their roles and whether they have signed in and connected Outlook.",
    input: listUsersSchema.partial({ limit: true, offset: true }),
    annotations: READ,
    run: (caller, args) => listUsers(caller, args),
  }),
  tool({
    name: "create_user",
    title: "Add a user",
    description: "Pre-provisions a user by company email (admins only). They link their Microsoft account on first sign-in.",
    input: createUserSchema,
    capability: "users.manage",
    annotations: WRITE,
    run: (caller, args) => createUser(caller, args),
  }),
  tool({
    name: "update_user",
    title: "Update a user",
    description: "Changes a user's name, role (admin, manager, user) or active state (admins only).",
    input: z.object({ userId: id("User"), changes: updateUserSchema }),
    capability: "users.manage",
    annotations: WRITE,
    run: (caller, args) => updateUser(caller, args.userId, args.changes),
  }),
  tool({
    name: "list_audit_log",
    title: "Audit log",
    description: "Searches the audit log of changes (managers and admins).",
    input: listAuditSchema.partial({ limit: true, offset: true }),
    capability: "audit.read",
    annotations: READ,
    run: (caller, args) => listAudit(caller, args),
  }),
];

export function toolsFor(caller: Caller): ToolDef[] {
  return TOOLS.filter((t) => !t.capability || can(caller.user.role, t.capability));
}

export function inputJsonSchema(t: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  if (schema.type !== "object") return { type: "object", properties: {}, additionalProperties: true };
  return schema;
}

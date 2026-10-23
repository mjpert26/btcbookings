import "server-only";
import { z } from "zod";
import { env } from "@/server/env";
import { listBookingsSchema, scheduleSchema } from "@/server/api/services/bookings";
import { createEventTypeSchema, listEventTypesSchema, slotsQuerySchema, updateEventTypeSchema } from "@/server/api/services/eventTypes";
import { createUserSchema, listAuditSchema, listUsersSchema, updateUserSchema } from "@/server/api/services/directory";

/** OpenAPI 3.1 description of /api/v1, generated from the same zod schemas the endpoints validate with. */

function schema(s: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

function queryParams(s: z.ZodObject): Record<string, unknown>[] {
  return Object.entries(s.shape).map(([name, field]) => ({ name, in: "query", required: false, schema: schema(field as z.ZodType) }));
}

const idParam = (name: string, what: string) => ({ name, in: "path", required: true, description: `${what} id`, schema: { type: "string", format: "uuid" } });
const json = (s: z.ZodType) => ({ required: true, content: { "application/json": { schema: schema(s) } } });
const ok = (description: string) => ({
  description,
  content: { "application/json": { schema: { type: "object", properties: { data: {} } } } },
});
const errors = {
  "400": { $ref: "#/components/responses/Error" },
  "401": { $ref: "#/components/responses/Error" },
  "403": { $ref: "#/components/responses/Error" },
  "404": { $ref: "#/components/responses/Error" },
  "409": { $ref: "#/components/responses/Error" },
  "429": { $ref: "#/components/responses/Error" },
};

export function openApiDocument() {
  const question = schema(
    z.object({
      key: z.string(),
      type: z.enum(["text", "textarea", "phone", "email", "dropdown", "checkbox"]),
      label: z.object({ en: z.string().optional(), es: z.string().optional() }),
      required: z.boolean().optional(),
      options: z.array(z.object({ value: z.string(), label: z.object({ en: z.string().optional(), es: z.string().optional() }) })).optional(),
    }),
  );
  return {
    openapi: "3.1.0",
    info: {
      title: "BTC Scheduler API",
      version: "1.0.0",
      description:
        "Schedule meetings and manage users, booking pages, questions and teams. Every request acts as the API key's user with that user's role: agents see and change only their own data, managers read everything, admins manage everything. Responses wrap results in { data }.",
    },
    servers: [{ url: `${env().APP_BASE_URL}/api/v1` }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "An API key from Settings > Integrations (btc_pat_...)." } },
      responses: {
        Error: {
          description: "Error",
          content: {
            "application/json": {
              schema: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: { type: "object" } } } } },
            },
          },
        },
      },
    },
    paths: {
      "/me": { get: { summary: "The current user, role and capabilities", responses: { "200": ok("User"), ...errors } } },
      "/bookings": {
        get: { summary: "List bookings visible to the caller", parameters: queryParams(listBookingsSchema), responses: { "200": ok("Bookings"), ...errors } },
        post: { summary: "Schedule a meeting on an active booking page", requestBody: json(scheduleSchema), responses: { "201": ok("Booking"), ...errors } },
      },
      "/bookings/{id}": { get: { summary: "Get a booking", parameters: [idParam("id", "Booking")], responses: { "200": ok("Booking"), ...errors } } },
      "/bookings/{id}/cancel": {
        post: {
          summary: "Cancel a booking (the invitee is notified)",
          parameters: [idParam("id", "Booking")],
          requestBody: json(z.object({ reason: z.string().max(500).optional() })),
          responses: { "200": ok("Booking"), ...errors },
        },
      },
      "/bookings/{id}/reschedule": {
        post: {
          summary: "Move a booking to a new time (returns the new booking)",
          parameters: [idParam("id", "Booking")],
          requestBody: json(z.object({ start: z.iso.datetime({ offset: true }) })),
          responses: { "200": ok("Booking"), ...errors },
        },
      },
      "/event-types": {
        get: { summary: "List booking pages", parameters: queryParams(listEventTypesSchema), responses: { "200": ok("Booking pages"), ...errors } },
        post: { summary: "Create a booking page", requestBody: json(createEventTypeSchema), responses: { "201": ok("Booking page"), ...errors } },
      },
      "/event-types/{id}": {
        get: { summary: "Get a booking page", parameters: [idParam("id", "Booking page")], responses: { "200": ok("Booking page"), ...errors } },
        patch: { summary: "Update a booking page", parameters: [idParam("id", "Booking page")], requestBody: json(updateEventTypeSchema), responses: { "200": ok("Booking page"), ...errors } },
        delete: { summary: "Delete a booking page without bookings", parameters: [idParam("id", "Booking page")], responses: { "204": { description: "Deleted" }, ...errors } },
      },
      "/event-types/{id}/slots": {
        get: { summary: "Open start times", parameters: [idParam("id", "Booking page"), ...queryParams(slotsQuerySchema)], responses: { "200": ok("Slots"), ...errors } },
      },
      "/event-types/{id}/questions": {
        get: { summary: "List questions", parameters: [idParam("id", "Booking page")], responses: { "200": ok("Questions"), ...errors } },
        post: {
          summary: "Add a question",
          parameters: [idParam("id", "Booking page")],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["question"], properties: { question, position: { type: "integer", minimum: 0 } } } } } },
          responses: { "201": ok("Questions"), ...errors },
        },
        put: {
          summary: "Replace all questions (also reorders)",
          parameters: [idParam("id", "Booking page")],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["questions"], properties: { questions: { type: "array", items: question } } } } } },
          responses: { "200": ok("Questions"), ...errors },
        },
      },
      "/event-types/{id}/questions/{key}": {
        patch: {
          summary: "Update a question",
          parameters: [idParam("id", "Booking page"), { name: "key", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: question } } },
          responses: { "200": ok("Questions"), ...errors },
        },
        delete: {
          summary: "Remove a question",
          parameters: [idParam("id", "Booking page"), { name: "key", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": ok("Questions"), ...errors },
        },
      },
      "/teams": { get: { summary: "List teams", responses: { "200": ok("Teams"), ...errors } } },
      "/teams/{id}": { get: { summary: "Get a team with members", parameters: [idParam("id", "Team")], responses: { "200": ok("Team"), ...errors } } },
      "/teams/{id}/members": {
        post: { summary: "Add a team member by email", parameters: [idParam("id", "Team")], requestBody: json(z.object({ email: z.string().email() })), responses: { "201": ok("Member"), ...errors } },
      },
      "/teams/{id}/members/{memberId}": {
        delete: { summary: "Remove a manually added team member", parameters: [idParam("id", "Team"), idParam("memberId", "Team member")], responses: { "204": { description: "Removed" }, ...errors } },
      },
      "/users": {
        get: { summary: "User directory", parameters: queryParams(listUsersSchema), responses: { "200": ok("Users"), ...errors } },
        post: { summary: "Pre-provision a user (admins)", requestBody: json(createUserSchema), responses: { "201": ok("User"), ...errors } },
      },
      "/users/{id}": {
        patch: { summary: "Change name, role or active state (admins)", parameters: [idParam("id", "User")], requestBody: json(updateUserSchema), responses: { "200": ok("User"), ...errors } },
      },
      "/audit": { get: { summary: "Audit log (managers and admins)", parameters: queryParams(listAuditSchema), responses: { "200": ok("Entries"), ...errors } } },
    },
  };
}

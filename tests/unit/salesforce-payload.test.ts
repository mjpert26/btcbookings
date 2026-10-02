import { describe, expect, it } from "vitest";
import {
  buildLeadPayload,
  isSalesforceId,
  isValidFieldApiName,
  SfSettingsError,
  splitName,
  validateFieldMapping,
  type LeadBuildInput,
} from "@/server/salesforce/settings";

const ISO = "001Hp00002abcdeIAA";
const USER = "005Hp00000AbCdEIAA";
const QUEUE = "00GHp000001AbCd";

function input(over: Partial<LeadBuildInput> = {}, settings: Partial<LeadBuildInput["settings"]> = {}): LeadBuildInput {
  return {
    booking: {
      id: "11111111-1111-4111-8111-111111111111",
      startAt: new Date("2026-10-05T14:00:00Z"),
      endAt: new Date("2026-10-05T14:30:00Z"),
      inviteeName: "Maria Garcia Lopez",
      inviteeEmail: "maria@example.com",
      inviteePhone: "+1 305 555 0100",
      inviteeTimezone: "America/New_York",
      language: "es",
    },
    eventTypeName: "Consulta",
    host: { email: "rep@bigthinkcapital.com", name: "Rep One" },
    answers: {},
    ...over,
    settings: {
      field_mapping: {},
      static_values: {},
      campaign_id: null,
      owner_mode: "assigned_host",
      owner_fixed_id: null,
      create_task: false,
      create_note: false,
      set_meeting_booked_fields: false,
      ...settings,
    },
  };
}

describe("splitName", () => {
  it("handles common shapes", () => {
    expect(splitName("Maria Garcia Lopez")).toEqual({ firstName: "Maria", lastName: "Garcia Lopez" });
    expect(splitName("  Cher  ")).toEqual({ firstName: null, lastName: "Cher" });
    expect(splitName("John   Smith")).toEqual({ firstName: "John", lastName: "Smith" });
    expect(splitName("   ")).toEqual({ firstName: null, lastName: "Unknown" });
    expect(splitName("José Núñez")).toEqual({ firstName: "José", lastName: "Núñez" });
  });
});

describe("buildLeadPayload", () => {
  it("maps built-ins and question answers through field_mapping", () => {
    const p = buildLeadPayload(
      input(
        { answers: { company: "Acme LLC", revenue: "50000", notes: "Call after 5" } },
        {
          field_mapping: {
            "q:company": "Company",
            "q:revenue": "csbs__Monthly_Revenue__c",
            "q:notes": "Note__c",
            language_name: "Customers_Preferred_Language__c",
            booking_start: "Meeting_booked_time__c",
            booking_start_local: "Description",
            event_type_name: "Interested_In__c",
          },
        },
      ),
    );
    expect(p.lead).toMatchObject({
      FirstName: "Maria",
      LastName: "Garcia Lopez",
      Email: "maria@example.com",
      Phone: "+1 305 555 0100",
      Company: "Acme LLC",
      csbs__Monthly_Revenue__c: "50000",
      Note__c: "Call after 5",
      Customers_Preferred_Language__c: "Spanish",
      Meeting_booked_time__c: "2026-10-05T14:00:00Z",
      Description: "Mon, 10/05/2026, 10:00 AM EDT",
      Interested_In__c: "Consulta",
    });
    expect(p.idempotencyKey).toBe(p.bookingId);
    expect(p.source).toBe("btc-scheduler");
    expect(p.meeting).toEqual({
      startUtc: "2026-10-05T14:00:00Z",
      endUtc: "2026-10-05T14:30:00Z",
      eventTypeName: "Consulta",
      hostEmail: "rep@bigthinkcapital.com",
      hostName: "Rep One",
      isReschedule: false,
    });
  });

  it("lets static values override mapped values and sets the ISO", () => {
    const p = buildLeadPayload(
      input(
        { answers: { source: "Google" } },
        {
          field_mapping: { "q:source": "LeadSource" },
          static_values: { LeadSource: "BTC Lead Engine", csbs__ISO__c: ISO, Status: "Open - Not Contacted" },
        },
      ),
    );
    expect(p.lead.LeadSource).toBe("BTC Lead Engine");
    expect(p.lead.csbs__ISO__c).toBe(ISO);
    expect(p.lead.Status).toBe("Open - Not Contacted");
  });

  it("skips empty mapped answers and null statics", () => {
    const p = buildLeadPayload(
      input({ answers: { company: "  " } }, { field_mapping: { "q:company": "Company", "q:missing": "Title" }, static_values: { Title: null } }),
    );
    expect(p.lead.Company).toBe("Unknown");
    expect(p.lead).not.toHaveProperty("Title");
  });

  it("falls back to a company-like answer for Company", () => {
    expect(buildLeadPayload(input({ answers: { business_name: "Joe's Pizza" } })).lead.Company).toBe("Joe's Pizza");
    expect(buildLeadPayload(input()).lead.Company).toBe("Unknown");
  });

  it("uses a single name as LastName and omits FirstName and empty phone", () => {
    const p = buildLeadPayload(input({ booking: { ...input().booking, inviteeName: "Madonna", inviteePhone: "" } }));
    expect(p.lead.LastName).toBe("Madonna");
    expect(p.lead).not.toHaveProperty("FirstName");
    expect(p.lead).not.toHaveProperty("Phone");
  });

  it("truncates standard fields to Salesforce limits", () => {
    const long = "A".repeat(60) + " " + "B".repeat(100);
    const p = buildLeadPayload(input({ booking: { ...input().booking, inviteeName: long } }));
    expect(String(p.lead.FirstName)).toHaveLength(40);
    expect(String(p.lead.LastName)).toHaveLength(80);
  });

  it("supports each owner mode", () => {
    const host = buildLeadPayload(input());
    expect(host.owner).toEqual({ mode: "assigned_host", ownerEmail: "rep@bigthinkcapital.com" });
    expect(host.autoAssign).toBe(false);

    const fixed = buildLeadPayload(input({}, { owner_mode: "fixed", owner_fixed_id: QUEUE }));
    expect(fixed.owner).toEqual({ mode: "fixed", ownerId: QUEUE });
    expect(fixed.autoAssign).toBe(false);
    expect(buildLeadPayload(input({}, { owner_mode: "fixed", owner_fixed_id: USER })).owner).toEqual({ mode: "fixed", ownerId: USER });

    const rules = buildLeadPayload(input({}, { owner_mode: "assignment_rules" }));
    expect(rules.owner).toEqual({ mode: "assignment_rules" });
    expect(rules.autoAssign).toBe(true);

    expect(() => buildLeadPayload(input({ host: null }))).toThrow(SfSettingsError);
    expect(() => buildLeadPayload(input({}, { owner_mode: "fixed", owner_fixed_id: ISO }))).toThrow(/User .* or Queue/);
  });

  it("passes campaign and option flags", () => {
    const p = buildLeadPayload(
      input({}, { campaign_id: "701Hp000001AbCdIAK", create_task: true, create_note: true, set_meeting_booked_fields: true }),
    );
    expect(p.campaignId).toBe("701Hp000001AbCdIAK");
    expect(p.options).toEqual({ createTask: true, createNote: true, setMeetingBookedFields: true });
    expect(buildLeadPayload(input())).not.toHaveProperty("campaignId");
    expect(() => buildLeadPayload(input({}, { campaign_id: "001Hp000001AbCd" }))).toThrow(/701/);
  });

  it("rejects invalid or forbidden field names and bad ISO ids", () => {
    expect(() => buildLeadPayload(input({}, { field_mapping: { invitee_email: "Email; DROP" } }))).toThrow(SfSettingsError);
    expect(() => buildLeadPayload(input({}, { field_mapping: { invitee_email: "1Email" } }))).toThrow(SfSettingsError);
    expect(() => buildLeadPayload(input({}, { static_values: { OwnerId: USER } }))).toThrow(/cannot be set/);
    expect(() => buildLeadPayload(input({}, { field_mapping: { manage_token: "Description" } }))).toThrow(/Unknown mapping source/);
    expect(() => buildLeadPayload(input({}, { static_values: { csbs__ISO__c: "005Hp00000AbCdE" } }))).toThrow(/Account Id/);
    expect(() => validateFieldMapping({ invitee_email: "Email", "q:email": "email" })).toThrow(/more than once/);
  });

  it("never includes tokens or secrets", () => {
    const p = buildLeadPayload(
      input({}, { field_mapping: Object.fromEntries([["booking_id", "Event_ID__c"], ["invitee_timezone", "BTC_Timezone_IANA__c"]]) }),
    );
    const json = JSON.stringify(p).toLowerCase();
    expect(json).not.toMatch(/token|secret|manage|hash|password/);
  });
});

describe("id and field name validation", () => {
  it("accepts API names and Salesforce ids", () => {
    expect(isValidFieldApiName("csbs__ISO__c")).toBe(true);
    expect(isValidFieldApiName("Meeting_booked_time__c")).toBe(true);
    expect(isValidFieldApiName("Email")).toBe(true);
    expect(isValidFieldApiName("bad-name")).toBe(false);
    expect(isValidFieldApiName("_x")).toBe(false);
    expect(isSalesforceId("001Hp00002abcde")).toBe(true);
    expect(isSalesforceId(ISO, ["001"])).toBe(true);
    expect(isSalesforceId("001Hp00002abcd", ["001"])).toBe(false);
    expect(isSalesforceId("001Hp00002abcdeIA", ["001"])).toBe(false);
    expect(isSalesforceId(USER, ["001"])).toBe(false);
  });
});

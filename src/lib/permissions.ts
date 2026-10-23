/**
 * Role-based permissions shared by the web app, the REST API and the MCP server.
 *
 * Global roles:
 * - admin: everything.
 * - manager: reads all bookings, booking pages, teams and the audit log; changes nothing that
 *   belongs to others.
 * - user (shown as "Agent"): their own bookings and booking pages.
 *
 * Team admins (app.team_admins) additionally manage their teams' members and pages. Row-level
 * security enforces data access in the database; these capabilities decide which screens,
 * endpoints and tools are offered and are checked again before every write.
 */

export const ROLES = ["admin", "manager", "user"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = { admin: "Admin", manager: "Manager", user: "Agent" };

export const CAPABILITIES = {
  /** Read every booking, not only the caller's. */
  "bookings.read_all": ["admin", "manager"],
  /** Read every booking page and team. */
  "pages.read_all": ["admin", "manager"],
  /** Create, edit and delete any booking page, including other users' and teams'. */
  "pages.manage_all": ["admin"],
  /** Pre-provision users, change roles, deactivate users. */
  "users.manage": ["admin"],
  /** Create teams, link Salesforce queues and Slack channels, change team admins. */
  "teams.manage": ["admin"],
  "audit.read": ["admin", "manager"],
  "errors.read": ["admin"],
  /** OAuth clients, allowed callback URLs, webhooks, and other users' API keys. */
  "integrations.manage": ["admin"],
  "salesforce.manage": ["admin"],
  "import.manage": ["admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

export function can(role: Role, capability: Capability): boolean {
  return (CAPABILITIES[capability] as readonly Role[]).includes(role);
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

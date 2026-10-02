/**
 * In-memory fake of the Slack Web API methods used by the slack module. It is a `fetch`
 * replacement: pass `fake.fetch` to createSlackClient. It never touches the network.
 */

export type FakeChannel = {
  id: string;
  name: string;
  is_private: boolean;
  /** Whether the bot is a member. */
  bot: boolean;
  members: Set<string>;
  is_archived?: boolean;
  is_general?: boolean;
};

export type ForcedResponse = { status?: number; headers?: Record<string, string>; body?: Record<string, unknown> };

export type FakeCall = { method: string; args: Record<string, string>; contentType: string; authorization: string | null };

export const BOT_USER_ID = "UBOT00001";

export function createFakeSlack() {
  const channels = new Map<string, FakeChannel>();
  const users = new Map<string, string>(); // email -> Slack user id
  const forced = new Map<string, ForcedResponse[]>();
  const calls: FakeCall[] = [];
  const settings = { restrictKicks: false, postMessageError: null as string | null, membersPageSize: 2 };

  const ok = (body: Record<string, unknown> = {}) => ({ ok: true, ...body });
  const err = (error: string) => ({ ok: false, error });

  function addChannel(c: Partial<FakeChannel> & { id: string }): FakeChannel {
    const ch: FakeChannel = {
      name: c.id.toLowerCase(),
      is_private: false,
      bot: true,
      members: new Set(),
      ...c,
    };
    if (ch.bot) ch.members.add(BOT_USER_ID);
    channels.set(ch.id, ch);
    return ch;
  }

  function info(ch: FakeChannel) {
    return {
      id: ch.id,
      name: ch.name,
      is_private: ch.is_private,
      is_member: ch.bot,
      is_archived: !!ch.is_archived,
      is_general: !!ch.is_general,
    };
  }

  function handle(method: string, a: Record<string, string>): Record<string, unknown> {
    const ch = a.channel ? channels.get(a.channel) : undefined;
    const visible = ch && (!ch.is_private || ch.bot) ? ch : undefined;
    switch (method) {
      case "users.lookupByEmail": {
        const id = users.get((a.email ?? "").toLowerCase());
        return id ? ok({ user: { id, deleted: false } }) : err("users_not_found");
      }
      case "conversations.info":
        return visible ? ok({ channel: info(visible) }) : err("channel_not_found");
      case "conversations.members": {
        if (!visible) return err("channel_not_found");
        const all = [...visible.members];
        const start = a.cursor ? Number(a.cursor) : 0;
        const size = settings.membersPageSize;
        const next = start + size < all.length ? String(start + size) : "";
        return ok({ members: all.slice(start, start + size), response_metadata: { next_cursor: next } });
      }
      case "conversations.join":
        if (!visible) return err("channel_not_found");
        if (visible.is_archived) return err("is_archived");
        visible.bot = true;
        visible.members.add(BOT_USER_ID);
        return ok({ channel: info(visible) });
      case "conversations.invite": {
        if (!visible) return err("channel_not_found");
        if (visible.is_archived) return err("is_archived");
        if (!visible.bot) return err("not_in_channel");
        const u = a.users;
        if (visible.members.has(u)) return err("already_in_channel");
        visible.members.add(u);
        return ok({ channel: info(visible) });
      }
      case "conversations.kick": {
        if (!visible) return err("channel_not_found");
        if (!visible.bot) return err("not_in_channel");
        if (a.user === BOT_USER_ID) return err("cant_kick_self");
        if (visible.is_general) return err("cant_kick_from_general");
        if (settings.restrictKicks) return err("restricted_action");
        if (!visible.members.has(a.user)) return err("not_in_channel");
        visible.members.delete(a.user);
        return ok();
      }
      case "chat.postMessage":
        if (settings.postMessageError) return err(settings.postMessageError);
        return ok({ ts: "1700000000.000100" });
      default:
        return err("unknown_method");
    }
  }

  const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
    const method = input.split("/").pop() ?? "";
    const headers = new Headers(init.headers);
    const contentType = headers.get("content-type") ?? "";
    const raw = String(init.body ?? "");
    const args: Record<string, string> = contentType.startsWith("application/json")
      ? Object.fromEntries(Object.entries(JSON.parse(raw || "{}")).map(([k, v]) => [k, String(v)]))
      : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, args, contentType, authorization: headers.get("authorization") });

    const queue = forced.get(method);
    const f = queue?.shift();
    if (f) {
      if (f.body === undefined && f.status === undefined) throw new Error("network down");
      return new Response(JSON.stringify(f.body ?? {}), {
        status: f.status ?? 200,
        headers: { "content-type": "application/json", ...(f.headers ?? {}) },
      });
    }
    return new Response(JSON.stringify(handle(method, args)), { status: 200, headers: { "content-type": "application/json" } });
  };

  return {
    fetch: fetchImpl,
    channels,
    users,
    calls,
    settings,
    addChannel,
    /** Queues a response for the next call to `method`. `{}` simulates a network failure. */
    force(method: string, response: ForcedResponse) {
      const q = forced.get(method) ?? [];
      q.push(response);
      forced.set(method, q);
    },
    callsTo(method: string) {
      return calls.filter((c) => c.method === method);
    },
  };
}

export type FakeSlack = ReturnType<typeof createFakeSlack>;

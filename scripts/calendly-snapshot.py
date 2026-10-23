#!/usr/bin/env python3
"""Builds a Calendly snapshot for Admin > Import (format: snapshotSchema in
src/server/import/calendly/map.ts). See docs/calendly-import.md for how to pull the inputs.

usage: python3 -I scripts/calendly-snapshot.py <inventory_dir> <out.json>
          --window-from ISO --window-to ISO [--pulled-at ISO]
          [--events events_future.json] [--history events_past.json] [--invitees invitees.json]
          [--members members.json] [--emails emails.json] [--allow-partial] [--placeholder]
       python3 -I scripts/calendly-snapshot.py <inventory_dir> <out.json> --pages-only
          [--history events_past.json] [--members members.json] [--emails emails.json] [--pulled-at ISO]

<inventory_dir>  members.json, event_types.json (with round_robin_hosts) and availability/<user-id>.json
--events         meetings whose start is in [window-from, window-to), active AND canceled
--history        earlier meetings; used only to add hosts to team types whose host list is incomplete
--invitees       {event_uri: [invitee, ...]} from the invitees endpoint, for every active meeting
--allow-partial  build even when some active meetings have no usable invitee (they are kept with
                 no invitees, so the importer does not treat them as cancelled)
--placeholder    fills missing or redacted emails with made-up addresses and invents invitees;
                 the importer refuses to apply such a snapshot (dry runs only)
--emails         {user_uri: email} used for members whose email is missing or redacted
--pages-only     people, hours, teams and booking pages only: no meetings, and an empty events
                 window at pulled-at, so the importer never treats a booking as missing
"""
import json, sys, re, collections, os
from datetime import datetime, timezone

args = sys.argv[1:]
src, out = args[0], args[1]
def opt(name, default=None):
    return args[args.index(name) + 1] if name in args else default
placeholder = "--placeholder" in args
allow_partial = "--allow-partial" in args
pages_only = "--pages-only" in args
pulled_at = opt("--pulled-at", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
if pages_only:
    window = {"from": pulled_at, "to": pulled_at}
else:
    window = {"from": opt("--window-from"), "to": opt("--window-to")}
    if not (window["from"] and window["to"]):
        sys.exit("--window-from and --window-to are required (the start-time range the meetings were pulled for)")
    if not placeholder and not opt("--invitees"):
        sys.exit("--invitees is required for a real snapshot")

def ts(v):
    return datetime.fromisoformat(v.replace("Z", "+00:00"))

members = json.load(open(opt("--members", f"{src}/members.json")))
ets = json.load(open(f"{src}/event_types.json"))
events = [] if pages_only else json.load(open(opt("--events", f"{src}/events_future.json")))
history = json.load(open(opt("--history"))) if opt("--history") else []
invitees = json.load(open(opt("--invitees"))) if opt("--invitees") else {}
email_overrides = json.load(open(opt("--emails"))) if opt("--emails") else {}

def redacted(v):
    return not v or "redacted" in str(v)

def email_for(m):
    e = m.get("email") or ""
    if "@" in e and not redacted(e):
        return e
    if email_overrides.get(m["uri"]):
        return email_overrides[m["uri"]]
    if not placeholder:
        return None
    slug = re.sub(r"-?bigthinkcapital$", "", m.get("slug") or "user")
    return slug.replace("-", ".") + "@bigthinkcapital.com"

def hosts_of(ev):
    if "hosts" in ev:
        return ev["hosts"]
    return [m["user"] for m in ev.get("event_memberships") or []]

def location_of(ev):
    loc = ev.get("location")
    if isinstance(loc, dict) and "actual_instance" in loc:
        loc = loc["actual_instance"]
    if isinstance(loc, dict):
        return {"type": loc.get("type"), "location": None if redacted(loc.get("location")) else loc.get("location"), "join_url": loc.get("join_url")}
    if ev.get("location_type"):
        return {"type": ev["location_type"], "location": None, "join_url": None}
    return None

def buffered(ev):
    if "buffered_start_time" in ev:
        return ev.get("buffered_start_time"), ev.get("buffered_end_time")
    ms = ev.get("event_memberships") or [{}]
    return ms[0].get("buffered_start_time"), ms[0].get("buffered_end_time")

# Members with their default availability schedule.
snap_members, missing_email = [], 0
for m in members:
    e = email_for(m)
    if not e:
        missing_email += 1
        continue
    av = None
    uid = m["uri"].rsplit("/", 1)[-1]
    path = f"{src}/availability/{uid}.json"
    if os.path.exists(path):
        coll = json.load(open(path)).get("collection") or []
        default = next((s for s in coll if s.get("default")), coll[0] if coll else None)
        if default:
            av = {"timezone": default.get("timezone"), "rules": [
                {"type": r["type"], "wday": r.get("wday"), "date": r.get("date"), "intervals": r.get("intervals") or []}
                for r in default.get("rules") or []]}
    snap_members.append({"uri": m["uri"], "name": m["name"], "email": e, "slug": m.get("slug"), "timezone": m.get("timezone"), "availability": av})

# Hosts seen on earlier meetings, per event type.
seen = collections.defaultdict(set)
for ev in history:
    for h in hosts_of(ev):
        seen[ev["event_type"]].add(h)

snap_types, recovered = [], 0
for t in ets:
    rr = t.get("round_robin_hosts") or {}
    listed = [h["user"] for h in rr.get("hosts") or []]
    complete = rr.get("status") == "complete"
    hosts = listed
    if t.get("pooling_type") and not complete:
        extra = sorted(seen.get(t["uri"], set()) - set(listed))
        recovered += len(extra)
        hosts = listed + extra
    snap_types.append({
        "uri": t["uri"], "name": t["name"], "slug": t.get("slug"), "active": t["active"], "kind": t.get("kind"),
        "pooling_type": t.get("pooling_type"), "duration": t["duration"], "duration_options": t.get("duration_options") or [],
        "description_plain": t.get("description_plain"), "secret": bool(t.get("secret")),
        "scheduling_url": t["scheduling_url"], "profile": t["profile"],
        "custom_questions": t.get("custom_questions") or [], "locations": t.get("locations") or [],
        "hosts": hosts or None, "hostsComplete": complete if t.get("pooling_type") else None,
    })
for t in snap_types:
    if t["hostsComplete"] is None:
        del t["hostsComplete"]

lo, hi = ts(window["from"]), ts(window["to"])
outside = [ev["uri"] for ev in events if not (lo <= ts(ev["start_time"]) < hi)]
if outside:
    sys.exit(f"{len(outside)} meetings start outside the window; the window must match the pull (first: {outside[0]})")

snap_events, without_invitee = [], []
for ev in events:
    status = ev["status"]
    raw = invitees.get(ev["uri"])
    if raw is None and placeholder and status == "active":
        raw = [{"name": "Test Invitee", "email": f"invitee+{ev['uri'][-8:]}@example.test", "timezone": "America/New_York", "status": "active", "questions_and_answers": []}]
    clean = []
    for i in raw or []:
        if redacted(i.get("email")) or "@" not in i.get("email", ""):
            continue
        clean.append({"name": i["name"], "email": i["email"], "timezone": i.get("timezone"), "status": i.get("status", "active"),
                      "text_reminder_number": None if redacted(i.get("text_reminder_number")) else i.get("text_reminder_number"),
                      "questions_and_answers": [qa for qa in (i.get("questions_and_answers") or []) if not redacted(qa.get("answer"))]})
    if status == "active" and not clean:
        # Keep the meeting: dropping it would make the importer cancel its booking as missing.
        without_invitee.append(ev["uri"])
    bs, be = buffered(ev)
    snap_events.append({
        "uri": ev["uri"], "status": status, "start_time": ev["start_time"], "end_time": ev["end_time"],
        "created_at": ev.get("created_at"), "event_type": ev["event_type"], "location": location_of(ev),
        "hosts": hosts_of(ev), "buffered_start_time": bs, "buffered_end_time": be, "invitees": clean,
    })

if without_invitee and not placeholder and not allow_partial:
    sys.exit(f"{len(without_invitee)} active meetings have no usable invitee (first: {without_invitee[0]}); "
             "fetch their invitees, or pass --allow-partial to keep them without one")

snap = {"source": "calendly", "pulledAt": pulled_at, "eventsWindow": window, "includesCanceled": True,
        "members": snap_members, "eventTypes": snap_types, "events": snap_events}
if placeholder:
    snap["placeholder"] = True
json.dump(snap, open(out, "w"))
print(json.dumps({"members": len(snap_members), "membersMissingEmail": missing_email,
                  "withAvailability": sum(1 for m in snap_members if m["availability"]),
                  "eventTypes": len(snap_types), "hostsRecoveredFromHistory": recovered,
                  "events": len(snap_events), "canceled": sum(1 for e in snap_events if e["status"] == "canceled"),
                  "activeWithoutInvitee": len(without_invitee), "bytes": os.path.getsize(out)}))

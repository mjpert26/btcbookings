# Salesforce changes for BTC Scheduler queue sync

This document lists the Salesforce configuration that lets BTC Scheduler follow Salesforce Queue membership. Nothing here has been deployed. Apply it in a sandbox first.

Org: `https://bigthink.my.salesforce.com`, REST API v60.0.

## Overview

BTC Scheduler learns about queue membership in two ways:

| Path | How | Required? |
|---|---|---|
| Poller (source of truth) | The n8n workflow `BTC Scheduler - SF Queue Snapshot Poller` reads `GroupMember` for every linked queue every 2 minutes and posts a full snapshot to `/api/sync/queue-snapshot`. | Yes. No Salesforce change is needed for it. |
| Push (optional) | Salesforce calls `POST /api/sync/queue-membership` right after a person is added to or removed from a queue. | No. It only shortens the delay from up to 2 minutes to a few seconds. |

Admins link a team to queues by entering the queue's Group Id (`00G...`, 15 or 18 characters) on the team's admin page. 15-character ids are converted to the 18-character form. Changes to queues that no team links to are accepted and ignored.

Because the poller corrects any drift within 2 minutes, the push path can fail without lasting effect. Do not let a push failure block the user in Salesforce.

## Push endpoint contract

`POST https://<scheduler host>/api/sync/queue-membership`

Request body (JSON, at most 64 KB):

| Field | Type | Notes |
|---|---|---|
| `eventId` | string, 8 to 200 chars | Unique per change. Reused ids are rejected with 409 (replay protection). |
| `timestamp` | ISO 8601 datetime | Must be within 5 minutes of the server clock. |
| `action` | `"added"` or `"removed"` | |
| `queueId` | string | Queue Group Id (`00G`, 15 or 18 characters). |
| `sfUserId` | string, optional | User Id (`005...`). |
| `email` | string | The user's email. Matched case-insensitively. |

Sample:

```json
{
  "eventId": "0Ff8a3c1-9d3b-4c55-a1f0-2b7e8a9c1d42-added-005Hp00000jGsRkIAK",
  "timestamp": "2026-10-02T19:04:05Z",
  "action": "added",
  "queueId": "00GVy00000TRvHdMAL",
  "sfUserId": "005Hp00000jGsRkIAK",
  "email": "first.last@bigthinkcapital.com"
}
```

Authentication, either one:

1. **Bearer token** (for Flow): header `Authorization: Bearer <SF_QUEUE_PUSH_BEARER>`. Flow HTTP Callout cannot compute an HMAC, so the token comes from an External Credential custom header, and replay protection relies on `timestamp` and `eventId`.
2. **HMAC** (for Apex or n8n): headers `X-BTC-Timestamp: <unix seconds>` and `X-BTC-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`, keyed with `SF_SYNC_SIGNING_SECRET`. When these headers are present the endpoint uses HMAC and ignores the bearer header.

Responses:

| Status | Meaning |
|---|---|
| 200 `{ "ok": true, "teams": [...] }` | Applied (or nothing to change). |
| 200 `{ "ok": true, "ignored": true }` | No team links this queue. |
| 400 | Body failed validation. |
| 401 | Bad credentials, or `timestamp` outside 5 minutes. |
| 409 | `eventId` already used. |
| 500 | Server error. The poller will correct the state. |

Behavior: an `added` push creates or reinstates the member (status `active` when the person has signed in to BTC Scheduler with a healthy Outlook connection, otherwise `pending_onboarding`). A `removed` push pauses the member unless the person is still in another queue linked to the same team. Manual members and members an admin paused are never changed. The mass-removal safety rail applies to snapshots only, not to single pushes.

## A. Named Credential and External Credential

Setup > Security > Named Credentials.

1. **External Credential** tab > New.
   - Label `BTC Scheduler Push`, Name `BTC_Scheduler_Push`.
   - Authentication Protocol: `Custom`.
   - Save.
2. In the External Credential, **Principals** > New.
   - Parameter Name `Default`, Sequence 1, Identity Type `Named Principal`.
   - Authentication Parameters > Add: Name `Token`, Value = the value of `SF_QUEUE_PUSH_BEARER` from the BTC Scheduler Vercel environment.
   - Save.
3. In the External Credential, **Custom Headers** > New.
   - Name `Authorization`, Value `Bearer {!$Credential.BTC_Scheduler_Push.Token}`, Sequence 1.
   - Save.
4. **Named Credentials** tab > New.
   - Label `BTC Scheduler`, Name `BTC_Scheduler`.
   - URL: `https://<scheduler host>` (no trailing slash, no path).
   - External Credential: `BTC Scheduler Push`.
   - Enabled for Callouts: checked. Generate Authorization Header: unchecked. Allow Formulas in HTTP Header: checked.
   - Save.
5. Grant access to the principal. Create (or reuse) a permission set, open **External Credential Principal Access**, add `BTC_Scheduler_Push - Default`, and assign the permission set to every user who runs the queue screen flow. For Apex that runs as the Automated Process user or an integration user, assign it to that user too.

Rotating the token: set the new value in Vercel (`SF_QUEUE_PUSH_BEARER`), redeploy, then edit the principal's `Token` parameter. Pushes in between fail with 401 and the poller covers them.

## B. Flow HTTP Callout in the queue screen flow (optional)

The poller runs every 2 minutes, so this step only reduces latency. Skip it if you prefer no change to the flow.

1. Open the existing queue management screen flow in Flow Builder and save it as a new version.
2. After the element that creates or deletes the `GroupMember` record, add an **Action** > **Create HTTP Callout**.
   - Name the External Service `BTC_Scheduler_Queue_Push`. Named Credential: `BTC_Scheduler`.
   - Invocable action: Label `Push queue change`, Method `POST`, URL Path `/api/sync/queue-membership`.
   - Request body: **Use sample JSON** and paste the sample from the contract above. Salesforce generates an Apex-defined type from it. Keep all fields as Text.
   - Response: Connect for Schema, or paste `{"ok": true, "ignored": false}`.
3. Map the request fields:
   - `eventId`: a formula resource `{!$Flow.InterviewGuid} & "-" & {!varAction} & "-" & {!varUserId} & "-" & {!varQueueId}`. If one interview can change the same pair twice, append a counter.
   - `timestamp`: a formula resource of type Text, `SUBSTITUTE(TEXT({!$Flow.CurrentDateTime}), " ", "T")`. `TEXT()` of a datetime is in GMT, for example `2026-10-02T19:04:05Z`.
   - `action`: `added` after a create, `removed` after a delete.
   - `queueId`: the Group Id used in the DML element.
   - `sfUserId`: the User Id used in the DML element.
   - `email`: the user's email (add a Get Records on User if the flow does not already have it).
4. **Transaction control.** `GroupMember` is a setup object, and a callout cannot follow uncommitted DML in the same transaction. In the action's Advanced section set **Transaction Control** to "Always start a new transaction". If that option is not available in your release, put a Screen element (for example the existing confirmation screen) between the DML element and the callout so the DML commits first.
5. Add a **Fault** connector from the callout to the next element (or to a screen that says the change was saved). A failed push must not stop the flow or undo the queue change.
6. When the flow adds or removes a person from several queues in a loop, place the callout inside the loop after the commit point, or collect the changes and call it once per change after the loop.
7. Debug in a sandbox, check the response in the debug log, then activate.

## C. Apex: QueueManagementController and related classes (optional)

Current state of the production classes (read on 2026-10-02):

- `QueueManagementController.removeFromQueues` deletes the user's `GroupMember` rows synchronously (`delete as system`), sets User flags, then calls the `@future` method `insertHistoryAsync`.
- Reinstatement (`addUserBackToQueues`) calls `QueueManagementAdd.reinstateForUsers`, whose `QueueMemberInsertJob` (a Queueable) inserts the `GroupMember` rows.
- `QueueManagementDelete.QueueMemberDeleteJob` (a Queueable called from Flow) deletes rows for the hot-lead auto-removal path.

The callout must be asynchronous: `GroupMember` is a setup object, a callout cannot run after uncommitted DML, and setup DML cannot share a transaction with most other work (`MIXED_DML_OPERATION`). The class below is a Queueable with `Database.AllowsCallouts`. A Queueable may enqueue only one child job, and the existing Queueables already use theirs, so when `BtcSchedulerQueuePush.send()` is called from inside a Queueable it uses an `@future(callout=true)` method instead.

### Signing secret

Apex cannot read an External Credential secret into a variable, so HMAC signing needs the secret somewhere Apex can read. Use a protected hierarchy Custom Setting `BTC_Scheduler_Settings__c` with one text field `Signing_Secret__c` (255), set at the org default level, visible only to admins. Set it to the value of `SF_SYNC_SIGNING_SECRET`. If you would rather not store a secret in Salesforce, delete the three signing lines in `post()`: the Named Credential then sends the bearer token, which the endpoint also accepts.

### New class: BtcSchedulerQueuePush

```apex
/**
 * Pushes queue membership changes to BTC Scheduler.
 * POST callout:BTC_Scheduler/api/sync/queue-membership, one request per change.
 * Failures are logged and ignored: the BTC Scheduler poller reconciles every 2 minutes.
 */
public without sharing class BtcSchedulerQueuePush implements Queueable, Database.AllowsCallouts {

    public class Change {
        public String action;   // 'added' | 'removed'
        public Id queueId;
        public Id userId;
        public Change(String action, Id queueId, Id userId) {
            this.action = action; this.queueId = queueId; this.userId = userId;
        }
    }

    private final List<Change> changes;
    public BtcSchedulerQueuePush(List<Change> changes) { this.changes = changes; }

    /** Call after the GroupMember DML. Safe from synchronous code, Flow, and Queueables. */
    public static void send(List<Change> changes) {
        if (changes == null || changes.isEmpty()) return;
        if (System.isFuture() || System.isBatch()) {
            // Neither context may start a future; the poller will pick the change up.
            if (Limits.getQueueableJobs() < Limits.getLimitQueueableJobs()) {
                System.enqueueJob(new BtcSchedulerQueuePush(changes));
            }
        } else if (System.isQueueable()) {
            // Leave the Queueable's single child-job slot to the caller (for example
            // FinalizeReinstateJob) and use a future method instead.
            sendFuture(JSON.serialize(changes));
        } else {
            System.enqueueJob(new BtcSchedulerQueuePush(changes));
        }
    }

    @future(callout=true)
    public static void sendFuture(String changesJson) {
        new BtcSchedulerQueuePush(
            (List<Change>) JSON.deserialize(changesJson, List<Change>.class)
        ).deliver();
    }

    public void execute(QueueableContext qc) { deliver(); }

    @TestVisible
    private void deliver() {
        if (changes == null || changes.isEmpty()) return;
        Set<Id> userIds = new Set<Id>();
        for (Change c : changes) if (c.userId != null) userIds.add(c.userId);
        Map<Id, User> users = new Map<Id, User>(
            [SELECT Id, Email FROM User WHERE Id IN :userIds WITH SYSTEM_MODE]
        );
        Integer max = Math.min(changes.size(), Limits.getLimitCallouts());
        for (Integer i = 0; i < max; i++) {
            Change c = changes[i];
            User u = users.get(c.userId);
            if (u == null || String.isBlank(u.Email)) continue;
            Map<String, Object> body = new Map<String, Object>{
                'eventId'   => 'apex-' + c.action + '-' + c.queueId + '-' + c.userId + '-'
                               + String.valueOf(System.now().getTime()) + '-' + i,
                'timestamp' => System.now(),
                'action'    => c.action,
                'queueId'   => String.valueOf(c.queueId),
                'sfUserId'  => String.valueOf(c.userId),
                'email'     => u.Email
            };
            post(JSON.serialize(body));
        }
    }

    private static void post(String body) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:BTC_Scheduler/api/sync/queue-membership');
        req.setMethod('POST');
        req.setTimeout(10000);
        req.setHeader('Content-Type', 'application/json');
        req.setBody(body);

        BTC_Scheduler_Settings__c s = BTC_Scheduler_Settings__c.getOrgDefaults();
        if (s != null && String.isNotBlank(s.Signing_Secret__c)) {
            String ts = String.valueOf(Datetime.now().getTime() / 1000);
            Blob mac = Crypto.generateMac('hmacSHA256', Blob.valueOf(ts + '.' + body),
                                          Blob.valueOf(s.Signing_Secret__c));
            req.setHeader('X-BTC-Timestamp', ts);
            req.setHeader('X-BTC-Signature', 'sha256=' + EncodingUtil.convertToHex(mac));
        }
        try {
            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() >= 300) {
                System.debug(LoggingLevel.WARN, 'BTC Scheduler push returned ' + res.getStatusCode());
            }
        } catch (Exception e) {
            System.debug(LoggingLevel.WARN, 'BTC Scheduler push failed: ' + e.getMessage());
        }
    }
}
```

`JSON.serialize` writes `System.now()` as `2026-10-02T19:04:05.000Z`, which the endpoint accepts.

### The change in QueueManagementController

In `removeFromQueues`, after the line `insertHistoryAsync(userId, removedQueueIds, System.now());`, add:

```apex
        List<BtcSchedulerQueuePush.Change> pushes = new List<BtcSchedulerQueuePush.Change>();
        for (GroupMember gm : groupMembersToRemove) pushes.add(new BtcSchedulerQueuePush.Change('removed', gm.GroupId, userId));
        BtcSchedulerQueuePush.send(pushes);
```

The delete has already run in this transaction, and `send()` defers the callout to a Queueable, so there is no callout-after-DML error.

### Matching changes for adds and Flow-driven deletes

`addUserBackToQueues` does not touch `GroupMember` itself. The inserts happen in `QueueManagementAdd.QueueMemberInsertJob`. In its `execute`, inside the `if (results[k].isSuccess())` branch, collect the pair:

```apex
                        pushes.add(new BtcSchedulerQueuePush.Change('added', qid, p.userId));
```

declare `List<BtcSchedulerQueuePush.Change> pushes = new List<BtcSchedulerQueuePush.Change>();` before the insert, and call `BtcSchedulerQueuePush.send(pushes);` just before the `if (Test.isRunningTest()) return;` line. Because this runs inside a Queueable, `send()` uses the `@future` path and `FinalizeReinstateJob` can still be enqueued. In tests, the existing code returns before chaining, and the future runs at `Test.stopTest()`.

In `QueueManagementDelete.QueueMemberDeleteJob.execute`, after `delete as system toDelete;` succeeds, query the deleted rows' `GroupId` and `UserOrGroupId` before the delete (the existing query only selects `Id`; add the two fields) and call `BtcSchedulerQueuePush.send(...)` with `'removed'` changes.

### Test class skeleton

```apex
@IsTest
private class BtcSchedulerQueuePushTest {

    private class Mock implements HttpCalloutMock {
        public Integer calls = 0;
        public HttpRequest last;
        public HTTPResponse respond(HttpRequest req) {
            calls++;
            last = req;
            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            res.setHeader('Content-Type', 'application/json');
            res.setBody('{"ok":true,"teams":[]}');
            return res;
        }
    }

    @IsTest
    static void postsSignedChange() {
        insert new BTC_Scheduler_Settings__c(SetupOwnerId = UserInfo.getOrganizationId(),
                                             Signing_Secret__c = 'test-secret');
        Group q = new Group(Name = 'BTC Push Test', Type = 'Queue');
        insert q;
        Mock mock = new Mock();
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        BtcSchedulerQueuePush.send(new List<BtcSchedulerQueuePush.Change>{
            new BtcSchedulerQueuePush.Change('added', q.Id, UserInfo.getUserId())
        });
        Test.stopTest();

        System.assertEquals(1, mock.calls);
        System.assertEquals('POST', mock.last.getMethod());
        System.assert(mock.last.getEndpoint().endsWith('/api/sync/queue-membership'));
        System.assert(mock.last.getHeader('X-BTC-Signature').startsWith('sha256='));
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(mock.last.getBody());
        System.assertEquals('added', body.get('action'));
        System.assertEquals(String.valueOf(q.Id), body.get('queueId'));
    }

    @IsTest
    static void ignoresErrors() {
        Test.setMock(HttpCalloutMock.class, new Mock());
        Test.startTest();
        BtcSchedulerQueuePush.send(new List<BtcSchedulerQueuePush.Change>());
        BtcSchedulerQueuePush.send(null);
        Test.stopTest();
        // No exception means success.
    }
}
```

Existing tests for `QueueManagementController`, `QueueManagementAdd` and `QueueManagementDelete` that now reach a callout need `Test.setMock(HttpCalloutMock.class, ...)` before `Test.startTest()`. Add a one-line mock to each affected test method, or a shared `@TestSetup`-friendly helper class.

## D. Fields used by the poller (verified read-only on 2026-10-02)

- `Group`: `Id`, `Name`, `Type = 'Queue'`. The candidate queues `SDR Round Robin`, `SDR Closer` and `Book 1` exist.
- `GroupMember`: `GroupId`, `UserOrGroupId`. **`GroupMember` has no `User` relationship**, so `SELECT User.Email FROM GroupMember` fails with "Didn't understand relationship 'User'". The poller therefore reads user details with a semi-join: `SELECT Id, Email, IsActive FROM User WHERE Id IN (SELECT UserOrGroupId FROM GroupMember WHERE GroupId IN (...))`.
- `User`: `Id`, `Email`, `IsActive`.
- Nested groups: at the time of checking no queue contained a public group, but the poller expands one level of nested public groups. Roles, roles-and-subordinates and territories inside a queue are not expanded.

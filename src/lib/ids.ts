/** Formats of external identifiers entered by admins. */

/** Salesforce Queue (Group) Id. */
export const SF_QUEUE_ID_RE = /^00G[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;
/** Salesforce Account Id (used for the ISO / "lead source" lookup). */
export const SF_ACCOUNT_ID_RE = /^001[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;
/** Salesforce Campaign Id. */
export const SF_CAMPAIGN_ID_RE = /^701[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;
/** Salesforce User or Queue Id for a fixed lead owner. */
export const SF_OWNER_ID_RE = /^(005|00G)[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;
/** Salesforce field API name, e.g. Company or csbs__ISO__c. */
export const SF_FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

/** Slack channel id (public C..., private G...). */
export const SLACK_CHANNEL_RE = /^[CG][A-Z0-9]{6,}$/;
/** Slack user id. */
export const SLACK_USER_RE = /^[UW][A-Z0-9]{6,}$/;

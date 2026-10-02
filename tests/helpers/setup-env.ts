// Deterministic test environment. Never real secrets.
process.env.APP_BASE_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/btc_scheduler_test";
process.env.ENTRA_TENANT_ID ??= "00000000-0000-4000-8000-000000000001";
process.env.ENTRA_CLIENT_ID ??= "00000000-0000-4000-8000-000000000002";
process.env.ENTRA_CLIENT_SECRET ??= "test-client-secret";
process.env.TOKEN_ENCRYPTION_KEYS ??= "k1:" + Buffer.alloc(32, 7).toString("base64") + ",k0:" + Buffer.alloc(32, 3).toString("base64");
process.env.TOKEN_ENCRYPTION_ACTIVE_KID ??= "k1";
process.env.IP_HASH_SALT ??= "test-ip-hash-salt-0000";
process.env.CRON_SECRET ??= "test-cron-secret-0000";
process.env.N8N_SIGNING_SECRET ??= "test-n8n-signing-secret";
process.env.SF_SYNC_SIGNING_SECRET ??= "test-sf-sync-signing-secret";
process.env.SF_QUEUE_PUSH_BEARER ??= "test-sf-queue-push-bearer-token";
process.env.SLACK_BOT_TOKEN ??= "xoxb-test";
process.env.ADMIN_EMAILS ??= "";

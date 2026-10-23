import type { Instrumentation } from "next";

/**
 * Next.js instrumentation. onRequestError receives errors from Server Components, route
 * handlers, server actions and the proxy, and records them in the application error log
 * (src/server/errors). The logger is loaded lazily and only in the Node.js runtime because
 * it uses the database connection.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { logRequestError } = await import("@/server/errors/request");
    await logRequestError(err, request, context);
  } catch {
    // Logging must never affect the response.
  }
};

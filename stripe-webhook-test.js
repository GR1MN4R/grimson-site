
const crypto = require("node:crypto");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const secret = process.env.STRIPE_TEST_WEBHOOK_SECRET;
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;

  if (!secret || !measurementId || !apiSecret) {
    console.error("TEST: Missing environment variables");
    return { statusCode: 500, body: "Missing configuration" };
  }

  const signature = event.headers["stripe-signature"];
  const payload = event.body || "";

  if (!signature) {
    return { statusCode: 400, body: "Missing Stripe signature" };
  }

  // Verify Stripe webhook signature
  const parts = signature.split(",");
  const timestamp = parts.find(p => p.startsWith("t="))?.slice(2);
  const signatures = parts
    .filter(p => p.startsWith("v1="))
    .map(p => p.slice(3));

  if (!timestamp || !signatures.length) {
    return { statusCode: 400, body: "Invalid signature" };
  }

  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    return { statusCode: 400, body: "Expired signature" };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(payload, "base64").toString("utf8")
    : payload;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const valid = signatures.some(sig => {
    if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
    return crypto.timingSafeEqual(
      Buffer.from(sig, "hex"),
      Buffer.from(expected, "hex")
    );
  });

  if (!valid) {
    console.error("TEST: Invalid Stripe signature");
    return { statusCode: 400, body: "Invalid signature" };
  }

  let stripeEvent;

  try {
    stripeEvent = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  if (stripeEvent.type !== "checkout.session.completed") {
    return { statusCode: 200, body: "Ignored event" };
  }

  const session = stripeEvent.data?.object;

  if (!session || session.livemode !== false) {
    return { statusCode: 400, body: "Not a sandbox session" };
  }

  if (session.payment_status !== "paid") {
    return { statusCode: 200, body: "Payment not completed" };
  }

  const reference = session.client_reference_id || "";
  const match = reference.match(/^ga4_(\d+)_(\d+)_(\d+)$/);

  if (!match) {
    console.log("TEST: Missing GA4 reference");
    return { statusCode: 200, body: "No GA4 reference" };
  }

  const clientId = `${match[1]}.${match[2]}`;
  const sessionId = match[3];

  const amount = Number(session.amount_total) / 100;
  const currency = String(session.currency || "").toUpperCase();

  if (!Number.isFinite(amount) || !currency) {
    return { statusCode: 400, body: "Invalid payment amount" };
  }

  const ga4Payload = {
    client_id: clientId,
    events: [{
      name: process.env.GA4_PURCHASE_EVENT || "manual_event_PURCHASE",
      params: {
        transaction_id: session.id,
        value: amount,
        currency,
        session_id: sessionId,
        engagement_time_msec: 1,
        debug_mode: true
      }
    }]
  };

  try {
    const url = new URL("https://www.google-analytics.com/mp/collect");
    url.searchParams.set("measurement_id", measurementId);
    url.searchParams.set("api_secret", apiSecret);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ga4Payload),
      signal: AbortSignal.timeout(8000)
    });

    console.log("TEST GA4 HTTP status:", response.status);
    console.log("TEST Stripe transaction:", session.id);
    console.log("TEST amount:", amount, currency);

    if (!response.ok) {
      return { statusCode: 502, body: "GA4 request failed" };
    }

    return { statusCode: 200, body: "Sandbox purchase processed" };
  } catch (error) {
    console.error("TEST GA4 error:", error.message);
    return { statusCode: 502, body: "GA4 connection error" };
  }
};

const crypto = require("crypto");

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const RESEND_API_URL = "https://api.resend.com/emails";
const SIGNATURE_TOLERANCE_SECONDS = 300;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: "Method not allowed",
    };
  }

  const requiredVariables = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "RESEND_API_KEY",
    "ORDER_NOTIFICATION_TO",
    "ORDER_NOTIFICATION_FROM",
  ];

  const missingVariables = requiredVariables.filter(
    (name) => !process.env[name]
  );

  if (missingVariables.length > 0) {
    console.error(
      `Missing environment variables: ${missingVariables.join(", ")}`
    );

    return {
      statusCode: 500,
      body: "Server configuration error",
    };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";

  const stripeSignature =
    event.headers["stripe-signature"] ||
    event.headers["Stripe-Signature"];

  if (!stripeSignature) {
    return {
      statusCode: 400,
      body: "Missing Stripe signature",
    };
  }

  try {
    verifyStripeSignature(
      rawBody,
      stripeSignature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error("Stripe signature verification failed:", error.message);

    return {
      statusCode: 400,
      body: `Webhook signature error: ${error.message}`,
    };
  }

  let stripeEvent;

  try {
    stripeEvent = JSON.parse(rawBody);
  } catch (error) {
    return {
      statusCode: 400,
      body: "Invalid JSON payload",
    };
  }

  const supportedEvents = [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
  ];

  if (!supportedEvents.includes(stripeEvent.type)) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        received: true,
        ignored: true,
        eventType: stripeEvent.type,
      }),
    };
  }

  try {
    const webhookSession = stripeEvent.data.object;

    /*
     * Za kartice je payment_status obično "paid" već u
     * checkout.session.completed događaju.
     *
     * Za odgođene metode plaćanja čekamo
     * checkout.session.async_payment_succeeded.
     */
    if (
      stripeEvent.type === "checkout.session.completed" &&
      webhookSession.payment_status !== "paid"
    ) {
      console.log(
        `Checkout Session ${webhookSession.id} is not paid yet.`
      );

      return {
        statusCode: 200,
        body: JSON.stringify({
          received: true,
          waitingForPayment: true,
        }),
      };
    }

    const session = await retrieveCheckoutSession(webhookSession.id);
    const lineItems = await retrieveLineItems(webhookSession.id);

    const customer = session.customer_details || {};
    const shipping =
      session.shipping_details ||
      session.collected_information?.shipping_details ||
      {};

    const address = shipping.address || customer.address || {};
    const customerName = shipping.name || customer.name || "Not provided";
    const customerEmail =
      customer.email || session.customer_email || "Not provided";
    const customerPhone = customer.phone || "Not provided";

    const products = lineItems.data.map((item) => ({
      name:
        item.description ||
        item.price?.product?.name ||
        "Unnamed Stripe product",
      quantity: item.quantity || 1,
      amount: item.amount_total ?? item.amount_subtotal ?? 0,
      currency:
        item.currency ||
        item.price?.currency ||
        session.currency ||
        "nok",
    }));

    const productSummary =
      products.length > 0
        ? products
            .map(
              (product) =>
                `${product.quantity} × ${product.name}`
            )
            .join(", ")
        : "Product information unavailable";

    const formattedTotal = formatMoney(
      session.amount_total || 0,
      session.currency || "nok"
    );

    const customFields = formatCustomFields(session.custom_fields || []);

    const paymentMethod =
      Array.isArray(session.payment_method_types) &&
      session.payment_method_types.length > 0
        ? session.payment_method_types
            .map(formatPaymentMethodName)
            .join(", ")
        : "Not provided";

    const orderDate = new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Oslo",
    }).format(new Date((session.created || Date.now() / 1000) * 1000));

    const dashboardLink = session.payment_intent
      ? `https://dashboard.stripe.com/payments/${session.payment_intent}`
      : `https://dashboard.stripe.com/test/payments`;

    const subject = `NEW ORDER • ${productSummary} • ${formattedTotal}`;

    const emailText = buildOrderEmail({
      products,
      formattedTotal,
      customerName,
      customerEmail,
      customerPhone,
      address,
      paymentMethod,
      orderDate,
      customFields,
      checkoutSessionId: session.id,
      paymentIntentId: session.payment_intent || "Not available",
      paymentLinkId: session.payment_link || "Not available",
      dashboardLink,
    });

    await sendOrderEmail({
      eventId: stripeEvent.id,
      subject,
      text: emailText,
    });

    console.log(
      `Order notification sent for Stripe event ${stripeEvent.id}`
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        received: true,
        emailSent: true,
      }),
    };
  } catch (error) {
    console.error("Webhook processing failed:", error);

    /*
     * Vraćamo 500 kako bi Stripe ponovno pokušao poslati webhook.
     * Resend Idempotency-Key sprječava dupliciranje istog e-maila.
     */
    return {
      statusCode: 500,
      body: "Webhook processing failed",
    };
  }
};

function verifyStripeSignature(payload, signatureHeader, webhookSecret) {
  const parts = signatureHeader.split(",");
  let timestamp;
  const signatures = [];

  for (const part of parts) {
    const [key, value] = part.split("=");

    if (key === "t") {
      timestamp = value;
    }

    if (key === "v1") {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) {
    throw new Error("Invalid Stripe-Signature header");
  }

  const timestampNumber = Number(timestamp);

  if (!Number.isFinite(timestampNumber)) {
    throw new Error("Invalid Stripe timestamp");
  }

  const currentTimestamp = Math.floor(Date.now() / 1000);
  const age = Math.abs(currentTimestamp - timestampNumber);

  if (age > SIGNATURE_TOLERANCE_SECONDS) {
    throw new Error("Webhook timestamp is outside the allowed tolerance");
  }

  const signedPayload = `${timestamp}.${payload}`;

  const expectedSignature = crypto
    .createHmac("sha256", webhookSecret)
    .update(signedPayload, "utf8")
    .digest("hex");

  const isValid = signatures.some((signature) =>
    safeCompare(expectedSignature, signature)
  );

  if (!isValid) {
    throw new Error("No matching Stripe signature found");
  }
}

function safeCompare(valueA, valueB) {
  const bufferA = Buffer.from(valueA, "utf8");
  const bufferB = Buffer.from(valueB, "utf8");

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}

async function retrieveCheckoutSession(sessionId) {
  const parameters = new URLSearchParams();

  parameters.append("expand[]", "payment_intent");
  parameters.append("expand[]", "customer");

  return stripeRequest(
    `/checkout/sessions/${encodeURIComponent(sessionId)}?${parameters}`
  );
}

async function retrieveLineItems(sessionId) {
  const parameters = new URLSearchParams();

  parameters.set("limit", "100");
  parameters.append("expand[]", "data.price.product");

  return stripeRequest(
    `/checkout/sessions/${encodeURIComponent(
      sessionId
    )}/line_items?${parameters}`
  );
}

async function stripeRequest(path) {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  const responseBody = await response.json();

  if (!response.ok) {
    throw new Error(
      `Stripe API error: ${
        responseBody.error?.message || response.statusText
      }`
    );
  }

  return responseBody;
}

async function sendOrderEmail({ eventId, subject, text }) {
  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `stripe-${eventId}`,
    },
    body: JSON.stringify({
      from: process.env.ORDER_NOTIFICATION_FROM,
      to: [process.env.ORDER_NOTIFICATION_TO],
      subject,
      text,
      reply_to: process.env.ORDER_NOTIFICATION_REPLY_TO || undefined,
    }),
  });

  const responseBody = await response.json();

  if (!response.ok) {
    throw new Error(
      `Resend API error: ${
        responseBody.message || response.statusText
      }`
    );
  }

  return responseBody;
}

function buildOrderEmail({
  products,
  formattedTotal,
  customerName,
  customerEmail,
  customerPhone,
  address,
  paymentMethod,
  orderDate,
  customFields,
  checkoutSessionId,
  paymentIntentId,
  paymentLinkId,
  dashboardLink,
}) {
  const productLines = products
    .map((product) => {
      const lineTotal = formatMoney(product.amount, product.currency);

      return [
        `Product: ${product.name}`,
        `Quantity: ${product.quantity}`,
        `Line total: ${lineTotal}`,
      ].join("\n");
    })
    .join("\n\n");

  const addressLines = [
    address.line1,
    address.line2,
    [address.postal_code, address.city].filter(Boolean).join(" "),
    address.state,
    address.country,
  ].filter(Boolean);

  return [
    "NEW GRIMSON ORDER",
    "=================",
    "",
    productLines || "Product information unavailable",
    "",
    `Paid: ${formattedTotal}`,
    "",
    "CUSTOMER",
    "--------",
    `Name: ${customerName}`,
    `Email: ${customerEmail}`,
    `Phone: ${customerPhone}`,
    "",
    "SHIPPING ADDRESS",
    "----------------",
    addressLines.length > 0
      ? addressLines.join("\n")
      : "Not provided",
    "",
    customFields ? `CHECKOUT ANSWERS\n----------------\n${customFields}\n` : "",
    "PAYMENT",
    "-------",
    `Payment method: ${paymentMethod}`,
    `Purchase date: ${orderDate}`,
    `Checkout Session: ${checkoutSessionId}`,
    `Payment Intent: ${paymentIntentId}`,
    `Payment Link: ${paymentLinkId}`,
    "",
    "STRIPE DASHBOARD",
    "----------------",
    dashboardLink,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function formatCustomFields(customFields) {
  if (!Array.isArray(customFields) || customFields.length === 0) {
    return "";
  }

  return customFields
    .map((field) => {
      const label = field.label?.custom || field.key || "Custom field";
      const value =
        field.dropdown?.value ||
        field.numeric?.value ||
        field.text?.value ||
        "Not provided";

      return `${label}: ${value}`;
    })
    .join("\n");
}

function formatMoney(amountInMinorUnits, currency) {
  const currencyCode = String(currency || "nok").toUpperCase();

  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currencyCode,
  }).format((amountInMinorUnits || 0) / 100);
}

function formatPaymentMethodName(method) {
  const names = {
    card: "Card",
    klarna: "Klarna",
    link: "Link",
    paypal: "PayPal",
    vipps: "Vipps",
    apple_pay: "Apple Pay",
    google_pay: "Google Pay",
  };

  return names[method] || method;
}

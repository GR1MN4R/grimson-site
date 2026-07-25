const crypto = require("crypto");
const nodemailer = require("nodemailer");

const STRIPE_API_BASE = "https://api.stripe.com/v1";
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
    "PROTON_SMTP_USER",
    "PROTON_SMTP_TOKEN",
    "ORDER_NOTIFICATION_TO",
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
      body: "Invalid Stripe signature",
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
     * Kod kartičnog plaćanja Checkout Session je obično odmah "paid".
     * Kod odgođenih metoda čekamo async_payment_succeeded.
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
      session.collected_information?.shipping_details ||
      session.shipping_details ||
      {};

    const address = shipping.address || customer.address || {};

    const customerName =
      shipping.name ||
      customer.name ||
      "Not provided";

    const customerEmail =
      customer.email ||
      session.customer_email ||
      "Not provided";

    const customerPhone =
      customer.phone ||
      "Not provided";

    const products = lineItems.data.map((item) => ({
      name:
        item.description ||
        item.price?.product?.name ||
        "Unnamed Stripe product",

      quantity: item.quantity || 1,

      amount:
        item.amount_total ??
        item.amount_subtotal ??
        0,

      currency:
        item.currency ||
        item.price?.currency ||
        session.currency ||
        "nok",
    }));

    const formattedTotal = formatMoney(
      session.amount_total || 0,
      session.currency || "nok"
    );

    const productSummary =
      products.length > 0
        ? products
            .map(
              (product) =>
                `${product.quantity} × ${product.name}`
            )
            .join(", ")
        : "Product information unavailable";

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
    }).format(
      new Date(
        (session.created || Math.floor(Date.now() / 1000)) * 1000
      )
    );

    const customFields = formatCustomFields(
      session.custom_fields || []
    );

    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id || "Not available";

    const dashboardLink =
      paymentIntentId !== "Not available"
        ? `https://dashboard.stripe.com/payments/${paymentIntentId}`
        : "https://dashboard.stripe.com/payments";

    const subject =
      `NEW ORDER • ${productSummary} • ${formattedTotal}`;

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
      paymentIntentId,
      paymentLinkId: session.payment_link || "Not available",
      dashboardLink,
    });

    await sendOrderEmail({
      subject,
      text: emailText,
      replyTo:
        customerEmail !== "Not provided"
          ? customerEmail
          : undefined,
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
     * Stripe će kasnije ponovno pokušati dostaviti webhook
     * ako endpoint vrati status 500.
     */
    return {
      statusCode: 500,
      body: "Webhook processing failed",
    };
  }
};

function verifyStripeSignature(
  payload,
  signatureHeader,
  webhookSecret
) {
  const parts = signatureHeader.split(",");

  let timestamp;
  const signatures = [];

  for (const part of parts) {
    const separatorIndex = part.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = part.slice(0, separatorIndex);
    const value = part.slice(separatorIndex + 1);

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
    throw new Error(
      "Webhook timestamp is outside the allowed tolerance"
    );
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
    `/checkout/sessions/${encodeURIComponent(
      sessionId
    )}?${parameters.toString()}`
  );
}

async function retrieveLineItems(sessionId) {
  const parameters = new URLSearchParams();

  parameters.set("limit", "100");
  parameters.append("expand[]", "data.price.product");

  return stripeRequest(
    `/checkout/sessions/${encodeURIComponent(
      sessionId
    )}/line_items?${parameters.toString()}`
  );
}

async function stripeRequest(path) {
  const response = await fetch(
    `${STRIPE_API_BASE}${path}`,
    {
      method: "GET",
      headers: {
        Authorization:
          `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      },
    }
  );

  const responseBody = await response.json();

  if (!response.ok) {
    throw new Error(
      `Stripe API error: ${
        responseBody.error?.message ||
        response.statusText
      }`
    );
  }

  return responseBody;
}

async function sendOrderEmail({
  subject,
  text,
  replyTo,
}) {
  const transporter = nodemailer.createTransport({
    host: "smtp.protonmail.ch",
    port: 587,
    secure: false,

    requireTLS: true,

    auth: {
      user: process.env.PROTON_SMTP_USER,
      pass: process.env.PROTON_SMTP_TOKEN,
    },

    tls: {
      minVersion: "TLSv1.2",
    },
  });

  await transporter.sendMail({
    from:
      process.env.ORDER_NOTIFICATION_FROM ||
      `GRIMSON Orders <${process.env.PROTON_SMTP_USER}>`,

    to: process.env.ORDER_NOTIFICATION_TO,

    subject,

    text,

    replyTo,
  });
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
      const lineTotal = formatMoney(
        product.amount,
        product.currency
      );

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
    [address.postal_code, address.city]
      .filter(Boolean)
      .join(" "),
    address.state,
    address.country,
  ].filter(Boolean);

  const sections = [
    "NEW GRIMSON ORDER",
    "=================",
    "",
    productLines ||
      "Product information unavailable",
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
  ];

  if (customFields) {
    sections.push(
      "",
      "CHECKOUT ANSWERS",
      "----------------",
      customFields
    );
  }

  sections.push(
    "",
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
    dashboardLink
  );

  return sections.join("\n");
}

function formatCustomFields(customFields) {
  if (
    !Array.isArray(customFields) ||
    customFields.length === 0
  ) {
    return "";
  }

  return customFields
    .map((field) => {
      const label =
        field.label?.custom ||
        field.key ||
        "Custom field";

      const value =
        field.dropdown?.value ||
        field.numeric?.value ||
        field.text?.value ||
        "Not provided";

      return `${label}: ${value}`;
    })
    .join("\n");
}

function formatMoney(
  amountInMinorUnits,
  currency
) {
  const currencyCode =
    String(currency || "nok").toUpperCase();

  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currencyCode,
  }).format(
    (amountInMinorUnits || 0) / 100
  );
}

function formatPaymentMethodName(method) {
  const names = {
    card: "Card",
    klarna: "Klarna",
    link: "Link",
    paypal: "PayPal",
    vipps: "Vipps",
  };

  return names[method] || method;
}
}

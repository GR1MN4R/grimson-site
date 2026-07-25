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
      "";

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

    const orderReference = createOrderReference(
      session.id,
      session.created
    );

    const internalSubject =
      `NEW ORDER • ${productSummary} • ${formattedTotal}`;

    const internalEmailText = buildInternalOrderEmail({
      products,
      formattedTotal,
      customerName,
      customerEmail: customerEmail || "Not provided",
      customerPhone,
      address,
      paymentMethod,
      orderDate,
      customFields,
      orderReference,
      checkoutSessionId: session.id,
      paymentIntentId,
      paymentLinkId: session.payment_link || "Not available",
      dashboardLink,
    });

    await sendInternalOrderEmail({
      subject: internalSubject,
      text: internalEmailText,
      replyTo: customerEmail || undefined,
      messageId: `<internal-${safeMessageIdPart(stripeEvent.id)}@grimson.no>`,
    });

    let customerConfirmationSent = false;

    if (customerEmail && isValidEmail(customerEmail)) {
      const customerSubject =
        products.length === 1
          ? `GRIMSON // Order Confirmed — ${products[0].name}`
          : `GRIMSON // Order Confirmed — ${orderReference}`;

      const customerEmailData = {
        products,
        formattedTotal,
        customerName,
        address,
        paymentMethod,
        orderDate,
        orderReference,
      };

      await sendCustomerConfirmationEmail({
        to: customerEmail,
        subject: customerSubject,
        text: buildCustomerPlainTextEmail(customerEmailData),
        html: buildCustomerHtmlEmail(customerEmailData),
        messageId: `<customer-${safeMessageIdPart(session.id)}@grimson.no>`,
      });

      customerConfirmationSent = true;
    } else {
      console.warn(
        `Customer confirmation skipped: no valid customer email for ${session.id}`
      );
    }

    console.log(
      `Order emails processed for Stripe event ${stripeEvent.id}`
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        received: true,
        internalNotificationSent: true,
        customerConfirmationSent,
        orderReference,
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

function createTransporter() {
  return nodemailer.createTransport({
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
}

function getSender() {
  return (
    process.env.ORDER_NOTIFICATION_FROM ||
    `GRIMSON <${process.env.PROTON_SMTP_USER}>`
  );
}

async function sendInternalOrderEmail({
  subject,
  text,
  replyTo,
  messageId,
}) {
  const transporter = createTransporter();

  await transporter.sendMail({
    from: getSender(),
    to: process.env.ORDER_NOTIFICATION_TO,
    subject,
    text,
    replyTo,
    messageId,
  });
}

async function sendCustomerConfirmationEmail({
  to,
  subject,
  text,
  html,
  messageId,
}) {
  const transporter = createTransporter();

  await transporter.sendMail({
    from: getSender(),
    to,
    subject,
    text,
    html,
    replyTo: process.env.ORDER_NOTIFICATION_TO,
    messageId,
  });
}

function buildInternalOrderEmail({
  products,
  formattedTotal,
  customerName,
  customerEmail,
  customerPhone,
  address,
  paymentMethod,
  orderDate,
  customFields,
  orderReference,
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
    `Order reference: ${orderReference}`,
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


function buildCustomerPlainTextEmail({
  products,
  formattedTotal,
  customerName,
  address,
  paymentMethod,
  orderDate,
  orderReference,
}) {
  const firstName = getFirstName(customerName);
  const addressLines = formatAddressLines(address);

  const productLines = products
    .map((product) => {
      const specs = getProductSpecifications(product.name);
      const lines = [`${product.quantity} × ${product.name}`];

      if (specs.steel) {
        lines.push(`Steel: ${specs.steel}`);
      }

      if (specs.hardness) {
        lines.push(`Hardness: ${specs.hardness}`);
      }

      return lines.join("\n");
    })
    .join("\n\n");

  return [
    "GRIMSON",
    "",
    "YOUR KNIFE HAS ENTERED THE GRIMSON WORKFLOW",
    "",
    `Hello ${firstName},`,
    "",
    "Thank you for choosing GRIMSON.",
    "Your order has been received and your payment has been confirmed.",
    "",
    `ORDER ${orderReference}`,
    "",
    "ORDER DETAILS",
    "-------------",
    `Order reference: ${orderReference}`,
    `Purchase date: ${orderDate}`,
    "Payment status: PAID",
    `Payment method: ${paymentMethod}`,
    "",
    "YOUR GRIMSON",
    "------------",
    productLines || "Product information unavailable",
    "",
    `Total paid: ${formattedTotal}`,
    "",
    "WORKFLOW STATUS",
    "---------------",
    "✓ Order received",
    "✓ Payment confirmed",
    "⏳ Production queue",
    "○ Final inspection",
    "○ Packaging",
    "○ Ready for dispatch",
    "○ Shipped",
    "",
    "Your order is currently waiting for final preparation.",
    "We will hand it over to the carrier as soon as it completes our workflow.",
    "",
    "SHIPPING ADDRESS",
    "----------------",
    addressLines.length > 0
      ? [customerName, ...addressLines].join("\n")
      : customerName,
    "",
    "DELIVERY",
    "--------",
    "Every GRIMSON knife undergoes a final inspection before leaving our workshop.",
    "Once approved, it is securely packed and handed over to the carrier.",
    "When the shipment enters the carrier's network, tracking notifications will be sent directly by the carrier.",
    "Please use your local postal or courier application to follow deliveries registered to your name and address.",
    "",
    "IMPORTANT DELIVERY INFORMATION",
    "------------------------------",
    "AGE VERIFICATION IS MANDATORY",
    "",
    "Age verification is mandatory and cannot be waived.",
    "The recipient must present valid identification before the parcel can be released.",
    "If age verification cannot be completed, the shipment will automatically be returned.",
    "",
    "INSPECTION",
    "----------",
    "Please inspect your knife immediately after delivery.",
    "If anything appears damaged or incomplete, contact us within 48 hours.",
    "",
    "GRIMSON",
    "",
    "BUILT 2 OPERATE",
    "EDGE 2 DOMINATE",
    "",
    "https://grimson.no",
  ].join("\n");
}

function buildCustomerHtmlEmail({
  products,
  formattedTotal,
  customerName,
  address,
  paymentMethod,
  orderDate,
  orderReference,
}) {
  const firstName = escapeHtml(getFirstName(customerName));
  const safeCustomerName = escapeHtml(customerName);
  const safePaymentMethod = escapeHtml(paymentMethod);
  const safeOrderDate = escapeHtml(orderDate);
  const safeOrderReference = escapeHtml(orderReference);
  const safeFormattedTotal = escapeHtml(formattedTotal);

  const addressLines = formatAddressLines(address)
    .map((line) => escapeHtml(line));

  const productsHtml = products
    .map((product) => {
      const specs = getProductSpecifications(product.name);

      const specificationRows = [
        specs.steel ? detailRow("Steel", specs.steel) : "",
        specs.hardness ? detailRow("Hardness", specs.hardness) : "",
        detailRow("Quantity", String(product.quantity)),
      ].join("");

      return `
        <div style="padding:0 0 22px 0;">
          <div style="font-size:18px;line-height:1.4;font-weight:700;color:#111111;">
            ${escapeHtml(product.quantity)} × ${escapeHtml(product.name)}
          </div>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:12px;border-collapse:collapse;">
            ${specificationRows}
          </table>
        </div>
      `;
    })
    .join("");

  const shippingAddressHtml =
    addressLines.length > 0
      ? [safeCustomerName, ...addressLines].join("<br>")
      : safeCustomerName;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GRIMSON Order Confirmation</title>
</head>
<body style="margin:0;padding:0;background:#eeeeee;font-family:Arial,Helvetica,sans-serif;color:#111111;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    Your GRIMSON order has been confirmed. Reference ${safeOrderReference}.
  </div>

  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#eeeeee;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:680px;background:#ffffff;border-collapse:collapse;">

          <tr>
            <td align="center" style="background:#111111;padding:36px 24px 32px 24px;">
              <div style="font-size:31px;letter-spacing:8px;font-weight:800;color:#ffffff;">GRIMSON</div>
              <div style="margin-top:11px;font-size:10px;letter-spacing:3px;color:#bdbdbd;">NORTHERN NORWAY</div>
            </td>
          </tr>

          <tr>
            <td style="height:5px;background:#651f2d;font-size:0;line-height:0;">&nbsp;</td>
          </tr>

          <tr>
            <td style="padding:42px 38px 20px 38px;">
              <div style="font-size:11px;letter-spacing:2px;font-weight:700;color:#777777;">
                ORDER ${safeOrderReference}
              </div>

              <h1 style="margin:16px 0 20px 0;font-size:31px;line-height:1.15;letter-spacing:-0.5px;color:#111111;">
                YOUR KNIFE HAS ENTERED<br>
                THE GRIMSON <span style="color:#651f2d;">WORKFLOW</span>
              </h1>

              <p style="margin:0 0 10px 0;font-size:16px;line-height:1.7;color:#333333;">
                Hello ${firstName},
              </p>

              <p style="margin:0;font-size:16px;line-height:1.7;color:#333333;">
                Thank you for choosing GRIMSON. Your order has been received and your payment has been confirmed.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:18px 38px 0 38px;">
              ${sectionHeading("ORDER DETAILS")}

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
                ${detailRow("Order reference", safeOrderReference)}
                ${detailRow("Purchase date", safeOrderDate)}
                ${detailRow("Payment status", "PAID")}
                ${detailRow("Payment method", safePaymentMethod)}
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:34px 38px 0 38px;">
              ${sectionHeading("YOUR GRIMSON")}
              ${productsHtml}

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;border-top:2px solid #111111;">
                <tr>
                  <td style="padding:16px 0 0 0;font-size:14px;font-weight:700;color:#555555;">TOTAL PAID</td>
                  <td align="right" style="padding:16px 0 0 0;font-size:21px;font-weight:800;color:#111111;">
                    ${safeFormattedTotal}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:34px 38px 0 38px;">
              ${sectionHeading("WORKFLOW STATUS")}

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#111111;border-collapse:collapse;">
                <tr>
                  <td style="padding:24px 24px 22px 24px;">
                    ${workflowRow("✓", "Order received", true)}
                    ${workflowRow("✓", "Payment confirmed", true)}
                    ${workflowRow("⏳", "Production queue", false, true)}
                    ${workflowRow("○", "Final inspection", false)}
                    ${workflowRow("○", "Packaging", false)}
                    ${workflowRow("○", "Ready for dispatch", false)}
                    ${workflowRow("○", "Shipped", false)}
                  </td>
                </tr>
              </table>

              <p style="margin:14px 0 0 0;font-size:13px;line-height:1.65;color:#666666;">
                Your order is currently waiting for final preparation. We will hand it over to the carrier as soon as it completes our workflow.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:34px 38px 0 38px;">
              ${sectionHeading("SHIPPING ADDRESS")}
              <div style="font-size:15px;line-height:1.7;color:#333333;">
                ${shippingAddressHtml}
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:34px 38px 0 38px;">
              ${sectionHeading("DELIVERY")}
              <p style="margin:0 0 12px 0;font-size:15px;line-height:1.7;color:#333333;">
                Every GRIMSON knife undergoes a final inspection before leaving our workshop.
              </p>
              <p style="margin:0 0 12px 0;font-size:15px;line-height:1.7;color:#333333;">
                Once approved, it is securely packed and handed over to the carrier.
              </p>
              <p style="margin:0;font-size:15px;line-height:1.7;color:#333333;">
                When the shipment enters the carrier's network, tracking notifications will be sent directly by the carrier. Please use your local postal or courier application to follow deliveries registered to your name and address.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:34px 38px 0 38px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f1f2;border-left:5px solid #651f2d;border-collapse:collapse;">
                <tr>
                  <td style="padding:22px 22px 20px 22px;">
                    <div style="font-size:12px;letter-spacing:1.7px;font-weight:800;color:#651f2d;">
                      IMPORTANT DELIVERY INFORMATION
                    </div>
                    <p style="margin:12px 0 8px 0;font-size:17px;line-height:1.6;font-weight:800;color:#111111;">
                      AGE VERIFICATION IS MANDATORY
                    </p>
                    <p style="margin:0 0 8px 0;font-size:14px;line-height:1.65;color:#333333;">
                      Age verification is mandatory and cannot be waived.
                    </p>
                    <p style="margin:0;font-size:14px;line-height:1.65;color:#333333;">
                      The recipient must present valid identification before the parcel can be released. If age verification cannot be completed, the shipment will automatically be returned.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:34px 38px 42px 38px;">
              ${sectionHeading("INSPECTION")}
              <p style="margin:0;font-size:15px;line-height:1.7;color:#333333;">
                Please inspect your knife immediately after delivery. If anything appears damaged or incomplete, contact us within 48 hours.
              </p>
            </td>
          </tr>

          <tr>
            <td align="center" style="background:#111111;padding:30px 24px;">
              <div style="font-size:20px;letter-spacing:5px;font-weight:800;color:#ffffff;">GRIMSON</div>

              <div style="margin-top:16px;font-size:11px;line-height:1.8;letter-spacing:1.8px;color:#d3d3d3;">
                BUILT 2 OPERATE<br>
                EDGE 2 DOMINATE
              </div>

              <div style="margin-top:20px;font-size:13px;line-height:1.8;color:#bdbdbd;">
                <a href="https://grimson.no" style="color:#ffffff;text-decoration:none;">grimson.no</a>
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function workflowRow(symbol, label, completed, current = false) {
  const safeSymbol = escapeHtml(symbol);
  const safeLabel = escapeHtml(label);

  const symbolColor = completed
    ? "#ffffff"
    : current
      ? "#d8a6b0"
      : "#777777";

  const labelColor = completed
    ? "#ffffff"
    : current
      ? "#ffffff"
      : "#9a9a9a";

  const weight = current ? "800" : "700";

  return `
    <div style="padding:7px 0;font-size:14px;line-height:1.5;">
      <span style="display:inline-block;width:28px;color:${symbolColor};font-weight:800;">${safeSymbol}</span>
      <span style="color:${labelColor};font-weight:${weight};">${safeLabel}</span>
    </div>
  `;
}

function sectionHeading(label) {
  return `
    <div style="margin-bottom:16px;padding-bottom:9px;border-bottom:1px solid #d8d8d8;font-size:12px;letter-spacing:1.8px;font-weight:800;color:#651f2d;">
      ${escapeHtml(label)}
    </div>
  `;
}

function detailRow(label, value) {
  return `
    <tr>
      <td valign="top" style="width:42%;padding:7px 12px 7px 0;font-size:13px;line-height:1.5;color:#666666;">
        ${escapeHtml(label)}
      </td>
      <td valign="top" style="padding:7px 0;font-size:14px;line-height:1.5;font-weight:700;color:#111111;">
        ${escapeHtml(value)}
      </td>
    </tr>
  `;
}

function createOrderReference(sessionId, createdTimestamp) {
  const year = new Date(
    (createdTimestamp || Math.floor(Date.now() / 1000)) * 1000
  ).getFullYear();

  const digest = crypto
    .createHash("sha256")
    .update(String(sessionId))
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();

  return `GRM-${year}-${digest}`;
}

function safeMessageIdPart(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 120);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function getFirstName(fullName) {
  const trimmed = String(fullName || "").trim();

  if (!trimmed || trimmed === "Customer") {
    return "Customer";
  }

  return trimmed.split(/\s+/)[0];
}

function formatAddressLines(address) {
  return [
    address.line1,
    address.line2,
    [address.postal_code, address.city]
      .filter(Boolean)
      .join(" "),
    address.state,
    address.country,
  ].filter(Boolean);
}

function getProductSpecifications(productName) {
  const name = String(productName || "").toLowerCase();

  if (
    name.includes("mk-i core") ||
    name.includes("ranger") ||
    name.includes("desert fox")
  ) {
    return {
      steel: "440B Stainless Steel",
      hardness: "58–60 HRC",
    };
  }

  if (
    name.includes("bloodrain") ||
    name.includes("roseforge") ||
    name.includes("damascus")
  ) {
    return {
      steel: "15N20 + 1095 Damascus Steel",
      hardness: "",
    };
  }

  return {
    steel: "",
    hardness: "",
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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

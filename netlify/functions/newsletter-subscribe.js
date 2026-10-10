
const RATE_LIMIT = 5;
const RATE_WINDOW = 60;

const json = (statusCode, data, extraHeaders = {}) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  },
  body: JSON.stringify(data),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method Not Allowed" }, {
      Allow: "POST",
    });
  }

  // Netlify's platform-managed rate limiting.
  // Requires a supported Netlify Functions deployment.
  try {
    const raw = event.body || "";

    if (raw.length > 2048) {
      return json(413, { error: "Request too large." });
    }

    const body = JSON.parse(raw);

    // Honeypot: legitimate form submissions leave this empty.
    if (body.website) {
      return json(200, {
        success: true,
        message: "Successfully subscribed.",
      });
    }

    const email =
      typeof body.email === "string"
        ? body.email.trim().toLowerCase()
        : "";

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return json(400, {
        error: "Please enter a valid email address.",
      });
    }

    if (!process.env.BREVO_API_KEY) {
      console.error("BREVO_API_KEY is missing");
      return json(503, {
        error: "Subscription temporarily unavailable.",
      });
    }

    const response = await fetch(
      "https://api.brevo.com/v3/contacts",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "api-key": process.env.BREVO_API_KEY,
        },
        body: JSON.stringify({
          email,
          listIds: [3],
          updateEnabled: true,
        }),
        signal: AbortSignal.timeout(8000),
      }
    );

    if (!response.ok) {
      console.error("Brevo API error", {
        status: response.status,
      });

      return json(502, {
        error: "Subscription temporarily unavailable.",
      });
    }

    return json(200, {
      success: true,
      message: "Successfully subscribed.",
    });
  } catch (error) {
    console.error("Newsletter function error", {
      name: error.name,
    });

    return json(500, {
      error: "Subscription temporarily unavailable.",
    });
  }
};

// Netlify Functions rate limiting configuration
exports.config = {
  rateLimit: {
    windowLimit: RATE_LIMIT,
    windowSize: RATE_WINDOW,
    aggregateBy: ["ip"],
  },
};


const RATE_LIMIT = 5;
const RATE_WINDOW = 60;

const json = (statusCode, data, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });

export default async (request) => {
  const event = {
    httpMethod: request.method,
    body: await request.text(),
  };
  if (event.httpMethod !== "POST") {
    return json(
      405,
      { error: "Method Not Allowed" },
      { Allow: "POST" }
    );
  }

  try {
    const raw = event.body || "";

    if (raw.length > 4096) {
      return json(413, { error: "Request too large." });
    }

    let body;

    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "Invalid request." });
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json(400, { error: "Invalid request." });
    }

    // Honeypot protection
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

    const token =
      typeof body.turnstileToken === "string"
        ? body.turnstileToken
        : "";

    if (!token || token.length > 2048) {
      return json(403, {
        error: "Security verification required.",
      });
    }

    const secret = process.env.TURNSTILE_NEWSLETTER_SECRET_KEY;

    if (!secret || !process.env.BREVO_API_KEY) {
      console.error("Newsletter configuration missing");
      return json(503, {
        error: "Subscription temporarily unavailable.",
      });
    }

    // Verify Turnstile token on Cloudflare servers
    const verification = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          secret,
          response: token,
        }),
        signal: AbortSignal.timeout(8000),
      }
    );

    if (!verification.ok) {
      console.error("Turnstile verification service error");
      return json(502, {
        error: "Security verification unavailable.",
      });
    }

    const result = await verification.json();

    if (
      result.success !== true ||
      result.hostname !== "grimson.no"
    ) {
      return json(403, {
        error: "Security verification failed.",
      });
    }

    // Only verified requests can reach Brevo
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

// Netlify rate limiting — must be verified after deployment
export const config = {
  path: "/.netlify/functions/newsletter-subscribe",
  rateLimit: {
    windowLimit: 5,
    windowSize: 60,
    aggregateBy: ["ip"],
  },
};

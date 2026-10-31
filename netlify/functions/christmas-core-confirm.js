
const crypto = require("node:crypto");
const { getDatabase } = require("@netlify/database");

function page(title, message) {
  const escapeHtml = (value) =>
    value.replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | GRIMSON</title>
</head>
<body style="background:#111;color:#eee;font-family:Arial,sans-serif;
             text-align:center;padding:70px 20px">
  <h1>GRIMSON</h1>
  <h2>${escapeHtml(title)}</h2>
  <p>${escapeHtml(message)}</p>
  <p><a href="https://grimson.no/" style="color:#ddd">
    Return to GRIMSON
  </a></p>
</body>
</html>`;
}

function respond(statusCode, title, message) {
  return {
    statusCode,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
    body: page(title, message),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return respond(
      405,
      "Invalid request",
      "This confirmation link must be opened in a browser."
    );
  }

  const token = event.queryStringParameters?.token;

  if (
    typeof token !== "string" ||
    !/^[a-f0-9]{64}$/.test(token)
  ) {
    return respond(
      400,
      "Invalid link",
      "This confirmation link is invalid."
    );
  }

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  try {
    const db = getDatabase({
  connectionString: process.env.GRIMSON_DATABASE_URL
});

    const result = await db.pool.query(
      `UPDATE christmas_core_entries
       SET email_verified_at = NOW(),
           verification_token_hash = NULL,
           verification_expires_at = NULL
       WHERE verification_token_hash = $1
         AND email_verified_at IS NULL
         AND verification_expires_at > NOW()
       RETURNING id`,
      [tokenHash]
    );

    if (result.rowCount === 1) {
      return respond(
        200,
        "Entry confirmed!",
        "Your entry for the GRIMSON Christmas Giveaway is confirmed. Good luck!"
      );
    }

    return respond(
      400,
      "Link expired or already used",
      "This confirmation link is no longer valid."
    );
  } catch (error) {
    console.error("Christmas confirmation failed:", error);

    return respond(
      503,
      "Temporarily unavailable",
      "We could not confirm your entry. Please try again later."
    );
  }
};

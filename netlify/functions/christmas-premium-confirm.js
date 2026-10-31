
const crypto = require("node:crypto");
const { getDatabase } = require("@netlify/database");

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

function response(statusCode, title, message) {
  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]);

  return {
    statusCode,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    },
    body: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} | GRIMSON</title>
<style>
body {
  background:#111;
  color:#eee;
  font:16px Arial,sans-serif;
  min-height:100vh;
  display:grid;
  place-items:center;
  margin:0;
}
main {
  max-width:540px;
  padding:40px 24px;
  text-align:center;
}
h1 {letter-spacing:3px}
p {line-height:1.7;color:#bbb}
a {color:#fff}
</style>
</head>
<body>
<main>
<h1>GRIMSON</h1>
<h2>${escapeHtml(title)}</h2>
<p>${escapeHtml(message)}</p>
<p><a href="https://grimson.no/">RETURN TO GRIMSON</a></p>
</main>
</body>
</html>`
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return response(405, "Method not allowed",
      "This confirmation link must be opened in a browser.");
  }

  const token = event.queryStringParameters?.token;

  if (
    typeof token !== "string" ||
    !/^[a-f0-9]{64}$/i.test(token)
  ) {
    return response(400, "Invalid link",
      "This confirmation link is invalid.");
  }

  try {
    const db = getDatabase();

    const result = await db.pool.query(
      `UPDATE christmas_premium_entries
       SET email_verified_at = NOW(),
           verification_token_hash = NULL,
           verification_expires_at = NULL
       WHERE verification_token_hash = $1
         AND email_verified_at IS NULL
         AND verification_expires_at > NOW()
       RETURNING id`,
      [hashToken(token)]
    );

    if (result.rowCount === 1) {
      return response(200, "ENTRY CONFIRMED",
        "Your email has been verified. Your photograph has been submitted for review. Thank you for entering the GRIMSON PREMIUM Photo Contest.");
    }

    return response(400, "Link expired or already used",
      "This confirmation link is no longer valid. It may have expired or already been used.");
  } catch (error) {
    console.error("PREMIUM confirmation error:", error);

    return response(503, "Service unavailable",
      "We could not confirm your entry right now. Please try again later.");
  }
};

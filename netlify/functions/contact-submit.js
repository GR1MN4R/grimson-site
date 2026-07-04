exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const params = new URLSearchParams(event.body || "");

  const token = params.get("cf-turnstile-response");
  const botField = params.get("bot-field") || "";

  const name = (params.get("name") || "").trim();
  const email = (params.get("email") || "").trim();
  const reason = (params.get("reason") || "").trim();
  const message = (params.get("message") || "").trim();

  if (botField) {
    return { statusCode: 302, headers: { Location: "/thanks.html" }, body: "" };
  }

  if (!process.env.TURNSTILE_SECRET) {
    return { statusCode: 500, body: "Server verification is not configured." };
  }

  if (!token) {
    return { statusCode: 400, body: "Human verification is missing. Please try again." };
  }

  const verifyResponse = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      secret: process.env.TURNSTILE_SECRET,
      response: token,
      remoteip: event.headers["x-nf-client-connection-ip"] || ""
    })
  });

  const verifyData = await verifyResponse.json();

  if (!verifyData.success) {
    return { statusCode: 403, body: "Human verification failed. Please try again." };
  }

  const formData = new URLSearchParams({
    "form-name": "contact",
    "subject": "GRIMSON Website Inquiry",
    "name": name,
    "email": email,
    "reason": reason,
    "message": message
  });

  await fetch("https://grimson.netlify.app/contact.html", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString()
  });

  return {
    statusCode: 302,
    headers: { Location: "/thanks.html" },
    body: ""
  };
};

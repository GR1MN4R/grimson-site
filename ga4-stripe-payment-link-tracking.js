(function () {
  const GA4_MEASUREMENT_ID = "G-7TZ08J5Q1R";
  const STRIPE_LINK_SELECTOR = 'a[href*="buy.stripe.com"]';

  function getGtagValue(field) {
    return new Promise((resolve) => {
      if (typeof window.gtag !== "function") {
        resolve(null);
        return;
      }

      let finished = false;
      const timeout = setTimeout(() => {
        if (!finished) {
          finished = true;
          resolve(null);
        }
      }, 2500);

      try {
        window.gtag("get", GA4_MEASUREMENT_ID, field, (value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          resolve(value || null);
        });
      } catch (error) {
        clearTimeout(timeout);
        resolve(null);
      }
    });
  }

  async function attachGa4ReferenceToStripeLinks() {
    const stripeLinks = Array.from(
      document.querySelectorAll(STRIPE_LINK_SELECTOR)
    );
    if (stripeLinks.length === 0) return;

    const [clientId, sessionId] = await Promise.all([
      getGtagValue("client_id"),
      getGtagValue("session_id"),
    ]);

    if (!/^\d+\.\d+$/.test(String(clientId || "")) ||
        !/^\d+$/.test(String(sessionId || ""))) {
      console.warn("GRIMSON analytics: GA4 client/session ID unavailable; Stripe links left unchanged.");
      return;
    }

    // Stripe silently drops client_reference_id values containing ':' or '.'.
    const clientReferenceId = `ga4_${clientId.replace(".", "_")}_${sessionId}`;
    stripeLinks.forEach((link) => {
      try {
        const url = new URL(link.href, window.location.href);
        url.searchParams.set("client_reference_id", clientReferenceId);
        link.href = url.toString();
      } catch (error) {
        console.warn("GRIMSON analytics: could not update Stripe Payment Link.", error);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attachGa4ReferenceToStripeLinks, { once: true });
  } else {
    attachGa4ReferenceToStripeLinks();
  }
})();

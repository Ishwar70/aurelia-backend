export interface Policy {
  slug: string;
  title: string;
  summary: string;
  sections: { heading: string; body: string }[];
}

export const POLICIES: Policy[] = [
  {
    slug: "shipping",
    title: "Shipping",
    summary: "Complimentary standard shipping on orders of ₹5,000 or more.",
    sections: [
      {
        heading: "Standard",
        body: "Standard delivery is ₹99 and arrives in 5–7 days. It is complimentary when the merchandise total, after discounts, is ₹5,000 or more.",
      },
      {
        heading: "Express",
        body: "Express delivery is ₹199 and arrives in 2–3 days. Express is not available for PIN codes that begin with 9.",
      },
      {
        heading: "Where we ship",
        body: "AURELIA currently ships across India. Duties and cross-border shipping are not part of this launch.",
      },
    ],
  },
  {
    slug: "returns",
    title: "Returns",
    summary: "15 days from delivery, unworn, with tags.",
    sections: [
      {
        heading: "Window",
        body: "You can start a return within 15 days of the delivery date. The item must be unworn, unwashed, and have its tags attached.",
      },
      {
        heading: "Exceptions",
        body: "Jewelry is final sale. Pierced earrings and other hygiene-sensitive pieces cannot be returned.",
      },
      {
        heading: "Refunds",
        body: "Approved refunds return to the original payment method. The assistant can explain the policy, and a return is created only after you confirm the exact item.",
      },
    ],
  },
  {
    slug: "faq",
    title: "FAQ",
    summary: "Sizing, payments, and orders.",
    sections: [
      {
        heading: "Do prices include GST?",
        body: "Yes. Every customer-facing price is inclusive of GST. The invoice shows the GST portion separately.",
      },
      {
        heading: "Can I check out as a guest?",
        body: "Yes. Guest checkout stays available. You can create an account later and we will attach orders placed with the same email.",
      },
      {
        heading: "When is a payment final?",
        body: "A payment is final only after our server verifies it. The browser redirect is a receipt, not the authority.",
      },
    ],
  },
  {
    slug: "contact",
    title: "Contact",
    summary: "Write to the atelier.",
    sections: [
      {
        heading: "Client care",
        body: "Email care@aurelia.example. We reply on business days between 10:00 and 18:00 IST.",
      },
      {
        heading: "Orders",
        body: "Have your order number ready. It starts with AU-.",
      },
    ],
  },
  {
    slug: "privacy",
    title: "Privacy",
    summary: "What we keep, and what we do not.",
    sections: [
      {
        heading: "Voice and images",
        body: "Voice search uses your browser speech recognition. We do not retain raw audio. Visual search receives a small colour sample, not a stored photograph, and we do not run facial recognition.",
      },
      {
        heading: "Assistant",
        body: "Conversations are kept for up to 30 days for support and quality review, then deleted. You can request deletion from your account. Do not send card numbers, PINs, or passwords.",
      },
      {
        heading: "Orders",
        body: "Orders and invoices are retained for tax and accounting obligations, separate from marketing consent.",
      },
    ],
  },
  {
    slug: "terms",
    title: "Terms",
    summary: "The commercial terms for this store.",
    sections: [
      {
        heading: "Contract",
        body: "A contract is formed when we confirm your order after payment verification, not when an item is placed in the bag.",
      },
      {
        heading: "Pricing",
        body: "We reprice the bag at checkout. If a price or promotion changes, you will see the new total before you pay.",
      },
    ],
  },
];

export const HOME = {
  utility: "Complimentary shipping on orders above ₹5,000. Returns within 15 days.",
  hero: {
    eyebrow: "Autumn / Winter 2026",
    title: "Tailoring, softened.",
    subtitle: "A considered wardrobe for the occasions that ask for presence.",
    ctaLabel: "Shop the edit",
    ctaHref: "/collections/new-arrivals",
    image: "https://images.unsplash.com/photo-1469334031218-e382a71b716b?auto=format&fit=crop&w=2000&q=80",
    alt: "Editorial photograph of a model in a tailored coat, walking",
  },
  look: {
    title: "The ceremony",
    caption: "Column silk, a hoop, a mule, and a scarf that finishes the look.",
    image: "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=1600&q=80",
    alt: "Full-length fashion photograph used for the ceremony look",
    productSlugs: ["silk-column-dress", "sculptural-hoops", "leather-mule", "silk-scarf"],
  },
  editorial: {
    eyebrow: "Journal",
    title: "What to wear when the invitation says festive.",
    body: "Start with the column, add one piece of metal, and keep the shoe stable. The rest is editing.",
    image: "https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=1600&q=80",
    alt: "Street editorial of layered tailoring",
    href: "/collections/wedding-guest",
  },
  trust: [
    { title: "Delivery", body: "5–7 days, complimentary above ₹5,000", href: "/help/shipping" },
    { title: "Returns", body: "15 days, unworn, tags on", href: "/help/returns" },
    { title: "Payment", body: "Verified on the server, never in the browser", href: "/help/faq" },
    { title: "Care", body: "Client care on business days, 10:00–18:00 IST", href: "/help/contact" },
  ],
};

export const DEFAULT_SYNONYMS = [
  { id: "syn_trousers", terms: ["trousers", "pants", "trouser"] },
  { id: "syn_sneakers", terms: ["sneakers", "trainers", "sneaker"] },
  { id: "syn_sweater", terms: ["sweater", "jumper", "knit", "cashmere"] },
];

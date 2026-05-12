# Oro — Developer Brief: Web Presence & Distribution

> For the lead developer of **Oro**
> From: Gelay
> Date: April 2026

---

## The core problem

Oro is sharing the wrong URL.

Right now `tma.oro.fun` is being treated as a destination. It shouldn't be. It's the Mini App's technical launch URL — plumbing that Telegram loads inside its WebView. Users should never see it or share it.

We need to fix three things:

1. **The bot identity** — `t.me/OroPredictBot` should be the share link, with a polished preview
2. **The marketing site** — `oro.fun` should be a real public-facing site, not a JavaScript shell
3. **The Mini App URL** — `tma.oro.fun` stays as plumbing, hidden from users

This is the pattern Lucky Pem already follows. Oro should mirror it.

---

## Domain architecture (locked)

```
21 Tech (parent company)
└── 21.tech.bt                    [studio site — separate effort]

Oro
├── oro.fun                       [marketing site — TO BUILD]
└── tma.oro.fun                   [Mini App — exists, hidden]
```

### The rule going forward

- Press, partners, ads, social posts → share **`oro.fun`** (marketing site)
- Get users into the product → share **`t.me/OroPredictBot`** (bot, rich Telegram preview)
- `tma.oro.fun` → only Telegram itself loads it. Never share publicly. Never link to it.

---

## 1. Fix @OroPredictBot in BotFather (10 minutes)

Lucky Pem's bot link `t.me/LuckyPemBot` shows a logo, the tagline "Unlucky in Love? Your luck starts here.", and a Start Bot button. It looks like a real product.

`t.me/OroPredictBot` currently shows generic placeholder text. When shared in any chat, it looks unfinished.

### Action

In Telegram, message **@BotFather** and run these for **@OroPredictBot**:

**`/setdescription`** (longer description in bot profile):
```
Predict the future. Win real money.
Sports · Crypto · Politics · Weather.
Build your reputation. Yes or No.
```

**`/setabouttext`** (short bio shown in chats):
```
The prediction market on Telegram. Yes or No.
```

**`/setuserpic`** — upload Oro logo
- Gold "ORO" wordmark on dark navy background
- 640×640 minimum, PNG, square
- Coordinate with whoever owns visual identity

**`/setcommands`** — confirm:
```
start - Open Oro
help - How it works
verify - Link your account
predict - Browse markets
```

**`/setdomain`** — confirm `tma.oro.fun` is registered as the Mini App domain.

**`/newapp` or `/editapp`** — confirm the Mini App is named "Oro" with proper logo and short description.

After this, every share of `t.me/OroPredictBot` will look polished. This is the highest-leverage 10 minutes you'll spend this month.

---

## 2. Build the marketing site at oro.fun

### Problem

Anyone who lands on `oro.fun` (Google search, shared link, typed manually) currently sees:

> "You need to enable JavaScript to run this app."

Dead end. No description, no preview, no CTA. If a journalist, partner, or potential user finds Oro this way, they bounce.

### What to build

A static, server-rendered marketing site at `oro.fun`. Single page, scannable, dark theme, drives one action: **tap "Open in Telegram"** → `t.me/OroPredictBot`.

### Sections

- **Hero** — Logo, "Yes or No." tagline, one-line subtitle, Open in Telegram CTA
- **Live markets preview** — 2-3 sample markets (sports, crypto) so visitors get the concept
- **How it works** — 3 steps: pick a market → take a side → win and cash out
- **Why Oro** — Reputation, Duels, Streaks, Share cards (feature cards)
- **Stats / social proof** — Total markets resolved, biggest wins (anonymized), top predictors
- **FAQ section** — see Section 4 below
- **Footer** — Terms, privacy, responsible gaming, contact, link to 21.tech.bt

### Tech recommendation

- **Next.js** — server-rendered, proper OG tags out of the box, fast first paint, great SEO
- **Tailwind CSS** for styling
- Single page, no client-side routing
- Bundle under 100KB JS
- Host on Vercel or similar

This is a different stack from the React + Vite Mini App. That's fine — keep the Mini App as-is, build the marketing site separately.

### Mandatory meta tags

```html
<title>Oro — Yes or No.</title>
<meta name="description" content="Predict outcomes. Win real money. The prediction market on Telegram." />
<meta name="theme-color" content="#0a0f1d" />

<!-- Open Graph -->
<meta property="og:type" content="website" />
<meta property="og:url" content="https://oro.fun" />
<meta property="og:title" content="Oro — Yes or No." />
<meta property="og:description" content="Predict outcomes. Win real money. The prediction market on Telegram." />
<meta property="og:image" content="https://oro.fun/og-image.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="Oro — Yes or No." />
<meta name="twitter:description" content="Predict outcomes. Win real money. The prediction market on Telegram." />
<meta name="twitter:image" content="https://oro.fun/og-image.png" />
```

### OG image

A 1200×630 PNG at `oro.fun/og-image.png`. Dark navy background, gold ORO wordmark, "Yes or No." tagline, oro.fun URL. This is what shows up when anyone shares `oro.fun` in any chat. Designer task — a draft template is available, ask Gelay.

A starter HTML mockup of the full marketing site has already been drafted — ask Gelay for handover.

---

## 3. Fix tma.oro.fun meta tags (1 hour)

Even though `tma.oro.fun` is plumbing and shouldn't be shared, people occasionally will. Currently it shows "Oro - Telegram Mini App" — that's a developer placeholder.

### Action

Update the meta tags inside the React app's `index.html`:

```html
<title>Oro — Yes or No.</title>
<meta name="description" content="Predict outcomes. Win real money." />
<meta property="og:title" content="Oro — Yes or No." />
<meta property="og:description" content="Predict outcomes. Win real money." />
<meta property="og:image" content="https://oro.fun/og-image.png" />
<meta property="og:url" content="https://t.me/OroPredictBot" />
```

The `og:url` deliberately points to the **bot link** so accidental shares of `tma.oro.fun` still funnel users into Telegram.

---

## 4. Build a real FAQ on oro.fun

Lucky Pem has an exhaustive FAQ that builds trust — covers getting started, payments, prizes, security, age verification, transparency, technical issues. Oro currently has nothing equivalent.

### FAQ topics to cover

- What is a prediction market?
- How does Oro work?
- Is this legal in Bhutan?
- How do I sign up?
- How do deposits and withdrawals work?
- What's the platform fee?
- How are markets resolved? (oracle, dispute window)
- What happens if there's a dispute?
- How is my data protected?
- Can I play on web and Telegram with the same account?
- What are the responsible gaming tools?
- What's the minimum age?

The FAQ should live at `oro.fun/faq` (or as a section on the homepage) and be indexable by search engines.

---

## 5. Build a Resolutions / Transparency page

Lucky Pem publishes cryptographic proofs for every draw (drand beacon + commit-reveal protocol). It builds trust. Oro should publish settled markets with resolution details.

### What to build

A `/resolutions` page on `oro.fun` (and accessible inside the Mini App) showing:

- All settled markets in reverse chronological order
- For each market: question, outcome, settlement source/proof, total pool size, winner count, payout per winner
- Filterable by category (sports, crypto, etc.) and date
- Public, no login required

This is also a regulatory shield — under GMC, having a public, auditable resolution record is defensible.

---

## 6. Add Responsible Gaming tools

Lucky Pem has spending limits, cool-off periods, self-exclusion. Oro doesn't visibly have these. This is critical for:

- Regulatory compliance under GMC
- User wellbeing (especially first-time bettors)
- Long-term platform credibility

### What to build

A Responsible Gaming section in the Mini App settings:

- **Daily / weekly / monthly spending limits** — user sets, platform enforces
- **Maximum single bet limit**
- **Cool-off period** — pause all betting for 24 hours to 1 month, user-triggered
- **Self-exclusion** — block all activity for 1 month to 1 year, irreversible until period ends

Real-time tracking and enforcement at the bet placement endpoint. Display current limits and consumption in the user's profile.

---

## 7. SEO — non-negotiable

Every public page on `oro.fun` must be properly optimized for search. This is not an afterthought — it determines whether anyone finds Oro outside of Telegram.

### Technical SEO baseline

- **Server-side rendering** — content must be in the HTML response, not injected by JavaScript. Google can technically render JS, but SSR is faster, more reliable, and required for many other crawlers (LinkedIn, Twitter, Telegram itself).
- **`<title>` and `<meta description>`** — unique per page. Title under 60 chars, description under 160 chars, with target keywords.
- **Semantic HTML** — proper `<h1>`, `<h2>`, `<article>`, `<section>`. One `<h1>` per page. Headings reflect content hierarchy, not styling.
- **Canonical URLs** — every page has `<link rel="canonical">` pointing to its canonical version. Avoid duplicate content from query params.
- **Mobile-first** — Google indexes the mobile version. Test in Chrome DevTools mobile emulation. Lighthouse mobile score should be 90+.
- **Page speed** — Largest Contentful Paint under 2.5s, Cumulative Layout Shift under 0.1, First Input Delay under 100ms. Use `next/image` for all images, lazy-load below-the-fold content.
- **HTTPS everywhere** — confirmed via cert auto-renewal.

### On-page SEO per route

| Route | Title | Description | Target keywords |
|---|---|---|---|
| `/` | Oro — Yes or No. Predict and Win on Telegram | Predict outcomes. Win real money. The prediction market on Telegram for sports, crypto, weather, and more. | prediction market telegram, oro app, yes or no app, bhutan prediction market |
| `/faq` | Oro FAQ — How Prediction Markets Work | Common questions about Oro, the prediction market on Telegram. How to deposit, withdraw, place bets, and more. | how prediction markets work, oro faq, telegram betting app |
| `/how-it-works` | How Oro Works — 3 Steps to Predict and Win | Pick a market, take a side, win when you're right. See how Oro's prediction markets work. | how to use oro, prediction market guide |
| `/resolutions` | Resolved Markets — Oro Transparency Record | All settled markets on Oro with verifiable resolution sources. Public, auditable record of every prediction. | oro market results, prediction market history |
| `/responsible-gaming` | Responsible Gaming on Oro | Spending limits, cool-off periods, self-exclusion. Tools to keep predictions fun and safe. | responsible gaming, betting limits, prediction market safety |

### Structured data (JSON-LD)

Add JSON-LD schema markup to every page. At minimum:

- **`Organization`** schema on the homepage (name, logo, url, sameAs links to Telegram, social accounts)
- **`WebSite`** schema with `SearchAction` (so Google shows a search box for oro.fun)
- **`FAQPage`** schema on the FAQ page (each Q&A wrapped properly — qualifies for FAQ rich results in Google)
- **`SoftwareApplication`** schema on the homepage (Oro is a Telegram Mini App — declare it as such with category, operating system, offers)
- **`BreadcrumbList`** on inner pages

Use [Google's Rich Results Test](https://search.google.com/test/rich-results) to validate before deploying.

### Indexability

- **`robots.txt`** at `oro.fun/robots.txt` — allow all, point to sitemap
- **`sitemap.xml`** at `oro.fun/sitemap.xml` — auto-generated, listed in robots.txt, submitted to Google Search Console and Bing Webmaster Tools
- **Submit to Google Search Console** — verify ownership, monitor coverage and queries, set up alerts for indexing errors
- **Submit to Bing Webmaster Tools** — same drill, smaller traffic but free signal
- **404 handling** — proper 404 status codes, not soft 404s. Custom 404 page with links back to the homepage and FAQ.

### Content SEO (longer-term)

A static landing page alone won't rank. Build a small blog or content layer at `oro.fun/blog` with articles like:

- "What is a prediction market? A beginner's guide"
- "How prediction markets are different from sports betting"
- "Why Bhutan is the right place for the next prediction market"
- "Oro vs Polymarket: what's the difference?"
- "How to predict the FIFA World Cup 2026"

These articles capture long-tail searches, build authority over time, and can be referenced from press, partner content, and community posts. Each article must follow the same SEO standards as the marketing pages.

### What NOT to do

- Don't keyword-stuff. Write for humans first.
- Don't hide content behind JavaScript that crawlers can't see.
- Don't use carousels for primary content — they're invisible to most crawlers.
- Don't redirect chains (one 301 max). Don't 302 anything that should be permanent.
- Don't block search engines with `<meta name="robots" content="noindex">` on pages you want indexed.

### Telegram-specific note

When `t.me/OroPredictBot` is shared in a Telegram chat, Telegram fetches the OG tags from the bot's profile (not from `oro.fun`). Make sure both surfaces have proper Open Graph tags so previews are rich everywhere.

---

## 8. Switch oro.fun to server-side rendering

The Mini App at `tma.oro.fun` should stay React + Vite (client-side SPA) — that's fine for a webview-loaded app.

But the marketing site at `oro.fun` should be **server-rendered** (Next.js). Reasons:

- Proper OG tags work without JS
- Faster first paint for visitors on slow connections
- SEO indexable for "prediction market Bhutan", "yes or no app", etc.
- Lucky Pem already does this — it's the right pattern

---

## Priority order

### This week (10 minutes to 2 hours each)

| # | Task | Effort |
|---|---|---|
| 1 | Update @OroPredictBot in BotFather (description, about, logo, commands) | 10 min |
| 2 | Update tma.oro.fun meta tags | 1 hour |
| 3 | Stop sharing `tma.oro.fun` anywhere — use `t.me/OroPredictBot` instead | n/a |

### Next 2 weeks

| # | Task | Effort |
|---|---|---|
| 4 | Build oro.fun marketing site (Next.js, SSR, single page) | 5 days |
| 5 | Generate and host OG image at oro.fun/og-image.png | 1 day |
| 6 | Build FAQ section on oro.fun (with FAQPage JSON-LD schema) | 1 day |
| 7 | Add full SEO baseline (meta tags, JSON-LD, sitemap.xml, robots.txt, canonical URLs) | 2 days |
| 8 | Submit oro.fun to Google Search Console + Bing Webmaster Tools | 30 min |

### Before public launch (June 11)

| # | Task | Effort |
|---|---|---|
| 9 | Build /resolutions transparency page on oro.fun (indexable, schema-marked) | 3 days |
| 10 | Add Responsible Gaming tools to the Mini App | 5 days |
| 11 | Run Lighthouse audit — fix any performance, accessibility, SEO issues to 90+ | 1 day |
| 12 | Publish first 3-5 SEO blog posts at oro.fun/blog | ongoing |

---

## Questions

Reach out to Gelay with any questions on prioritization, scope, or design direction.

A starter HTML mockup of the oro.fun landing page and an OG image template are already drafted — ask Gelay for handover.

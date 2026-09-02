# Cloudflare costs and SkillCanvas domain check

Checked 27 August 2026 (Australia/Sydney). Prices are USD unless stated otherwise.

## Bottom line

- **Current SkillCanvas deployment: $0/month on Cloudflare.** The app can be shipped as static Worker assets. Cloudflare says static-asset requests are free and unlimited, asset storage has no additional charge, and bandwidth/egress is not charged. No paid Worker is needed for the current browser-local app. [Static Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- **`skillcanvas.dev`: likely about $12.20/year plus any applicable tax/card FX.** An authoritative Google Registry RDAP query returned `404 Not Found` (`"skillcanvas.dev not found"`), meaning it is not currently registered. However, only Cloudflare's real-time registrar check can prove it is registrable and whether it is standard or premium-priced at purchase time. [Google Registry RDAP endpoint](https://pubapi.registry.google/rdap/domain/skillcanvas.dev), [Cloudflare registrar check semantics](https://developers.cloudflare.com/api/resources/registrar/)
- **`skillcanvas.ai`: unavailable at normal registration price.** The authoritative `.ai` RDAP record is active: registered 23 January 2026 and expiring 23 January 2028. It also resolves to an existing product called SkillCanvas that visualises Claude Code skills—a direct category collision, not merely a parked name. [Authoritative `.ai` RDAP record](https://rdap.identitydigital.services/rdap/domain/skillcanvas.ai), [existing SkillCanvas site](https://skillcanvas.ai/)

## Hosting cost

| Current/future shape    |   Expected Cloudflare cost | Caveat                                                                                                                                                                                             |
| ----------------------- | -------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static Vite app only    |               **$0/month** | Static asset requests are free and unlimited; asset storage has no extra charge.                                                                                                                   |
| Free Worker logic added | **$0/month** within limits | Free plan allows 100,000 Worker invocations/day and 10 ms CPU/invocation. Static requests do not consume this quota unless routing deliberately invokes the Worker first.                          |
| Workers Paid            |       **$5/month minimum** | Includes 10 million dynamic requests/month, then $0.30/million; includes 30 million CPU-ms/month, then $0.02/million CPU-ms. There are no egress charges. This is unnecessary for the current app. |
| Optional D1 persistence |    **$0 within free tier** | Free tier: 5 million rows read/day, 100,000 rows written/day, and 5 GB total. Paid Workers includes 25 billion reads/month, 50 million writes/month, and 5 GB before overages.                     |

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

A custom apex domain does not require a paid Cloudflare zone. Cloudflare DNS queries are free and uncapped on Free/Pro/Business plans, and Universal SSL certificates are issued and renewed free. DNSSEC and WHOIS redaction are also free. [DNS pricing FAQ](https://developers.cloudflare.com/dns/faq/), [Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/), [DNSSEC](https://developers.cloudflare.com/registrar/get-started/enable-dnssec/), [WHOIS redaction](https://developers.cloudflare.com/registrar/account-options/whois-redaction/)

## Domain pricing confidence

Cloudflare does not publish a stable public checkout table. Its official position is wholesale registry and ICANN cost with no markup, and the authenticated Registrar API/dashboard returns the real-time registration and renewal prices. Registry prices can change, and premium names can cost much more. [Registrar FAQ](https://developers.cloudflare.com/registrar/faq/), [Registrar API guide](https://developers.cloudflare.com/registrar/registrar-api/)

Planning figures visible on 27 August 2026:

| TLD    |                                      Planning price | Purchase implication                                                                                                                                     | Confidence                                                                                                                                                                                                                                                                                         |
| ------ | --------------------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.dev` |            **$12.20/year** registration and renewal | If `skillcanvas.dev` passes Cloudflare's final check, expect roughly this amount at checkout.                                                            | Secondary live mirror of Cloudflare prices, updated 27 Aug 2026; confirm in dashboard. [Price mirror](https://cfdomainpricing.com/)                                                                                                                                                                |
| `.ai`  | **$80/year**, normally **$160 for a two-year term** | Not relevant for `skillcanvas.ai`, because that exact name is registered. Aftermarket acquisition would be privately negotiated and could cost anything. | Secondary live mirror reports $80/year; Anguilla government minutes discuss increasing the two-year registry price into the $160–$180 range. [Price mirror](https://cfdomainpricing.com/), [Government of Anguilla executive minutes](https://www.gov.ai/document/2026-02-25-123733_745323885.pdf) |

Cloudflare's official API documentation currently uses `$10.11/year` for a standard `.dev` in an illustrative response. That is an example, not a live quote for `skillcanvas.dev`, so the dashboard's final domain check should be treated as authoritative. [Official API example](https://developers.cloudflare.com/registrar/registrar-api/)

## Hidden and optional costs/caveats

- **Tax and currency conversion:** Cloudflare may collect tax based on billing address. An Australian card may also add issuer FX fees when converting USD to AUD. Cloudflare's public tax page does not state an Australia-specific rate, so the checkout total is the reliable figure. [Cloudflare sales-tax policy](https://developers.cloudflare.com/billing/understand/sales-tax/)
- **Registrar payments are final:** registrations and renewals are non-refundable; auto-renew is enabled by default. Cloudflare recommends disabling it at least 30 days before expiry if the name should lapse. [Registrar FAQ](https://developers.cloudflare.com/registrar/faq/), [renewals](https://developers.cloudflare.com/registrar/account-options/renew-domains/)
- **Nameserver constraint:** domains registered through Cloudflare Registrar must use Cloudflare nameservers while they remain there. That does not force Cloudflare hosting, but it does force Cloudflare authoritative DNS. [Register a domain](https://developers.cloudflare.com/registrar/get-started/register-domain/)
- **`.dev` requires HTTPS:** the entire TLD is HSTS-preloaded. Cloudflare's free Universal SSL satisfies this, but a broken certificate/DNS setup cannot fall back to HTTP. [Google Registry `.dev` policy](https://www.registry.google/policies/registration/dev/)
- **Paid plan is account-wide and separate:** the $5 Workers Paid subscription is separate from Cloudflare Free/Pro/Business zone plans. Do not enable it merely to serve the static app. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- **Cloudflare account credits cannot pay Registrar charges.** Any hackathon credits would cover eligible Cloudflare services, not the domain purchase. [Cloudflare billing policy](https://developers.cloudflare.com/billing/understand/billing-policy/)

## Recommendation

Use Cloudflare Free for hosting, so the ongoing platform cost is **$0**. Do **not** pursue `skillcanvas.ai`: it is owned and used by a substantially overlapping product. Although `skillcanvas.dev` appears unregistered and is inexpensive, buying it would not eliminate the same-name/category confusion. Treat the domain decision as a naming decision first, then run Cloudflare's final availability/price check immediately before buying.

The smallest check before spending money is: search `skillcanvas.dev` inside **Cloudflare Dashboard → Domain Registration → Register Domains** and confirm `registrable`, `tier: standard`, and the displayed registration/renewal price. Domain availability can change at any moment.

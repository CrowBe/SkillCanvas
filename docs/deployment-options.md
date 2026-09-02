# Skill Canvas deployment decision

Research checked 2026-08-27 against the official challenge pages and first-party platform documentation.

## Decision

**Deploy the existing app to Cloudflare Workers using static assets, with one stable production URL for judging. Do not rebuild Skill Canvas from the starter.** Borrow only the Cloudflare deployment shape (`wrangler` configuration, SPA fallback, and optional `_headers` file), then verify the existing production build in ChatGPT's in-app browser and WebMCP-enabled Chrome.

Cloudflare wins narrowly because its official hackathon starter is unusually close to this project: React, Vite, browser-local persistence, lifecycle-managed page-local WebMCP tools, an unsupported-browser state, and Worker deployment. Cloudflare also recommends Workers for new applications, and requests that resolve directly to Workers static assets are free and unlimited. This reduces deployment risk without requiring a framework migration. [Cloudflare WebMCP React starter](https://github.com/cloudflare/agents/tree/main/examples/webmcp-react), [Cloudflare Pages/Workers direction](https://developers.cloudflare.com/pages/), [Workers static-assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)

**Vercel is the fallback if the Cloudflare deployment introduces any Worker-specific build or runtime regression.** It is probably the smallest configuration-only deployment for an ordinary Vite SPA, but the hackathon's Vercel resources are a Next.js commerce storefront and its WebMCP patch, not a generic page-local React/Vite starter. There is no competition advantage to adopting that storefront architecture. [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite), [Vercel storefront](https://github.com/vercel/shop), [storefront WebMCP implementation](https://github.com/vercel/shop/pull/498)

ChatGPT Sites remains a legitimate fast publishing option, but not the default for this repository-backed, test-heavy app. The challenge itself notes that Sites requires a paid ChatGPT plan and has regional availability restrictions. Use it only if its first-party workflow can import and faithfully deploy this existing Vite build, preserve the required public source-repository workflow, and expose a stable judge URL; those capabilities were not established by the Cloudflare/Vercel sources reviewed here. [Official challenge resources and FAQ](https://webmcp.devpost.com/resources)

## Competition constraints that matter

- The entry needs a working live URL accessible in ChatGPT's in-app browser or Chrome with WebMCP enabled. Cloudflare, Vercel, ChatGPT Sites, and any other host are explicitly allowed. The app must run consistently and match its submitted description and demo. [Official rules, section 4](https://webmcp.devpost.com/rules)
- The code repository must be public on GitHub, GitLab, or Bitbucket, include all source/assets/instructions needed to run the project, and show an open-source license at the top of the repository page. The current local folder is not yet a Git repository and no `LICENSE` file was found; those are submission blockers independent of hosting.
- A public YouTube demo shorter than three minutes, with audio, is required by the rules. The rules control over inconsistent FAQ wording. [Official rules](https://webmcp.devpost.com/rules)
- Existing projects must clearly distinguish pre-hackathon work from meaningful WebMCP extensions made after 2026-08-25, using dated commits or equivalent evidence. This makes initializing and publishing the repository promptly important. [Official rules](https://webmcp.devpost.com/rules)
- There is one general winner category. Cloudflare and Vercel credits are included in the same top-ten prize bundle; neither host creates a separate sponsor category. Judging is equally weighted across WebMCP leverage, execution, impact, and creativity/ambition. Hosting choice is not a judging criterion. [Official overview](https://webmcp.devpost.com/), [official rules, judging and prizes](https://webmcp.devpost.com/rules)
- Treat the submitted URL, public repository, and Devpost entry as frozen from **2026-09-03 1:00 pm PT through winner announcement**. The rules bar submission changes after the deadline, and the official FAQ specifically warns not to change the live site or repository during judging. Keep further work on a separate fork after submission. [Official rules](https://webmcp.devpost.com/rules), [official FAQ](https://webmcp.devpost.com/resources)

Hosting on Cloudflare or Vercel is therefore permitted supporter infrastructure, not preferential judging support. No reviewed official source promises a scoring benefit for using either platform.

## Fit comparison

| Concern                 | Cloudflare Workers                                                                                                                                                      | Vercel                                                                                                                                                                                                                                                                       | ChatGPT Sites                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Current static Vite app | Strong. Workers supports Vite static assets and SPA fallback; Cloudflare's official WebMCP starter uses the same broad shape.                                           | Strong. Vercel recognizes Vite and provides Git/PR deployments; add a SPA rewrite only if client-side deep routes are introduced.                                                                                                                                            | Not established in this research; validate import fidelity before relying on it.                                                        |
| WebMCP-specific value   | Best official starter match. Cloudflare Browser Run also offers experimental WebMCP lab sessions, useful as an additional demo/test lane—not production proof.          | Official hackathon example is a Next storefront, useful as implementation evidence but not a suitable starter for Skill Canvas.                                                                                                                                              | Its in-app context may be convenient, but hosting there is not required for ChatGPT's browser to exercise WebMCP on another HTTPS host. |
| Origin-trial delivery   | `Origin-Trial` can be added with a static `_headers` rule, or use the portable HTML `<meta>` token.                                                                     | `Origin-Trial` can be added with `vercel.json`, or use the same portable HTML `<meta>` token.                                                                                                                                                                                | Token/header controls not established here.                                                                                             |
| Production and previews | Stable `https://<worker>.<account>.workers.dev` production URL; versioned and branch-aliased public preview URLs are available.                                         | Stable production alias plus public-by-default commit and branch preview URLs.                                                                                                                                                                                               | Not established here.                                                                                                                   |
| Free-tier risk          | Static-asset requests are free and unlimited. A dynamic Worker invocation on Free is limited to 100,000 requests/day and 10 ms CPU, so keep asset routing static-first. | Hobby is $0 with 1M edge requests and 100 GB transfer/month, but Vercel describes Hobby as personal/non-commercial and over-limit usage can stop until the limit resets. Whether a prize entry is "non-commercial" is not answered. Pro removes that ambiguity at $20/month. | Requires a paid ChatGPT plan and is unavailable in some regions according to the official challenge FAQ.                                |
| Lock-in                 | Low if only deployment config/static assets are adopted. Higher if the whole Cloudflare starter, `agents`, D1, or a Worker backend is imported—none is needed.          | Very low for plain static Vite. High and unnecessary if the Next storefront example is adopted.                                                                                                                                                                              | Potentially higher if source/build/export cannot remain repository-authoritative; unverified.                                           |
| Judge reliability       | Strong if the production URL is public, static-first, frozen, and tested in both judge browsers.                                                                        | Equally capable for a small static app; usage limits are unlikely to matter, but Hobby terms are the cleaner risk to avoid.                                                                                                                                                  | Depends on product availability and faithful deployment; validate before choosing.                                                      |

Sources: [Workers Vite static assets and headers](https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/), [Workers preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Vercel generated URLs](https://vercel.com/docs/deployments/generated-urls), [Vercel custom headers](https://vercel.com/docs/project-configuration/vercel-json), [Vercel pricing](https://vercel.com/pricing), [Vercel limits](https://vercel.com/docs/limits)

## WebMCP and origin-trial deployment detail

Hosting does not itself make `document.modelContext` available. The page still needs a supported judge browser and must remain a secure, origin-keyed context. For ordinary top-level use, no host-specific WebMCP runtime or server is required; Skill Canvas registers tools in the browser.

For Chrome's deployed-origin trial, register the **exact stable production origin** and serve its token on every relevant HTML response, either as:

```html
<meta http-equiv="origin-trial" content="TOKEN" />
```

or:

```text
Origin-Trial: TOKEN
```

Tokens are origin-bound and time-limited. Do not give judges an ephemeral preview hostname unless that origin is separately covered and verified. The HTML meta form is the most host-portable option; a response header is easy on both Cloudflare and Vercel. [Chrome origin-trial setup](https://developer.chrome.com/docs/web-platform/origin-trials/), [WebMCP origin trial](https://developer.chrome.com/blog/ai-webmcp-origin-trial)

Cloudflare's starter notes that a cross-origin iframe needs `allow="tools"`; this does not affect a normal top-level judging URL. Cloudflare Browser Run's WebMCP pool is explicitly experimental and currently has automation limitations, so it should supplement—not replace—testing in the actual ChatGPT browser and Chrome configuration named in the rules. [Cloudflare Browser Run WebMCP](https://developers.cloudflare.com/browser-run/features/webmcp/)

## Minimal deployment plan

1. Initialize the public repository, add an explicit open-source license, and record which work was done during the submission window.
2. Add the smallest Cloudflare Workers static-assets configuration with SPA fallback; do not port starter application code or introduce server persistence.
3. Add the production origin-trial token through HTML meta or `_headers`; keep the existing runtime feature probe and complete browser fallback.
4. Deploy to one stable public production URL. Keep preview URLs for review only.
5. Verify from outside the deployment account: load, import/create, lint, revise, compare, export, reload persistence, discover each WebMCP tool, and invoke the documented agent flow in both ChatGPT's in-app browser and Chrome 149+ with WebMCP enabled.
6. Save the final deployment URL, commit SHA, token validity evidence, browser versions, and a screen recording. Submit, then freeze the deployment and repository through judging.

## Smallest falsifier

Deploy the current unmodified production build through the minimal Cloudflare configuration, then open the stable production URL in the exact ChatGPT in-app browser judges will use and run:

```js
({
  secure: window.isSecureContext,
  modelContext: typeof document.modelContext,
  registerTool: typeof document.modelContext?.registerTool,
});
```

If the app cannot complete its fallback workflow **or** `registerTool` is not `"function"` in that judge browser after the production-origin setup is verified, Cloudflare has provided no practical advantage. Deploy the same `dist/` to Vercel, apply the same token, and repeat the probe and full workflow. Choose the host that passes on the stable public URL without application-code changes.

## Explicit uncertainties

- No official source reviewed says that a supporter-hosted project receives preferential judging; the rules point the other way by allowing any provider and omitting hosting from the criteria.
- The official Vercel hackathon resources do not expose a generic WebMCP starter comparable to Cloudflare's React starter. A differently named Vercel starter may exist, but it is not the resource the organizers linked; remote MCP/App SDK starters are not equivalent to page-local WebMCP.
- Vercel does not explicitly classify a prize hackathon entry under Hobby's personal/non-commercial restriction. Use Pro or obtain written confirmation if Vercel becomes the production host.
- ChatGPT Sites import fidelity, custom headers, preview/production URL behavior, and source round-tripping need separate confirmation from current first-party Sites documentation before selecting it.
- Origin-trial duration and token validity can change. Re-check and capture proof immediately before the submission freeze; mocked adapter tests are not deployment proof.

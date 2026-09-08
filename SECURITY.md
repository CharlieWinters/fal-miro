# Security policy

## Reporting a vulnerability

Please report security issues privately, **not** as a public GitHub issue.

Use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository — the **Security** tab → **Report a vulnerability**.

This is a personal project maintained in spare time. Expect an
acknowledgement within a week or so. There is no bounty, but credit is given
in the advisory unless you'd rather stay anonymous.

## Supported versions

The `main` branch only. There are no released versions and no backports.

## What this app handles

Anyone deploying this should understand the trust model, because most of the
risk is in how it is configured rather than in the code.

### Two ways to connect, two different exposures

The panel's Settings screen offers two connection modes, saved per browser in
`localStorage`, never on the board.

**Client mode (the default).** A fal.ai API key is pasted into Settings and
stored in this browser's `localStorage`; the browser calls fal directly. The
key is unscoped and not spend-limited. Anyone who can read that browser's
storage — a shared machine, another site under the same GitHub Pages user
origin, browser sync — has the key. Suitable for one person on their own
device; not for a shared machine or a shared board where others will also use
the app.

**Backend mode.** You deploy `backend/` and the browser only ever holds a
shared secret for it. This is the mode the rest of this document is about.

| Secret | Lives in | Reaches the browser? |
| --- | --- | --- |
| `FAL_KEY` — fal.ai inference key, **billable** | backend env (`.env` / Workers secret) | Never, in backend mode |
| `ADMIN_KEY` — fal.ai admin key, reads billing | backend env | Never |
| `BACKEND_KEY` — shared proxy secret | backend env + the browser | **Yes** |
| A fal.ai key in client mode | the browser only | **Yes** |

`BACKEND_KEY` is the actual gate on `/api/fal/*`: every request must carry it
as `x-fal-proxy-key`, and it is compared in constant time. **Treat it as
public to anyone who can open the panel.** It stops the open internet from
spending your fal credits and nothing more; anyone you give the app to can read
it out of `localStorage` and call your backend directly, for any fal endpoint,
with no per-call cost ceiling.

`ALLOWED_ORIGINS` is CORS. It stops other websites' *browsers* from reading
responses; it does not stop a direct request from reaching the backend. Set it
to your exact frontend origin anyway, because it is what keeps a malicious page
from using a visitor's browser to call your backend.

### The unauthenticated proxy

`GET /proxy?url=…` relays media from fal's CDN so the capture tools can draw it
to a canvas. It cannot require the shared secret, because it is loaded through
`src` attributes. Its protections are: only `fal.media` hosts, every redirect
hop re-checked against that list; only image, video, audio and glTF content
types; a size cap; and `nosniff` plus a sandboxing Content-Security-Policy on
everything it returns. Note that fal.media hosts every fal user's uploads, so
the host check alone says nothing about the content — that is what the
content-type and CSP rules are for. There is no rate limit; on Cloudflare
Workers use Cloudflare's.

### Inside the Miro page

The panel, modal and headless iframes talk over `postMessage`. Every other
Miro app installed on the team is a sibling iframe on the same page. Messages
are sent with this app's own origin as the target and checked for that origin
on receipt, so a stranger's iframe neither receives prompts and output URLs
nor can inject a result. Do not relax that to `'*'`.

### Deploying this publicly

The default posture suits a single user or a small trusted group. Before putting
it anywhere wider:

- Prefer **backend mode** and tell users why.
- **Set `ALLOWED_ORIGINS`** to your exact frontend origin.
- **Assume `BACKEND_KEY` will leak** and budget accordingly — set spend limits
  on the fal account rather than relying on the key staying private.
- **Omit `ADMIN_KEY`** unless you want the credits display. It is a
  higher-privilege key and the app works without it.
- **Rate-limit the backend.** There is none built in.
- There is no per-user authentication or isolation. Everyone with the panel
  shares one fal account and one budget.
- `/healthz` tells anonymous callers only that the process is up; which keys
  are configured is reported only to a caller holding `BACKEND_KEY`.

### Generated media

Outputs are fetched from fal's CDN and added to the Miro board by URL. Those URLs
are unauthenticated and effectively public to anyone holding the link. Prompts
and reference images are sent to fal; see fal's own terms for retention.

## Out of scope

- Miro's own platform and Web SDK — report those to
  [Miro](https://miro.com/trust/).
- fal.ai's API and the models themselves — report those to fal.
- Spend incurred by a `BACKEND_KEY` or a client-mode fal key you shared, which
  is documented behaviour above rather than a vulnerability.

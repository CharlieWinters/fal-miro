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

### Keys

Two secrets matter:

| Secret | Lives in | Reaches the browser? |
| --- | --- | --- |
| `FAL_KEY` — fal.ai inference key, **billable** | `backend/.env` | Never |
| `ADMIN_KEY` — fal.ai admin key, reads billing | `backend/.env` | Never |
| `BACKEND_KEY` — shared proxy secret | `backend/.env` + the browser | **Yes** |

The backend exists to keep `FAL_KEY` off the client. The frontend calls
`/api/fal/*` and the backend attaches the real key server-side.

`BACKEND_KEY` is different: it is stored in the browser and sent as
`x-fal-proxy-key` on every request. **Treat it as public to anyone who can open
the panel.** It is a gate, not a secret — it stops the open internet from
spending your fal credits, and nothing more. Anyone you give the app to can read
it out of `localStorage` and call your backend directly.

### Deploying this publicly

The default posture suits a single user or a small trusted group. Before putting
it anywhere wider:

- **Set `ALLOWED_ORIGINS`** to your exact frontend origin. It is CORS-enforced
  and is the main thing keeping other sites off your backend.
- **Assume `BACKEND_KEY` will leak** and budget accordingly — set spend limits on
  the fal account rather than relying on the key staying private.
- **Omit `ADMIN_KEY`** unless you want the credits display. It is a
  higher-privilege key and the app works without it.
- **Rate-limit the proxy.** There is none built in. On Cloudflare Workers, use
  Cloudflare's.
- There is no per-user authentication or isolation. Everyone with the panel
  shares one fal account and one budget.

### Generated media

Outputs are fetched from fal's CDN and added to the Miro board by URL. Those URLs
are unauthenticated and effectively public to anyone holding the link.

## Out of scope

- Miro's own platform and Web SDK — report those to
  [Miro](https://github.com/miroapp/.github/blob/master/SECURITY.md).
- fal.ai's API and the models themselves — report those to fal.
- Spend incurred by a `BACKEND_KEY` you shared, which is documented behaviour
  above rather than a vulnerability.

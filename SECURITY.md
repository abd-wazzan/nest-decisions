# Security Policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through a
[GitHub security advisory](https://github.com/abd-wazzan/nest-decisions/security/advisories/new)
on this repository. Do not open a public issue, pull request or discussion for a security problem.

Include what you found, how to reproduce it, the affected package and version, and the impact
you expect. Please do not include real API keys, credentials or personal data in a report.

You can expect an acknowledgement within 5 working days. This is a small project maintained by
volunteers, so fix timelines depend on severity and complexity; we will keep you updated and
credit you in the advisory if you wish.

## Supported versions

While the packages are pre-1.0, only the latest published release of each package receives
security fixes. The three packages are released in lockstep, so update them together.

## What is in scope

- Credential or secret exposure (for example an API key appearing in logs, errors, audit records
  or serialized objects).
- Personal data reaching a provider, a cache, an audit record or a review queue when the
  documented redaction and minimal-state controls are used correctly.
- A gate (`@Gate`, `verdictFromRisk`, `verdictFromTrust`) allowing a request it should not, for
  example on an invalid or missing probability.
- Request forgery or token forwarding through the provider's HTTP handling.
- Supply-chain issues in the published packages.

## What is not

- A model returning a wrong judgment. Decisions are probabilistic and never a substitute for
  authorization; see the production checklist in `docs/production-checklist.md`.
- Vulnerabilities in a third-party provider's service, or in your own policy thresholds.

## Disclosure

We prefer coordinated disclosure: please give us a reasonable chance to fix the issue before it
is made public.

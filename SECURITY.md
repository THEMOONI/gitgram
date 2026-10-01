# Security policy

This file is the vulnerability-reporting and incident procedure for Gitgram. Contact details marked TODO are placeholders. The owner fills those in and confirms whether the Cyber Resilience Act obligations below apply to a given distribution.

## Reporting a vulnerability

Report suspected vulnerabilities privately. Do not open a public issue, pull request, or commit for an undisclosed security flaw.

**TODO (owner): replace this placeholder with a monitored address before relying on it.**

- Contact: `security@<domain>`

Include the Gitgram version, what is affected, and steps to reproduce if you have them. You will get a human reply only after the owner connects that address to a mailbox they actually read.

## Supported versions

| Version | Security fixes |
| --- | --- |
| 1.0.x | Supported |
| Anything older than 1.0 | Not supported |

The supported line is the 1.0.x release published from this repository. No older release line is maintained.

## Coordinated disclosure

These timings are a proposed default. **TODO (owner): confirm or replace them.**

- Acknowledge a private report within 3 business days.
- Investigate and, when a fix is possible, prepare a release before public discussion.
- Public disclosure is coordinated with the reporter after a fix is available, or 90 days after the report, whichever comes first, unless both sides agree to a different date.

## EU Cyber Resilience Act

The Commission describes the reporting rules at <https://digital-strategy.ec.europa.eu/en/policies/cra-reporting>. The summary below follows that page. It is not legal advice, and it does not decide that a particular Gitgram deployment is in scope.

From 11 September 2026, manufacturers must report actively exploited vulnerabilities and severe incidents that affect the security of products with digital elements. Open-source software stewards have related reporting obligations from 11 December 2027 (Article 24(3), as timed by Article 71(2)). **TODO (owner): confirm whether Scavvers Labs is acting as manufacturer, as an open-source steward, or neither, and who is responsible for filing.**

### Actively exploited vulnerabilities

Once the manufacturer becomes aware of an actively exploited vulnerability:

1. Submit an **early warning within 24 hours**.
2. Submit a **notification within 72 hours**.
3. Submit a **final report no later than 14 days after a corrective measure is available**.

### Severe incidents

Severe incidents that affect product security use the same early path: an early warning within 24 hours and a notification within 72 hours. The final report is due within one month of that 72-hour notification.

### Where the report goes

Manufacturers submit **once** through ENISA's CRA Single Reporting Platform. The notification is addressed to the CSIRT of the manufacturer's main establishment and, unless a particularly exceptional case applies, is made available to ENISA at the same time. That CSIRT shares it with the CSIRTs of the Member States where the product has been made available, subject to the Commission's rules on delaying that sharing.

**TODO (owner): record the main establishment, the CSIRT that receives the notification, and the person who can file on the Single Reporting Platform.**

Until those contacts exist, a report to `security@<domain>` is only an internal placeholder. It does not notify a CSIRT or ENISA.

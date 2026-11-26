---
title: Incident Response Policy
summary: How security incidents are classified, contained, fixed and disclosed.
---
A security incident is any event that could let someone run code through Lima, bypass its approvals, tamper with its updates, or expose shared data. Liam Hosfeld owns the response and can be reached at lima.issues@gmail.com.

| Severity | Examples | Respond within | Fix shipped within |
| --- | --- | --- | --- |
| Critical | Update signing key or Developer ID exposed; a malicious update; remote code execution through a page or agent | 1 hour | 24 hours, as a critical update |
| High | Approval bypass; workspace isolation broken | 4 hours | 72 hours |
| Medium | Information leak needing user action; denial of service of the runtime | 2 business days | Next release |
| Low | Hardening gaps without a working exploit | 5 business days | When scheduled |

## Response steps
1. Record the report or alert, the time and the affected versions in a private incident log.
2. Triage: confirm it and set the severity.
3. Contain: for exposed signing material, revoke the Developer ID certificate with Apple, rotate the update key, pause the release workflow, and pull the affected release from the update feed.
4. Fix: ship the fix through the normal signed release, marked critical when the severity is Critical or High.
5. Notify: tell affected users through the release notes and this website, and notify regulators and individuals where the law requires (within 72 hours under the GDPR).
6. Review: within 14 days, write down the cause, what worked and what changes, then track those changes to done.

## Kept ready
Offline backups of the Developer ID certificate and the update key with their passwords, and hardware-key sign-in for GitHub, Google Cloud and Apple.

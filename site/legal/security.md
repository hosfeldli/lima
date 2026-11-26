---
title: Vulnerability Disclosure Policy
summary: How to report a security issue, what's in scope, and how reports are handled.
---
Report security issues in Lima to lima.issues@gmail.com, or privately through GitHub's security advisories for github.com/hosfeldli/lima. We acknowledge reports within 3 business days and won't pursue legal action against good-faith research that follows this policy.

## In scope
- The Lima app and its runtime (lima-host), including the browser-to-runtime bridge, the MCP tools, approval cards and workspace isolation.
- The updater: feed signatures, code-signature checks and the install process.
- lima.liamhosfeld.com, including shared note links.
- Any way an agent or a web page could act without the approval Lima's policy requires.

## Out of scope
Bugs in Firefox or Zen that Lima doesn't change (report them to Mozilla or Zen), your AI provider's services, social engineering, physical attacks, denial of service, and findings that need an already compromised Mac or root access.

## Rules for research
1. Test only on your own Mac and installations, with your own accounts and data.
2. Don't access, change or delete other people's data.
3. Don't degrade our services, and stop at the minimum needed to show the issue.
4. Keep details private until a fix is released or 90 days after your report, whichever comes first. We can agree on a different date together.

## What to send
The Lima version (Settings → Updates), steps to reproduce, the impact, and any proof of concept.

## What we do
Confirm the issue, keep you updated at least every 14 days, ship a fix (critical fixes go out as critical updates within days), and credit you in the release notes if you want. We don't currently offer bounties.

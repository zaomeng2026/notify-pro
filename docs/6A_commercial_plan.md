# 6A Commercial Plan

## 1. Align

- Goal: move from engineering demo to merchant-grade product.
- Target user: non-technical shop owner.
- Acceptance:
  - first pairing in under 3 minutes
  - no manual URL input on phone
  - auto recovery after restart

## 2. Architect

- Phone Auto.js -> LAN API -> local server -> display browser.
- Pairing module supports both:
  - legacy code-claim
  - QR approval + auto-claim

## 3. Atomize

Completed:
- QR session creation API
- QR approve API
- Auto-claim API
- Admin QR workflow with status polling
- Phone approval page
- Setup wizard page
- Auto.js auto-pair script template

Pending:
- Single-file exe packaging
- One-click installer with startup registration
- Optional cloud fleet management

## 4. Approve

Risks:
- Network isolation in some routers
- Firewall blocks on port 3180
- Missing token security in production

Mitigation:
- fixed LAN IP
- health endpoint checks
- token enabled by default for merchant delivery

## 5. Automate

SOP:
1. start service
2. set store profile in admin
3. generate QR and approve on phone
4. run Auto.js auto-pair script
5. open display in kiosk mode

## 6. Assess

Current state:
- function completeness: high
- merchant UX: improved
- deployment maturity: medium

Next priorities:
1. packaging to exe
2. startup + kiosk auto-launch
3. diagnostics page/tool

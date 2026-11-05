## Goal

Extend the webhook SSRF denylist to shared, reserved, NAT64 and 6to4 forms. Read IPv6 as its eight groups rather than matching it as text, so every spelling of an address is judged the same and all of fe80::/10 is covered.

## Files in scope

- apps/api/src/modules/notify/webhook.destination.ts
- apps/api/tests/modules/notify/webhook.destination.test.ts

---
---

The testing stage now accepts Kotlin unit tests for a card that changes only the Android app: it runs `:app:testDebugUnitTest` through the gradle wrapper, and skips (and logs) the checks that read the vitest report. No package is released by this change.

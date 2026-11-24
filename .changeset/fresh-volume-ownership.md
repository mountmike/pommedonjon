---
"pommedonjon": patch
---

The image's state and backup directories now belong to the user it runs as,
so the default named volume for run history is writable on first start.
Before, a fresh volume was owned by root and the app failed to start.

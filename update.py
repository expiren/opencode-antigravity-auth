import os
f = open('ARCHITECTURE.md', 'r', encoding='utf-8')
arch = f.read().replace('\r\n', '\n')
f.close()
arch = arch.replace('- Config schema is Zod-validated; environment variables always override file config', '- Config schema is Zod-validated; environment variables always override file config\n- Multi-Account load balancing supports proactive quota-aware rotation (Strategy 3) and cache-aware selection (Strategy 2) to prefer session-warm accounts\n- Connection warmup (Strategy 1) utilizes a lightweight streaming probe request upon account switches to prime server-side caches')

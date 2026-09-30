// Zod without its JIT (plan 00048 P4.2-fix, audit C15). Zod 4 compiles object parsers with
// `new Function` when it may, and finds out by trying `new Function("")` once. The web bundle's
// Content-Security-Policy (deploy/web/csp.sh) allows no eval, so that probe is refused and, although
// zod catches it, the browser reports a `securitypolicyviolation` for it. `jitless` skips the probe
// and the JIT (the interpreted parsers are the same rules). It must run before any schema is built:
// ./index.ts imports this module first, and every schema module of this repository depends on core.

import { z } from 'zod';

z.config({ jitless: true });

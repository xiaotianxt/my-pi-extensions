# Export verification

Checks run on the exported tree, not just the original installation:

- Root strict TypeScript check (six selected entry points): passed.
- Root deterministic Node tests: 47 passed.
- pi-memory synthetic Python tests: 15 passed.
- pi-btw deterministic Node tests: 13 passed.
- pi-gpt-search authentication tests: 3 passed.
- pi-bg-bash Node tests: 292 passed.
- pi-antigravity: all eight test scripts passed (mocked/offline requests).
- Gitleaks source scan, private-identifier/path scan and Git whitespace check performed before publication.

## Known limitations

**pi-tick's full copied test suite is not green:** 270 passed and 24 failed in the export check. The failing runner/transcript cases use executable shell-script Pi stubs, while the copied runner invokes `node <pi-path>`. Those fixtures fail with JavaScript syntax errors, cascading into transcript assertions. This snapshot preserves that runner behavior rather than silently rewriting it during a publication/privacy task. Do not treat this package as fully verified. No real scheduler jobs were installed to test it.

The root CI intentionally covers core extensions, pi-btw and pi-memory, not all nested packages. Orca and Herdr integration files were not tested in their live terminal applications. No paid model/API calls or real credentials were needed for deterministic checks.

Npm currently reports an upstream `node-domexception` deprecation in Pi's dependency tree during installation; no warning suppression or dependency override was added.

Packaging changes include portable test module resolution, synthetic model/command fixtures updated to the copied implementation, whitespace cleanup, and omission of local-only operational scripts/configuration. Original active installations were not modified.

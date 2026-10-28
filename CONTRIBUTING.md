# Contributing

Bug reports, documentation fixes, and focused code changes are welcome. For security issues use [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

Use the [Linux source-build instructions](README.md#build-from-source-on-linux). Root SDK dependencies can be prepared with `npm ci --ignore-scripts --legacy-peer-deps`; native host peers come from the fixed Linux runtime. Do not execute a copied Linux runtime on macOS.

```sh
npm test
python3 -m unittest discover -s test -p '*_test.py'
python3 scripts/license-inventory.py --check
python3 scripts/check-public-source.py --history
python3 scripts/check-doc-links.py
```

Linux bubblewrap integration uses `bwrap` on PATH, or `DSH_FEISHU_TEST_BWRAP` pointing to your verified binary. User-systemd tests also require a working user session. Tests report platform skips; a portable-only pass does not establish full Linux acceptance. Tests use synthetic data and require no live Feishu/model credentials.

## Scope and compatibility

Keep business identity, internal documents, and company-specific workflows in consumer projects. Preserve the extension contract and receipt/state semantics. Dependency changes must retain exact lockfiles and explain compatibility; do not casually re-resolve RC packages.

When changing copied/adapted code, retain its copyright/license and update source provenance. Run `python3 scripts/license-inventory.py` after a deliberate dependency-lock change, then review the resulting licenses. Generated dependency folders and offline archives do not belong in Git.

## Pull requests

Describe the concrete problem, resulting behavior, and relevant verification. Include focused regressions for meaningful behavior changes, avoid unrelated refactors, and distinguish automated checks from actual Feishu/model acceptance. Conventional Commit messages are preferred.

Submit only code you may contribute under this project's license; preserve any third-party terms and attribution. Do not include secrets, raw conversations, private endpoint configuration, or personal proxy settings. Maintainers may ask for a smaller reproduction or compatibility evidence.

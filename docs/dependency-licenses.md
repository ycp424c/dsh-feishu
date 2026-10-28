# Dependency license inventory

[dependency-licenses.json](dependency-licenses.json) is generated from the root SDK lockfile and the host runtime lockfile:

```sh
python3 scripts/license-inventory.py
python3 scripts/license-inventory.py --check
```

It preserves each package's exact version and declared license expression. Lockfiles contain optional packages for multiple operating systems; these are not all installed on a Linux host. Entries appearing in both dependency trees are recorded in both scopes.

The root SDK tree declares MIT, BSD-3-Clause, and Apache-2.0. The runtime also includes MPL-2.0 (LibreOffice-kit packages) and LGPL-3.0-or-later (libvips-related packages), along with combined expressions. Do not describe the entire distribution as exclusively MIT.

This inventory is traceability data, not a replacement for package copyright/NOTICE files or a statement that all redistribution obligations have been discharged. The source repository excludes installed dependencies and generated distributions. Before distributing a binary/offline bundle, review its actual installed set, preserve notices, and make required corresponding source available under each component's terms.

Upstream license copies and source references are in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Official context: [LibreOffice licensing](https://www.libreoffice.org/about-us/licenses/) and [sharp/libvips installation and licensing](https://sharp.pixelplumbing.com/install/).

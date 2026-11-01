# Development package snapshots

These archives are local build dependencies, not npm releases. `npm ci` installs
the exact bytes recorded in the lockfile, with no sibling checkout or private
repository credentials. `manifest.json` records source commits and SHA-256 hashes.
The runtime implementation remains owned by its source package.

Build SDK archives for a development consumer with:

```sh
npm run dev:pack -- --out /tmp/ziggs-packages
```

To refresh contracts too, add `--contracts <contracts-source-directory>` after
installing/building against those contracts. Copy the resulting `contracts.tgz`
and its manifest entry into this directory, then regenerate the root lockfile.
Consumers copy the needed archives into their own `vendor/ziggs` directory,
use `file:vendor/ziggs/<package>.tgz` dependencies and regenerate their lockfile.
Always validate a clean install after refreshing archives. No registry upload,
release tag or version publication is part of this development workflow.

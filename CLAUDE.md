# Working in this repo

This repo is public: the open-source packages. Our own agents, and every note about how we run them, stay in our private repo.

- Import a package by its name (`@ziggs-ai/agent-sdk`), not by a relative path into `src/`.
- Every file here is public, not only what ships to npm. Do not add internal notes, runbooks, maintainer docs, accounts of our own runs, private paths or links to our issue tracker anywhere in this repo. They go in the private repo.
- Files that ship in an npm tarball also carry no ticket ids.
- Prose (Markdown, plugin manifests, examples) has no em-dashes.
- `npm run check:published-surface` enforces these; it runs in `npm test`.
- The license is Apache-2.0.

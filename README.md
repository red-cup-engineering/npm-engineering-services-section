# npm services

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

- `services/npm-package-services-section` holds operations on an npm package.
- `services/npm-package-set-services-section` holds operations on finite package
  selections without implying workspace, dependency, registry, or ecosystem
  relations.
- `services/npm-package-set-services-section/services/npm-package-set-information-reading-service/scripts/read-npm-package-info.mjs`
  reads selected manifest fields across one or more directory trees.
- `services/npm-package-services-section/services/project-npm-package-lock-regeneration-command-service/scripts/project-npm-package-lock-regeneration-command.mjs`
  purely projects an explicit directory and execution policy to the exact
  shell-free command which regenerates `package-lock.json`.
- `services/npm-package-services-section/services/apply-npm-package-lock-regeneration-command-service/scripts/apply-npm-package-lock-regeneration-command.mjs`
  applies that command and returns its execution receipt.
